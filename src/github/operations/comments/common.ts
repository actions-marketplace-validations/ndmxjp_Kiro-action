import { GITHUB_SERVER_URL } from "../../api/config";

/** Text of the in-progress marker, before the indicator is appended. */
export const WORKING_TEXT = "Kiro is working…";

/**
 * Default indicator. An emoji rather than an image, because a URL baked into the
 * action would have to point at somebody's hosted asset. Workflows supply their
 * own with the `working_indicator` input — an animated one, for instance.
 */
export const DEFAULT_WORKING_INDICATOR = "⏳";

/**
 * Matches the marker so the final update can strip it, whatever indicator was
 * used — including one left by an earlier run with a different setting. A single
 * HTML tag or a short emoji may trail the text.
 */
export const WORKING_PATTERN =
  /Kiro is working[…\.]{1,3}(?:\s*(?:<[^>]*>|⏳))?/i;

/** The marker as it appears in the comment. */
export function workingMessage(indicator?: string): string {
  const trimmed = indicator?.trim();
  return `${WORKING_TEXT} ${trimmed || DEFAULT_WORKING_INDICATOR}`;
}

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
  indicator?: string,
): string {
  return `${workingMessage(indicator)}

I'll analyze this and get back to you.

${jobRunLink}${branchLink}`;
}
