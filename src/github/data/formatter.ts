import type {
  GitHubPullRequest,
  GitHubIssue,
  GitHubComment,
  GitHubFile,
  GitHubReview,
} from "../types";
import type { GitHubFileWithSHA } from "./fetcher";
import { sanitizeContent } from "../utils/sanitizer";

function formatLabels(labelNodes: Array<{ name: string }>): string {
  if (labelNodes.length === 0) return "none";
  return labelNodes.map((label) => label.name).join(", ");
}

export function formatContext(
  contextData: GitHubPullRequest | GitHubIssue,
  isPR: boolean,
): string {
  if (isPR) {
    const prData = contextData as GitHubPullRequest;
    return `PR Title: ${sanitizeContent(prData.title)}
PR Author: ${prData.author?.login ?? "ghost"}
PR Branch: ${prData.headRefName} -> ${prData.baseRefName}
PR State: ${prData.state}
PR Labels: ${formatLabels(prData.labels.nodes)}
PR Additions: ${prData.additions}
PR Deletions: ${prData.deletions}
Total Commits: ${prData.commits.totalCount}
Changed Files: ${prData.files ? `${prData.files.nodes.length} files` : "unknown (file list unavailable)"}`;
  }

  const issueData = contextData as GitHubIssue;
  return `Issue Title: ${sanitizeContent(issueData.title)}
Issue Author: ${issueData.author?.login ?? "ghost"}
Issue State: ${issueData.state}
Issue Labels: ${formatLabels(issueData.labels.nodes)}`;
}

export function formatBody(body: string): string {
  return sanitizeContent(body);
}

export function formatComments(comments: GitHubComment[]): string {
  return comments
    .filter((comment) => !comment.isMinimized)
    .map(
      (comment) =>
        `[${comment.author?.login ?? "ghost"} at ${comment.createdAt}]: ${sanitizeContent(comment.body)}`,
    )
    .join("\n\n");
}

export function formatReviewComments(
  reviewData: { nodes: GitHubReview[] } | null,
): string {
  if (!reviewData?.nodes) {
    return "";
  }

  const formattedReviews = reviewData.nodes.map((review) => {
    let reviewOutput = `[Review by ${review.author?.login ?? "ghost"} at ${review.submittedAt}]: ${review.state}`;

    if (review.body?.trim()) {
      reviewOutput += `\n${sanitizeContent(review.body)}`;
    }

    if (review.comments?.nodes?.length) {
      const comments = review.comments.nodes
        .filter((comment) => !comment.isMinimized)
        .map((comment) => {
          let formatted = `  [Comment on ${comment.path}:${comment.line || "?"}]: ${sanitizeContent(comment.body)}`;

          // The diff hunk is the code the comment was left on. Without it the
          // comment arrives without the context it was written against.
          if (comment.diffHunk) {
            formatted += `\n  Diff context:\n\`\`\`diff\n${sanitizeContent(comment.diffHunk)}\n\`\`\``;
          }

          return formatted;
        })
        .join("\n");
      if (comments) {
        reviewOutput += `\n${comments}`;
      }
    }

    return reviewOutput;
  });

  return formattedReviews.join("\n\n");
}

export function formatChangedFiles(changedFiles: GitHubFile[]): string {
  return changedFiles
    .map(
      (file) =>
        `- ${file.path} (${file.changeType}) +${file.additions}/-${file.deletions}`,
    )
    .join("\n");
}

export function formatChangedFilesWithSHA(
  changedFiles: GitHubFileWithSHA[],
): string {
  return changedFiles
    .map(
      (file) =>
        `- ${file.path} (${file.changeType}) +${file.additions}/-${file.deletions} SHA: ${file.sha}`,
    )
    .join("\n");
}
