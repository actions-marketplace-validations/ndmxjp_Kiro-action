import { mkdir, writeFile } from "fs/promises";
import { homedir } from "os";
import { join, resolve } from "path";
import { KIRO_AGENT_NAME } from "../github/constants";
import type { McpServers } from "../mcp/prepare-mcp-config";
import type { AutoDetectedMode } from "../modes/detector";

/**
 * Hardened push wrapper. The agent has no shell by default (see below), so this
 * is only reachable by a workflow that opts into `shell` via `allowed_tools`;
 * it is kept because `git push` with arbitrary arguments is remote code
 * execution (`git push --receive-pack='sh -c ...' ext::sh origin`).
 *
 * Normalized with resolve(): `GITHUB_ACTION_PATH` ends in `/.` when the action
 * is used as `uses: ./`, which would otherwise yield a doubled slash.
 */
export const GIT_PUSH_WRAPPER = resolve(
  process.env.GITHUB_ACTION_PATH || ".",
  "scripts/git-push.sh",
);

/**
 * Read-only built-ins. `fs_read` is the canonical CLI 2.x name; the CLI accepts
 * the `read` alias too, but the canonical names are what its own docs use.
 */
const READ_TOOLS = ["fs_read", "grep", "glob"];

/** File-editing built-ins. */
const WRITE_TOOLS = ["fs_write", "code"];

/**
 * The shell tool, deliberately not granted by default.
 *
 * Measured on kiro-cli 2.18.1 in `--no-interactive` mode (see
 * .github/workflows/kiro-perm-probe.yml):
 *
 *   - Only tools trusted wholesale run at all. Anything else is refused with
 *     "non-interactive mode (no user to approve)", because there is no one to
 *     prompt — this includes commands the interactive default policy allows,
 *     such as `git status`.
 *   - Trusting a tool *overrides* its `toolsSettings`. Trusting `execute_bash`
 *     with `allowedCommands: ["^git .*$"]` still ran `curl`, and the CLI says so:
 *     "You have trusted execute_bash tool, which overrides the toolsSettings".
 *
 * So headless shell access is all-or-nothing: there is no way to allow `git add`
 * without also allowing `curl`. Rather than hand the model an unrestricted
 * shell, this action gives it no shell and performs the commit and push itself
 * (src/git/commit.ts). A workflow can opt in with `allowed_tools: execute_bash`,
 * which is documented as unrestricted.
 */
const SHELL_TOOL = "execute_bash";

export type AgentEngine = "v2" | "v3";

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
  /**
   * Tools usable without approval. In headless mode this is the effective
   * capability list: a tool absent from here cannot run at all.
   */
  allowedTools: string[];
  /**
   * Whether to merge the MCP servers declared in `~/.kiro/settings/mcp.json` and
   * `.kiro/settings/mcp.json`.
   *
   * False on v2, where the servers in `mcpServers` above are honoured directly
   * and merging would also pull in the checkout's copy — attacker-controlled on
   * a pull request, and a way to have arbitrary commands started.
   *
   * True on v3, which ignores `mcpServers` in an agent profile entirely: there
   * the servers are written to the user-scoped mcp.json instead (see
   * src/kiro/mcp-json.ts). The checkout's copy is merged too, which is why
   * restore-config replaces `.kiro/` from the base branch on pull requests.
   */
  includeMcpJson: boolean;
  /**
   * Capability rules, honoured only by the v3 agent engine. On v2 they are
   * ignored, which is why `allowedTools` above carries the real policy there.
   */
  permissions?: { rules: PermissionRule[] };
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
  engine: AgentEngine;
  mcpServers: McpServers;
  /** Comma-separated extra tool names from the `allowed_tools` input. */
  extraTools: string;
  /** Comma-separated shell patterns from `allowed_shell_commands` (v3 only). */
  extraShellCommands: string;
  model: string;
  systemPrompt: string;
};

export function buildAgentConfig({
  mode,
  engine,
  mcpServers,
  extraTools,
  extraShellCommands,
  model,
  systemPrompt,
}: BuildAgentConfigParams): KiroAgentConfig {
  // `@server` grants every tool exposed by that MCP server. Verified on v2:
  // with `allowedTools: ["@probe"]` the server's tool was callable headlessly.
  const mcpToolNames = Object.keys(mcpServers).map((name) => `@${name}`);
  const extra = parseList(extraTools);
  const shellPatterns = parseList(extraShellCommands);

  // On v3, scoped shell is possible, so allowed_shell_commands can be honoured
  // and the shell tool is granted when the workflow asked for commands. On v2
  // there is no scoping, so the input cannot be honoured and shell is only
  // granted when explicitly named in allowed_tools.
  const grantShell = engine === "v3" && shellPatterns.length > 0;

  const granted = [
    ...READ_TOOLS,
    ...WRITE_TOOLS,
    ...mcpToolNames,
    ...(grantShell ? [SHELL_TOOL] : []),
    ...extra,
  ];

  return {
    name: KIRO_AGENT_NAME,
    description: `GitHub Actions agent (${mode} mode) created by kiro-action`,
    prompt: systemPrompt,
    mcpServers,
    // `tools` and `allowedTools` are the same list on purpose: on v2 a tool that
    // is available but not granted cannot run at all, so listing it separately
    // would only mislead the model into trying it.
    tools: dedupe(granted),
    allowedTools: dedupe(granted),
    includeMcpJson: engine === "v3",
    ...(engine === "v3"
      ? {
          permissions: {
            rules: buildV3Rules(shellPatterns, Object.keys(mcpServers)),
          },
        }
      : {}),
    ...(model ? { model } : {}),
  };
}

/**
 * Capability rules for the v3 engine, which — unlike v2 — enforces them.
 *
 * Measured on the v3 engine: `fs_write` scoped to `./**` blocked a write to
 * /tmp, a `shell` allow rule covered `git add`/`git commit` (neither is a v3
 * default), and a `shell` deny rule blocked `curl`, naming the agent profile as
 * its source.
 */
function buildV3Rules(
  shellPatterns: string[],
  mcpServerNames: string[],
): PermissionRule[] {
  const rules: PermissionRule[] = [
    { capability: "fs_read", effect: "allow" },
    // Confine writes to the checkout. Without this the agent could write to
    // $HOME, which is how it would reach its own permission files.
    { capability: "fs_write", match: ["./**"], effect: "allow" },
  ];

  // Only this action's own servers. Without the rule the tool call falls through
  // to an approval prompt, which is a denial in headless mode.
  if (mcpServerNames.length > 0) {
    rules.push({
      capability: "mcp",
      match: mcpServerNames.map((name) => `${name}/*`),
      effect: "allow",
    });
  }

  if (shellPatterns.length > 0) {
    rules.push({ capability: "shell", match: shellPatterns, effect: "allow" });
  }

  // Deny wins over allow in every scope, so these hold even if a workflow
  // allows a broad pattern such as "bash *".
  rules.push({
    capability: "shell",
    match: ["curl *", "wget *", "sudo *", "rm -rf *", "nc *", "ssh *"],
    effect: "deny",
  });

  return rules;
}

/** Whether the agent will end up with shell access, before the config is built. */
export function willGrantShell({
  engine,
  extraTools,
  extraShellCommands,
}: {
  engine: AgentEngine;
  extraTools: string;
  extraShellCommands: string;
}): boolean {
  if (
    parseList(extraTools).some(
      (tool) => tool === SHELL_TOOL || tool === "shell",
    )
  ) {
    return true;
  }
  return engine === "v3" && parseList(extraShellCommands).length > 0;
}

/** Whether a built config grants shell access. */
export function hasShellAccess(config: KiroAgentConfig): boolean {
  return config.allowedTools.some(
    (tool) => tool === SHELL_TOOL || tool === "shell",
  );
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}

/**
 * Writes the agent config where the CLI looks up global agents.
 *
 * Deliberately *not* written into the repository's `.kiro/agents/`: that
 * directory lives inside the checked-out (untrusted) working tree, and a file
 * there would also be swept up by the `git add -A` this action makes later.
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
