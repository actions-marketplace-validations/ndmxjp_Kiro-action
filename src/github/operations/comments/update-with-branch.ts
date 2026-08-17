/**
 * Add the branch link to the tracking comment once the branch has been created.
 */

import {
  createJobRunLink,
  createBranchLink,
  createCommentBody,
} from "./common";
import type { Octokits } from "../../api/client";
import {
  isPullRequestReviewCommentEvent,
  type ParsedGitHubContext,
} from "../../context";
import { updateKiroComment } from "./update-kiro-comment";

export async function updateTrackingComment(
  octokit: Octokits,
  context: ParsedGitHubContext,
  commentId: number,
  branch?: string,
) {
  const { owner, repo } = context.repository;

  const jobRunLink = createJobRunLink(owner, repo, context.runId);

  // Only issues get a branch link: on a PR the branch is already visible.
  let branchLink = "";
  if (branch && !context.isPR) {
    branchLink = createBranchLink(owner, repo, branch);
  }

  const updatedBody = createCommentBody(
    jobRunLink,
    branchLink,
    context.inputs.workingIndicator,
  );

  try {
    const isPRReviewComment = isPullRequestReviewCommentEvent(context);

    await updateKiroComment(octokit.rest, {
      owner,
      repo,
      commentId,
      body: updatedBody,
      isPullRequestReviewComment: isPRReviewComment,
    });

    console.log(
      `✅ Updated ${isPRReviewComment ? "PR review" : "issue"} comment ${commentId} with branch link`,
    );
  } catch (error) {
    console.error("Error updating comment with branch link:", error);
    throw error;
  }
}
