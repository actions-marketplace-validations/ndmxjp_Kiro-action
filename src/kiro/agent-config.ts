import { mkdir, writeFile } from "fs/promises";
import { homedir } from "os";
import { join, resolve } from "path";
import { KIRO_AGENT_NAME } from "../github/constants";
import type { McpServers } from "../mcp/prepare-mcp-config";
import type { AutoDetectedMode } from "../modes/detector";

/**
 * The hardened push wrapper the agent is allowed to run instead of `git push`.
 * See scripts/git-push.sh for why a bare `git push` allowance is unsafe.
 *
 * Normalized, because this exact string goes into a permission `match` pattern
 * and also into the prompt: the agent's command has to match it literally.
 * `GITHUB_ACTION_PATH` ends in `/.` when the action is used as `uses: ./`, which
 * would otherwise produce `<workspace>/.//scripts/git-push.sh` — a path the
 * shell resolves fine but which no longer matches what the model is likely to
 * type.
 */
export const GIT_PUSH_WRAPPER = resolve(
  process.env.GITHUB_ACTION_PATH || ".",
  "scripts/git-push.sh",
);

/** Read-only built-ins, safe to grant in every mode. */
const READ_TOOLS = ["read", "glob", "grep", "todo", "thinking", "report"];

/** File-editing built-ins. */
const WRITE_TOOLS = ["write", "code"];

/**
 * Shell commands the agent may run without approval. Everything else falls
 * through to a prompt, and a prompt in `--no-interactive` mode is a denial, so
 * this list is the effective shell allowlist.
 */
const DEFAULT_SHELL_ALLOW = [
  "git status",
  "git status *",
  "git diff",
  "git diff *",
  "git log",
  "git log *",
  "git show *",
  "git rev-parse *",
  "git ls-files",
  "git ls-files *",
  "git add *",
  "git commit *",
  "git rm *",
];

export type PermissionRule = {
  capability: string;
  match?: string[];
  effect: "allow" | "deny";
};

export type KiroAgentConfig = {
  name: string;
  description: string;
  prompt?: string;
  mcpServers: McpServers;
  tools: string[];
  allowedTools: string[];
  permissions: { rules: PermissionRule[] };
  /**
   * Never merge `.kiro/settings/mcp.json` from the checkout: on a pull request
   * that file is attacker-controlled and would let a PR add MCP servers, i.e.
   * arbitrary commands.
   */
  includeMcpJson: false;
  model?: string;
};

function parseList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export type BuildAgentConfigParams = {
  mode: AutoDetectedMode;
  mcpServers: McpServers;
  /** Comma-separated extra tool names from the `allowed_tools` input. */
  extraTools: string;
  /** Comma-separated extra shell patterns from the `allowed_shell_commands` input. */
  extraShellCommands: string;
  model: string;
  systemPrompt: string;
};

export function buildAgentConfig({
  mode,
  mcpServers,
  extraTools,
  extraShellCommands,
  model,
  systemPrompt,
}: BuildAgentConfigParams): KiroAgentConfig {
  // `@server` grants every tool exposed by that MCP server.
  const mcpToolNames = Object.keys(mcpServers).map((name) => `@${name}`);

  const tools = [
    ...READ_TOOLS,
    ...WRITE_TOOLS,
    "shell",
    ...mcpToolNames,
    ...parseList(extraTools),
  ];

  // `shell` is deliberately absent from allowedTools: individual commands are
  // granted through the permission rules below instead of trusting the whole
  // capability.
  const allowedTools = [
    ...READ_TOOLS,
    ...WRITE_TOOLS,
    ...mcpToolNames,
    ...parseList(extraTools),
  ];

  const shellAllow = [
    ...DEFAULT_SHELL_ALLOW,
    `${GIT_PUSH_WRAPPER} *`,
    ...parseList(extraShellCommands),
  ];

  const rules: PermissionRule[] = [
    { capability: "shell", match: shellAllow, effect: "allow" },
  ];

  return {
    name: KIRO_AGENT_NAME,
    description: `GitHub Actions agent (${mode} mode) created by kiro-action`,
    prompt: systemPrompt,
    mcpServers,
    tools: dedupe(tools),
    allowedTools: dedupe(allowedTools),
    permissions: { rules },
    includeMcpJson: false,
    ...(model ? { model } : {}),
  };
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}

/**
 * Writes the agent config where the CLI looks up global agents.
 *
 * Deliberately *not* written into the repository's `.kiro/agents/`: that
 * directory lives inside the checked-out (untrusted) working tree, and a file
 * there would also be picked up by a `git add -A` that Kiro makes later.
 */
export async function writeAgentConfig(
  config: KiroAgentConfig,
): Promise<string> {
  const agentDir = join(homedir(), ".kiro", "agents");
  await mkdir(agentDir, { recursive: true });

  const agentPath = join(agentDir, `${config.name}.json`);
  await writeFile(agentPath, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });

  console.log(`Wrote Kiro agent config to ${agentPath}`);
  return agentPath;
}
