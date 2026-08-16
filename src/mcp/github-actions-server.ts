#!/usr/bin/env bun

/**
 * MCP stdio server exposing read-only access to this PR's CI results, so Kiro
 * can diagnose failing checks without shelling out to `gh`.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { mkdir, writeFile } from "fs/promises";
import { Octokit } from "@octokit/rest";
import { GITHUB_API_URL } from "../github/api/config";
import {
  listWorkflowJobs,
  listWorkflowRuns,
} from "./github-actions-pagination";

const REPO_OWNER = process.env.REPO_OWNER;
const REPO_NAME = process.env.REPO_NAME;
const PR_NUMBER = process.env.PR_NUMBER;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const RUNNER_TEMP = process.env.RUNNER_TEMP || "/tmp";

if (!REPO_OWNER || !REPO_NAME || !PR_NUMBER || !GITHUB_TOKEN) {
  console.error(
    "[GitHub CI Server] Error: REPO_OWNER, REPO_NAME, PR_NUMBER, and GITHUB_TOKEN environment variables are required",
  );
  process.exit(1);
}

function client(): Octokit {
  return new Octokit({ auth: GITHUB_TOKEN, baseUrl: GITHUB_API_URL });
}

function errorResult(error: unknown) {
  const errorMessage = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text" as const, text: `Error: ${errorMessage}` }],
    error: errorMessage,
    isError: true,
  };
}

function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

const server = new McpServer({
  name: "GitHub CI Server",
  version: "0.0.1",
});

server.tool(
  "get_ci_status",
  "Get a CI status summary for this pull request",
  {
    status: z
      .enum([
        "completed",
        "action_required",
        "cancelled",
        "failure",
        "neutral",
        "skipped",
        "stale",
        "success",
        "timed_out",
        "in_progress",
        "queued",
        "requested",
        "waiting",
        "pending",
      ])
      .optional()
      .describe("Filter workflow runs by status"),
  },
  async ({ status }) => {
    try {
      const octokit = client();

      const { data: prData } = await octokit.pulls.get({
        owner: REPO_OWNER!,
        repo: REPO_NAME!,
        pull_number: parseInt(PR_NUMBER!, 10),
      });

      const runs = await listWorkflowRuns(octokit, {
        owner: REPO_OWNER!,
        repo: REPO_NAME!,
        head_sha: prData.head.sha,
        ...(status && { status }),
      });

      const summary = {
        total_runs: runs.length,
        failed: 0,
        passed: 0,
        pending: 0,
      };

      const processedRuns = runs.map((run) => {
        if (run.status === "completed") {
          if (run.conclusion === "success") {
            summary.passed++;
          } else if (run.conclusion === "failure") {
            summary.failed++;
          }
        } else {
          summary.pending++;
        }

        return {
          id: run.id,
          name: run.name,
          status: run.status,
          conclusion: run.conclusion,
          html_url: run.html_url,
          created_at: run.created_at,
        };
      });

      return jsonResult({ summary, runs: processedRuns });
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.tool(
  "get_workflow_run_details",
  "Get job and step details for a workflow run, including which steps failed",
  {
    run_id: z.number().describe("The workflow run ID"),
  },
  async ({ run_id }) => {
    try {
      const jobs = await listWorkflowJobs(client(), {
        owner: REPO_OWNER!,
        repo: REPO_NAME!,
        run_id,
      });

      const processedJobs = jobs.map((job) => ({
        id: job.id,
        name: job.name,
        conclusion: job.conclusion,
        html_url: job.html_url,
        failed_steps: (job.steps || [])
          .filter((step) => step.conclusion === "failure")
          .map((step) => ({ name: step.name, number: step.number })),
      }));

      return jsonResult({ jobs: processedJobs });
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.tool(
  "download_job_log",
  "Download a job's logs to disk and return the path, so they can be read with the read tool",
  {
    job_id: z.number().describe("The job ID"),
  },
  async ({ job_id }) => {
    try {
      const response = await client().actions.downloadJobLogsForWorkflowRun({
        owner: REPO_OWNER!,
        repo: REPO_NAME!,
        job_id,
      });

      const logsText = response.data as unknown as string;

      const logsDir = `${RUNNER_TEMP}/github-ci-logs`;
      await mkdir(logsDir, { recursive: true });

      const logPath = `${logsDir}/job-${job_id}.log`;
      await writeFile(logPath, logsText, "utf-8");

      return jsonResult({
        path: logPath,
        size_bytes: Buffer.byteLength(logsText, "utf-8"),
      });
    } catch (error) {
      return errorResult(error);
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
