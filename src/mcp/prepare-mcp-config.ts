import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";
import { GITHUB_API_URL } from "../github/api/config";
import { isEntityContext, type GitHubContext } from "../github/context";
import type { AutoDetectedMode } from "../modes/detector";

export type McpServerConfig = {
  command: string;
  args: string[];
  env?: Record<string, string>;
};

export type McpServers = Record<string, McpServerConfig>;

type PrepareConfigParams = {
  githubToken: string;
  owner: string;
  repo: string;
  kiroCommentId?: string;
  mode: AutoDetectedMode;
  context: GitHubContext;
};

/**
 * Path to one of this action's own bundled MCP servers.
 *
 * The servers ship as separate bundles because the Kiro CLI starts them as
 * processes of their own, by command line. Running them from dist/ under the
 * runner's Node means a server needs no dependency install either, and — unlike
 * the Bun invocation this replaced — nothing reads configuration out of the
 * working directory, which is attacker-controlled on a pull request.
 */
function serverScript(name: string): string {
  return `${process.env.GITHUB_ACTION_PATH}/dist/mcp/${name}.mjs`;
}

async function checkActionsReadPermission(
  token: string,
  owner: string,
  repo: string,
): Promise<boolean> {
  try {
    const client = new Octokit({ auth: token, baseUrl: GITHUB_API_URL });

    // Listing workflow runs requires `actions: read`; per_page=1 keeps it cheap.
    await client.actions.listWorkflowRunsForRepo({ owner, repo, per_page: 1 });

    return true;
  } catch (error) {
    const status = (error as { status?: number }).status;
    const message = (error as { message?: string }).message;

    if (status === 403 && message?.includes("Resource not accessible")) {
      return false;
    }

    // Network or other transient errors: log, but treat the server as
    // unavailable rather than failing the run.
    core.debug(`Failed to check actions permission: ${message}`);
    return false;
  }
}

/**
 * Assembles the MCP servers this action provides. Unlike the upstream Claude
 * action there is no `--mcp-config` flag on the Kiro CLI, so the result is
 * embedded in the generated agent config (see src/kiro/agent-config.ts).
 */
export async function prepareMcpServers(
  params: PrepareConfigParams,
): Promise<McpServers> {
  const { githubToken, owner, repo, kiroCommentId, mode, context } = params;

  const servers: McpServers = {};

  // The comment server is what makes progress visible, so it is installed
  // whenever there is a tracking comment to update (tag mode).
  if (kiroCommentId) {
    servers.github_comment = {
      command: "node",
      args: [serverScript("github-comment-server")],
      env: {
        GITHUB_TOKEN: githubToken,
        REPO_OWNER: owner,
        REPO_NAME: repo,
        KIRO_COMMENT_ID: kiroCommentId,
        GITHUB_EVENT_NAME: process.env.GITHUB_EVENT_NAME || "",
        GITHUB_API_URL,
      },
    };
  }

  // The CI server needs `actions: read`, which the workflow token carries only
  // when the workflow asks for it. It is only useful on a pull request.
  const workflowToken = process.env.DEFAULT_WORKFLOW_TOKEN;
  const wantsCiServer =
    mode === "tag" && isEntityContext(context) && context.isPR;

  if (wantsCiServer && workflowToken) {
    if (await checkActionsReadPermission(workflowToken, owner, repo)) {
      servers.github_ci = {
        command: "node",
        args: [serverScript("github-actions-server")],
        env: {
          // Deliberately the workflow token, not an app token: this is the
          // identity whose `actions: read` scope was just verified.
          GITHUB_TOKEN: workflowToken,
          REPO_OWNER: owner,
          REPO_NAME: repo,
          PR_NUMBER: context.entityNumber?.toString() || "",
          RUNNER_TEMP: process.env.RUNNER_TEMP || "/tmp",
        },
      };
    } else {
      core.warning(
        "The github_ci MCP server requires 'actions: read' permission. " +
          "Skipping it. To enable CI status checks, add 'actions: read' to your workflow permissions. " +
          "See: https://docs.github.com/en/actions/security-guides/automatic-token-authentication#permissions-for-the-github_token",
      );
    }
  }

  return servers;
}
