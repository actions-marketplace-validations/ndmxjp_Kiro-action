import { GITHUB_SERVER_URL } from "../../api/config";

/** Marker shown while the run is in progress. */
export const WORKING_MESSAGE = "Kiro is working… ⏳";

/** Matches the working marker so it can be stripped on the final update. */
export const WORKING_PATTERN =
  /Kiro is working[…\.]{1,3}(?:\s*(?:<img[^>]*>|⏳))?/i;

export function createJobRunLink(
  owner: string,
  repo: string,
  runId: string,
): string {
  return `[View job run](${GITHUB_SERVER_URL}/${owner}/${repo}/actions/runs/${runId})`;
}

export function createBranchLink(
  owner: string,
  repo: string,
  branchName: string,
): string {
  return `\n[View branch](${GITHUB_SERVER_URL}/${owner}/${repo}/tree/${branchName})`;
}

export function createCommentBody(
  jobRunLink: string,
  branchLink: string = "",
): string {
  return `${WORKING_MESSAGE}

I'll analyze this and get back to you.

${jobRunLink}${branchLink}`;
}
