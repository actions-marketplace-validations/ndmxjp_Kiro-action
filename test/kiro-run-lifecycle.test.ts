import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runKiro } from "../src/kiro/run";

/**
 * Exercises the process lifecycle with a stand-in for the CLI, because the two
 * bugs these cover only appear with a real child process:
 *
 *  - the v3 engine finishes its answer and then never exits, so the action has
 *    to decide the run is over on its own;
 *  - it starts a KAS server as a grandchild, so signalling only the CLI leaves
 *    the pipes open and the action waits forever.
 *
 * The fake writes some output, then leaves a background child holding stdout
 * while the "CLI" itself keeps running — the same shape as the real thing.
 */
function fakeCli(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "kiro-run-test-"));
  const path = join(dir, "fake-cli.sh");
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
  return path;
}

function paths() {
  const dir = mkdtempSync(join(tmpdir(), "kiro-run-io-"));
  return {
    promptFile: join(dir, "prompt.txt"),
    outputFile: join(dir, "output.txt"),
  };
}

const base = {
  agentName: "kiro-action",
  engine: "v3" as const,
  prompt: "do the thing",
  effort: "",
  requireMcpStartup: false,
  trustAllTools: false,
  extraArgs: [],
};

describe("runKiro lifecycle", () => {
  test("exits normally when the CLI exits normally", async () => {
    const { promptFile, outputFile } = paths();
    const result = await runKiro({
      ...base,
      kiroCommand: fakeCli('echo "all done"; exit 0'),
      promptFile,
      outputFile,
      idleTimeoutSeconds: 30,
    });

    expect(result.exitCode).toBe(0);
    expect(result.reason).toBe("success");
    expect(readFileSync(outputFile, "utf8")).toContain("all done");
  });

  test("reports a failing exit code", async () => {
    const { promptFile, outputFile } = paths();
    const result = await runKiro({
      ...base,
      kiroCommand: fakeCli('echo "broken"; exit 1'),
      promptFile,
      outputFile,
    });

    expect(result.exitCode).toBe(1);
    expect(result.reason).toBe("failure");
  });

  test("maps exit code 3 to an MCP startup failure", async () => {
    const { promptFile, outputFile } = paths();
    const result = await runKiro({
      ...base,
      kiroCommand: fakeCli("exit 3"),
      promptFile,
      outputFile,
    });

    expect(result.reason).toBe("mcp_startup_failure");
  });

  test("shuts down a CLI that answers and then hangs, and calls it a success", async () => {
    const { promptFile, outputFile } = paths();
    const startedAt = Date.now();

    const result = await runKiro({
      ...base,
      // Answers, then hangs forever — the measured v3 behaviour.
      kiroCommand: fakeCli('echo "the answer"; sleep 600'),
      promptFile,
      outputFile,
      idleTimeoutSeconds: 2,
    });

    expect(Date.now() - startedAt).toBeLessThan(30_000);
    expect(result.reason).toBe("success");
    expect(result.timedOut).toBe(false);

    const output = readFileSync(outputFile, "utf8");
    expect(output).toContain("the answer");
    expect(output).toContain("does not exit on its own");
  });

  test("returns even when a grandchild keeps the pipes open", async () => {
    const { promptFile, outputFile } = paths();
    const startedAt = Date.now();

    const result = await runKiro({
      ...base,
      // A background child inherits stdout and outlives the parent's own work,
      // which is what keeps "close" from ever firing.
      kiroCommand: fakeCli('sleep 600 & echo "the answer"; sleep 600'),
      promptFile,
      outputFile,
      idleTimeoutSeconds: 2,
    });

    expect(Date.now() - startedAt).toBeLessThan(30_000);
    expect(result.reason).toBe("success");
    expect(readFileSync(outputFile, "utf8")).toContain("the answer");
  });

  test("reports a timeout as a failure, not as a quiet success", async () => {
    const { promptFile, outputFile } = paths();

    const result = await runKiro({
      ...base,
      // Never goes quiet, so only the hard timeout can end it.
      kiroCommand: fakeCli("while true; do echo tick; sleep 1; done"),
      promptFile,
      outputFile,
      timeoutMinutes: 3 / 60,
      idleTimeoutSeconds: 30,
    });

    expect(result.timedOut).toBe(true);
    expect(result.reason).not.toBe("success");
    expect(readFileSync(outputFile, "utf8")).toContain("timeout");
  }, 30_000);
});
