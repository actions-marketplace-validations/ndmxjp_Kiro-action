import { mkdir, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import type { McpServers } from "../mcp/prepare-mcp-config";

/**
 * Writes the MCP servers to the user-scoped config the CLI reads at startup.
 *
 * This exists because the v3 agent engine ignores `mcpServers` declared inside
 * an agent profile. Measured on `kiro-cli 2.18.1 --v3`: with the server inline
 * in the profile the model could not see the tool at all, and with the identical
 * server in `~/.kiro/settings/mcp.json` plus `includeMcpJson: true` it saw
 * `mcp_probe_echo_probe` and called it successfully. The closest upstream
 * reports are kirodotdev/Kiro#7349 (inline servers ignored over ACP, closed) and
 * #7425 (servers not loaded in 2.0.0's default mode).
 *
 * The user scope is used rather than the workspace one on purpose: `.kiro/` in
 * the checkout is attacker-controlled on a pull request.
 */
export async function writeUserMcpJson(servers: McpServers): Promise<string> {
  const settingsDir = join(homedir(), ".kiro", "settings");
  await mkdir(settingsDir, { recursive: true });

  const mcpPath = join(settingsDir, "mcp.json");
  await writeFile(
    mcpPath,
    `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`,
    {
      // The file carries the GitHub token in server env, so keep it owner-only.
      mode: 0o600,
    },
  );

  console.log(`Wrote MCP server config to ${mcpPath}`);
  return mcpPath;
}
