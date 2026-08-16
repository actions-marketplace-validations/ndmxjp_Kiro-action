#!/usr/bin/env bun

/**
 * MCP stdio server exposing a single tool that lets Kiro rewrite the tracking
 * comment as it works. This is how progress reaches the reader of the issue/PR:
 * the CLI has no streaming-JSON output to relay.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Octokit } from "@octokit/rest";
import { GITHUB_API_URL } from "../github/api/config";
import { updateKiroComment } from "../github/operations/comments/update-kiro-comment";
import { sanitizeContent } from "../github/utils/sanitizer";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO_OWNER = process.env.REPO_OWNER;
const REPO_NAME = process.env.REPO_NAME;
const KIRO_COMMENT_ID = process.env.KIRO_COMMENT_ID;
const GITHUB_EVENT_NAME = process.env.GITHUB_EVENT_NAME;

if (!GITHUB_TOKEN || !REPO_OWNER || !REPO_NAME || !KIRO_COMMENT_ID) {
  console.error(
    "[GitHub Comment Server] Error: GITHUB_TOKEN, REPO_OWNER, REPO_NAME, and KIRO_COMMENT_ID environment variables are required",
  );
  process.exit(1);
}

const server = new McpServer({
  name: "GitHub Comment Server",
  version: "0.0.1",
});

server.tool(
  "update_kiro_comment",
  "Replace the body of the tracking comment on this issue or pull request. Use it to report progress and to post your final answer.",
  {
    body: z.string().describe("The new comment body (GitHub Markdown)"),
  },
  async ({ body }) => {
    try {
      const octokit = new Octokit({
        auth: GITHUB_TOKEN,
        baseUrl: GITHUB_API_URL,
      });

      const result = await updateKiroComment(octokit, {
        owner: REPO_OWNER!,
        repo: REPO_NAME!,
        commentId: parseInt(KIRO_COMMENT_ID!, 10),
        // The body is model-authored but may quote untrusted repository or
        // comment content, so run it through the same sanitizer used on input.
        body: sanitizeContent(body),
        isPullRequestReviewComment:
          GITHUB_EVENT_NAME === "pull_request_review_comment",
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Error: ${errorMessage}` }],
        error: errorMessage,
        isError: true,
      };
    }
  },
);

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.on("exit", () => {
    server.close();
  });
}

runServer().catch(() => {
  process.exit(1);
});
