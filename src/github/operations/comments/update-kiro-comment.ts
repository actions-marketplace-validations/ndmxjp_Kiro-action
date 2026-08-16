import type { Octokit } from "@octokit/rest";

export type UpdateKiroCommentParams = {
  owner: string;
  repo: string;
  commentId: number;
  body: string;
  isPullRequestReviewComment: boolean;
};

export type UpdateKiroCommentResult = {
  id: number;
  html_url: string;
  updated_at: string;
};

/**
 * Updates the tracking comment, which is either a normal issue/PR comment or a
 * PR review comment depending on what triggered the run.
 */
export async function updateKiroComment(
  octokit: Octokit,
  params: UpdateKiroCommentParams,
): Promise<UpdateKiroCommentResult> {
  const { owner, repo, commentId, body, isPullRequestReviewComment } = params;

  let response;

  try {
    if (isPullRequestReviewComment) {
      response = await octokit.rest.pulls.updateReviewComment({
        owner,
        repo,
        comment_id: commentId,
        body,
      });
    } else {
      // The issue comment API covers both issues and general PR comments.
      response = await octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: commentId,
        body,
      });
    }
  } catch (error) {
    // A review-comment update 404s when the initial comment fell back to a
    // plain issue comment; retry against that API.
    if (
      isPullRequestReviewComment &&
      (error as { status?: number }).status === 404
    ) {
      response = await octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: commentId,
        body,
      });
    } else {
      throw error;
    }
  }

  return {
    id: response.data.id,
    html_url: response.data.html_url,
    updated_at: response.data.updated_at,
  };
}
