import * as core from "@actions/core";
import { spawn } from "child_process";
import { mkdir, writeFile } from "fs/promises";
import { dirname } from "path";
import { redactAllSecrets } from "../github/utils/sanitizer";

/**
 * Per-argument size limit on Linux (MAX_ARG_STRLEN, 32 pages). A prompt built
 * from a large PR can exceed it, so anything close to the limit is handed over
 * as a file instead of as an argv element.
 */
const MAX_INLINE_PROMPT_BYTES = 96 * 1024;

/** Cap on how much CLI output is retained for the execution log. */
const MAX_CAPTURED_BYTES = 8 * 1024 * 1024;

/**
 * CSI and OSC escape sequences, plus the single-character escapes the CLI's
 * progress rendering emits (cursor hide/show, colour resets).
 */
const ANSI_PATTERN =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d\/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;

/**
 * Removes terminal control sequences from captured output.
 *
 * `NO_COLOR`, `KIRO_LOG_NO_COLOR`, and `TERM=dumb` are all set for the child
 * process, and the CLI still emits colour and cursor-control sequences (verified
 * on a real run: 59 escape bytes in a 958-byte log). They make the execution
 * file and the job summary hard to read, so strip them at capture time.
 */
export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}

export type KiroExitReason = "success" | "failure" | "mcp_startup_failure";

export type KiroRunResult = {
  exitCode: number;
  reason: KiroExitReason;
  /** Path to the captured, redacted CLI output. */
  outputFile: string;
  durationMs: number;
  timedOut: boolean;
};

export type RunKiroParams = {
  kiroCommand: string;
  agentName: string;
  /** "v3" adds --v3, selecting the KAS agent engine. */
  engine: "v2" | "v3";
  prompt: string;
  promptFile: string;
  outputFile: string;
  effort: string;
  requireMcpStartup: boolean;
  trustAllTools: boolean;
  extraArgs: string[];
  timeoutMinutes?: number;
};

export async function runKiro(params: RunKiroParams): Promise<KiroRunResult> {
  const {
    kiroCommand,
    agentName,
    engine,
    prompt,
    promptFile,
    outputFile,
    effort,
    requireMcpStartup,
    trustAllTools,
    extraArgs,
    timeoutMinutes,
  } = params;

  const message = await resolvePromptArgument(prompt, promptFile);

  const args = [
    "chat",
    "--no-interactive",
    ...(engine === "v3" ? ["--v3"] : []),
    "--agent",
    agentName,
    ...(requireMcpStartup ? ["--require-mcp-startup"] : []),
    ...(effort ? ["--effort", effort] : []),
    ...(trustAllTools ? ["--trust-all-tools"] : []),
    ...extraArgs,
    message,
  ];

  core.info(
    `Running: ${kiroCommand} ${args
      .slice(0, args.length - 1)
      .join(" ")} <prompt>`,
  );

  const startedAt = Date.now();

  // No shell: the prompt and every argument are passed straight to the binary,
  // so nothing in them can be reinterpreted as a shell command.
  const child = spawn(kiroCommand, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  const captured: Buffer[] = [];
  let capturedBytes = 0;
  let truncated = false;

  const capture = (chunk: Buffer) => {
    if (capturedBytes < MAX_CAPTURED_BYTES) {
      captured.push(chunk);
      capturedBytes += chunk.byteLength;
    } else if (!truncated) {
      truncated = true;
    }
  };

  child.stdout.on("data", (chunk: Buffer) => {
    capture(chunk);
    process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    capture(chunk);
    process.stderr.write(chunk);
  });

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;

  if (timeoutMinutes && timeoutMinutes > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      core.warning(
        `Kiro CLI exceeded the ${timeoutMinutes} minute timeout; terminating it`,
      );
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    }, timeoutMinutes * 60_000);
  }

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      // A signal death reports code === null; surface it as a failure.
      resolve(code ?? (signal ? 1 : 0));
    });
  }).finally(() => {
    if (timer) clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
  });

  const durationMs = Date.now() - startedAt;

  let output = Buffer.concat(captured).toString("utf8");
  if (truncated) {
    output += "\n[output truncated by kiro-action: size limit reached]\n";
  }
  if (timedOut) {
    output += `\n[kiro-action: terminated after the ${timeoutMinutes} minute timeout]\n`;
  }

  await mkdir(dirname(outputFile), { recursive: true });
  // The log is written to disk and surfaced in the step summary, neither of
  // which is covered by GitHub's log masking, so redact before persisting.
  // Escape sequences are stripped as well: they survive NO_COLOR and make both
  // the file and the summary unreadable.
  await writeFile(outputFile, redactAllSecrets(stripAnsi(output)), "utf8");

  return {
    exitCode,
    reason: exitReason(exitCode),
    outputFile,
    durationMs,
    timedOut,
  };
}

/**
 * Kiro CLI exit codes: 0 success, 1 failure, 3 MCP server startup failure
 * (only reported when `--require-mcp-startup` is passed).
 */
function exitReason(exitCode: number): KiroExitReason {
  if (exitCode === 0) return "success";
  if (exitCode === 3) return "mcp_startup_failure";
  return "failure";
}

/**
 * Returns the message to pass on the command line. Large prompts are written to
 * a file and replaced with an instruction to read it, since a single argument
 * cannot exceed MAX_ARG_STRLEN.
 */
async function resolvePromptArgument(
  prompt: string,
  promptFile: string,
): Promise<string> {
  await mkdir(dirname(promptFile), { recursive: true });
  await writeFile(promptFile, prompt, "utf8");

  if (Buffer.byteLength(prompt, "utf8") <= MAX_INLINE_PROMPT_BYTES) {
    return prompt;
  }

  core.info(
    `Prompt is larger than ${MAX_INLINE_PROMPT_BYTES} bytes; passing it as a file (${promptFile})`,
  );
  return `Your instructions for this run are in the file ${promptFile}. Read that file first with the read tool, then carry out exactly what it says.`;
}
