import { execFileSync } from "child_process";
import type { IssuesEvent } from "@octokit/webhooks-types";
import type { Octokits } from "../api/client";
import { ISSUE_QUERY, PR_QUERY, USER_QUERY } from "../api/queries/github";
import {
  isIssueCommentEvent,
  isIssuesEvent,
  isPullRequestEvent,
  isPullRequestReviewEvent,
  isPullRequestReviewCommentEvent,
  type ParsedGitHubContext,
} from "../context";
import type {
  GitHubComment,
  GitHubFile,
  GitHubIssue,
  GitHubPullRequest,
  GitHubReview,
  IssueQueryResponse,
  PullRequestQueryResponse,
} from "../types";
import {
  parseActorFilter,
  shouldIncludeCommentByActor,
} from "../utils/actor-filter";

/**
 * Extracts the trigger timestamp from the GitHub webhook payload.
 * This timestamp represents when the triggering comment/review/event was created.
 *
 * For `issues` and `pull_request` events there is no dedicated trigger object in
 * the payload, so the issue/PR's own timestamps from the webhook snapshot are
 * used: `created_at` for opened events, otherwise `updated_at` (falling back to
 * `created_at`). For issues labeled/assigned events, prefer
 * resolveTriggerTimestamp(), which looks up the exact event time.
 */
export function extractTriggerTimestamp(
  context: ParsedGitHubContext,
): string | undefined {
  if (isIssueCommentEvent(context)) {
    return context.payload.comment.created_at || undefined;
  } else if (isPullRequestReviewEvent(context)) {
    return context.payload.review.submitted_at || undefined;
  } else if (isPullRequestReviewCommentEvent(context)) {
    return context.payload.comment.created_at || undefined;
  } else if (isIssuesEvent(context)) {
    const issue = context.payload.issue;
    if (context.eventAction === "opened") {
      return issue?.created_at || issue?.updated_at || undefined;
    }
    // updated_at reflects the last comment or edit on the issue, so the newest
    // pre-existing comment can share this timestamp and be excluded along with
    // anything newer.
    return issue?.updated_at || issue?.created_at || undefined;
  } else if (isPullRequestEvent(context)) {
    const pullRequest = context.payload.pull_request;
    if (context.eventAction === "opened") {
      return pullRequest?.created_at || pullRequest?.updated_at || undefined;
    }
    return pullRequest?.updated_at || pullRequest?.created_at || undefined;
  }

  return undefined;
}

/**
 * Resolves the trigger timestamp for the event, consulting the GitHub API where
 * the webhook payload does not carry an exact time for the triggering action.
 *
 * For issues labeled/assigned events the label/assignment carries no timestamp
 * of its own in the payload, so the matching entry in the issue's event history
 * is looked up and its `created_at` is used. If the lookup fails, this falls
 * back to extractTriggerTimestamp().
 */
export async function resolveTriggerTimestamp(
  context: ParsedGitHubContext,
  octokits: Octokits,
): Promise<string | undefined> {
  if (
    isIssuesEvent(context) &&
    (context.eventAction === "labeled" || context.eventAction === "assigned")
  ) {
    const eventTime = await findIssueEventTime(context, octokits);
    if (eventTime) {
      return eventTime;
    }
    console.warn(
      `Could not resolve the ${context.eventAction} event time for issue #${context.entityNumber}; falling back to the webhook payload timestamps`,
    );
  }

  return extractTriggerTimestamp(context);
}

/**
 * Looks up the most recent labeled/assigned event on the issue that matches the
 * label or assignee in the webhook payload, returning its created_at.
 */
async function findIssueEventTime(
  context: ParsedGitHubContext & { payload: IssuesEvent },
  octokits: Octokits,
): Promise<string | undefined> {
  const payload = context.payload;
  let matches: (event: {
    event: string;
    label?: { name?: string | null };
    assignee?: { login?: string } | null;
  }) => boolean;

  if (payload.action === "labeled") {
    const labelName = payload.label?.name;
    if (!labelName) return undefined;
    matches = (event) =>
      event.event === "labeled" && event.label?.name === labelName;
  } else if (payload.action === "assigned") {
    const assigneeLogin = payload.assignee?.login;
    if (!assigneeLogin) return undefined;
    matches = (event) =>
      event.event === "assigned" && event.assignee?.login === assigneeLogin;
  } else {
    return undefined;
  }

  try {
    const events = await octokits.rest.paginate(
      octokits.rest.issues.listEvents,
      {
        owner: context.repository.owner,
        repo: context.repository.repo,
        issue_number: context.entityNumber,
        per_page: 100,
      },
    );

    let latest: (typeof events)[number] | undefined;
    for (const event of events.filter(matches)) {
      if (
        !latest ||
        new Date(event.created_at).getTime() >
          new Date(latest.created_at).getTime()
      ) {
        latest = event;
      }
    }

    // Labeling/assignment does not bump the issue's updated_at, so the event
    // that fired this webhook cannot predate the payload snapshot's updated_at.
    // An older match means the current event is not visible in the events API
    // yet; ignore it rather than adopt a stale boundary.
    const snapshotUpdatedAt = payload.issue?.updated_at;
    if (
      latest &&
      snapshotUpdatedAt &&
      new Date(latest.created_at).getTime() <
        new Date(snapshotUpdatedAt).getTime()
    ) {
      console.warn(
        `Latest matching ${payload.action} event on issue #${context.entityNumber} predates the issue's updated_at; treating it as stale`,
      );
      return undefined;
    }

    return latest?.created_at || undefined;
  } catch (error) {
    console.warn(
      `Failed to fetch events for issue #${context.entityNumber}:`,
      error,
    );
    return undefined;
  }
}

/**
 * Extracts the title as it existed when the trigger event fired.
 */
export function extractOriginalTitle(
  context: ParsedGitHubContext,
): string | undefined {
  if (isIssueCommentEvent(context)) {
    return context.payload.issue?.title;
  } else if (isPullRequestEvent(context)) {
    return context.payload.pull_request?.title;
  } else if (isPullRequestReviewEvent(context)) {
    return context.payload.pull_request?.title;
  } else if (isPullRequestReviewCommentEvent(context)) {
    return context.payload.pull_request?.title;
  } else if (isIssuesEvent(context)) {
    return context.payload.issue?.title;
  }

  return undefined;
}

/**
 * Extracts the body as it existed when the trigger event fired, preventing
 * TOCTOU attacks where an attacker edits the body after the trigger but before
 * the action reads it.
 */
export function extractOriginalBody(
  context: ParsedGitHubContext,
): string | null | undefined {
  if (isIssueCommentEvent(context)) {
    return context.payload.issue?.body;
  } else if (isPullRequestEvent(context)) {
    return context.payload.pull_request?.body;
  } else if (isPullRequestReviewEvent(context)) {
    return context.payload.pull_request?.body;
  } else if (isPullRequestReviewCommentEvent(context)) {
    return context.payload.pull_request?.body;
  } else if (isIssuesEvent(context)) {
    return context.payload.issue?.body;
  }

  return undefined;
}

/**
 * Filters comments to only those that existed in their final state before the
 * trigger time. This prevents malicious actors from editing comments after the
 * trigger to inject content into the prompt.
 */
export function filterCommentsToTriggerTime<
  T extends { createdAt: string; updatedAt?: string; lastEditedAt?: string },
>(comments: T[], triggerTime: string | undefined): T[] {
  if (!triggerTime) return comments;

  const triggerTimestamp = new Date(triggerTime).getTime();

  return comments.filter((comment) => {
    const createdTimestamp = new Date(comment.createdAt).getTime();
    if (createdTimestamp >= triggerTimestamp) {
      return false;
    }

    // If the comment was edited, the most recent edit must predate the trigger.
    const lastEditTime = comment.lastEditedAt || comment.updatedAt;
    if (lastEditTime) {
      const lastEditTimestamp = new Date(lastEditTime).getTime();
      if (lastEditTimestamp >= triggerTimestamp) {
        return false;
      }
    }

    return true;
  });
}

/**
 * Same as filterCommentsToTriggerTime, for reviews (which carry `submittedAt`
 * rather than `createdAt`).
 */
export function filterReviewsToTriggerTime<
  T extends { submittedAt: string; updatedAt?: string; lastEditedAt?: string },
>(reviews: T[], triggerTime: string | undefined): T[] {
  if (!triggerTime) return reviews;

  const triggerTimestamp = new Date(triggerTime).getTime();

  return reviews.filter((review) => {
    const submittedTimestamp = new Date(review.submittedAt).getTime();
    if (submittedTimestamp >= triggerTimestamp) {
      return false;
    }

    const lastEditTime = review.lastEditedAt || review.updatedAt;
    if (lastEditTime) {
      const lastEditTimestamp = new Date(lastEditTime).getTime();
      if (lastEditTimestamp >= triggerTimestamp) {
        return false;
      }
    }

    return true;
  });
}

/**
 * Checks whether the issue/PR body is still the one that was in place at
 * trigger time. Used when the webhook payload did not carry a body snapshot.
 */
export function isBodySafeToUse(
  contextData: { createdAt: string; updatedAt?: string; lastEditedAt?: string },
  triggerTime: string | undefined,
): boolean {
  // Without a trigger time there is nothing to compare against; allow the body.
  if (!triggerTime) return true;

  const triggerTimestamp = new Date(triggerTime).getTime();

  const lastEditTime = contextData.lastEditedAt || contextData.updatedAt;
  if (lastEditTime) {
    const lastEditTimestamp = new Date(lastEditTime).getTime();
    if (lastEditTimestamp >= triggerTimestamp) {
      return false;
    }
  }

  return true;
}

/** Filters comments by author against the include/exclude actor patterns. */
export function filterCommentsByActor<
  T extends { author: { login: string } | null },
>(comments: T[], includeActors: string = "", excludeActors: string = ""): T[] {
  const includeParsed = parseActorFilter(includeActors);
  const excludeParsed = parseActorFilter(excludeActors);

  if (includeParsed.length === 0 && excludeParsed.length === 0) {
    return comments;
  }

  return comments.filter((comment) =>
    shouldIncludeCommentByActor(
      // author is null for comments from deleted ("ghost") accounts; treat them
      // as the "ghost" login so filtering never dereferences null and crashes.
      comment.author?.login ?? "ghost",
      includeParsed,
      excludeParsed,
    ),
  );
}

type FetchDataParams = {
  octokits: Octokits;
  repository: string;
  prNumber: string;
  isPR: boolean;
  triggerUsername?: string;
  triggerTime?: string;
  originalTitle?: string;
  originalBody?: string | null;
  includeCommentsByActor?: string;
  excludeCommentsByActor?: string;
};

export type GitHubFileWithSHA = GitHubFile & {
  sha: string;
};

export type FetchDataResult = {
  contextData: GitHubPullRequest | GitHubIssue;
  comments: GitHubComment[];
  changedFiles: GitHubFile[];
  changedFilesWithSHA: GitHubFileWithSHA[];
  reviewData: { nodes: GitHubReview[] } | null;
  triggerDisplayName?: string | null;
};

export async function fetchGitHubData({
  octokits,
  repository,
  prNumber,
  isPR,
  triggerUsername,
  triggerTime,
  originalTitle,
  originalBody,
  includeCommentsByActor,
  excludeCommentsByActor,
}: FetchDataParams): Promise<FetchDataResult> {
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) {
    throw new Error("Invalid repository format. Expected 'owner/repo'.");
  }

  let contextData: GitHubPullRequest | GitHubIssue | null = null;
  let comments: GitHubComment[] = [];
  let changedFiles: GitHubFile[] = [];
  let reviewData: { nodes: GitHubReview[] } | null = null;

  try {
    if (isPR) {
      const prResult = await octokits.graphql<PullRequestQueryResponse>(
        PR_QUERY,
        {
          owner,
          repo,
          number: parseInt(prNumber),
        },
      );

      if (prResult.repository.pullRequest) {
        const pullRequest = prResult.repository.pullRequest;
        contextData = pullRequest;
        if (pullRequest.files === null) {
          console.warn(
            `GitHub did not return the file list for PR #${prNumber} (diff likely too large); proceeding without file-level context`,
          );
        }
        changedFiles = pullRequest.files?.nodes ?? [];
        comments = filterCommentsByActor(
          filterCommentsToTriggerTime(
            pullRequest.comments?.nodes || [],
            triggerTime,
          ),
          includeCommentsByActor,
          excludeCommentsByActor,
        );
        reviewData = pullRequest.reviews || { nodes: [] };

        console.log(`Successfully fetched PR #${prNumber} data`);
      } else {
        throw new Error(`PR #${prNumber} not found`);
      }
    } else {
      const issueResult = await octokits.graphql<IssueQueryResponse>(
        ISSUE_QUERY,
        {
          owner,
          repo,
          number: parseInt(prNumber),
        },
      );

      if (issueResult.repository.issue) {
        contextData = issueResult.repository.issue;
        comments = filterCommentsByActor(
          filterCommentsToTriggerTime(
            contextData?.comments?.nodes || [],
            triggerTime,
          ),
          includeCommentsByActor,
          excludeCommentsByActor,
        );

        console.log(`Successfully fetched issue #${prNumber} data`);
      } else {
        throw new Error(`Issue #${prNumber} not found`);
      }
    }
  } catch (error) {
    console.error(`Failed to fetch ${isPR ? "PR" : "issue"} data:`, error);
    throw new Error(`Failed to fetch ${isPR ? "PR" : "issue"} data`);
  }

  // Compute SHAs for changed files so the agent can tell whether the working
  // tree matches what GitHub reported.
  let changedFilesWithSHA: GitHubFileWithSHA[] = [];
  if (isPR && changedFiles.length > 0) {
    changedFilesWithSHA = changedFiles.map((file) => {
      if (file.changeType === "DELETED") {
        return { ...file, sha: "deleted" };
      }

      try {
        const sha = execFileSync("git", ["hash-object", file.path], {
          encoding: "utf-8",
        }).trim();
        return { ...file, sha };
      } catch (error) {
        console.warn(`Failed to compute SHA for ${file.path}:`, error);
        return { ...file, sha: "unknown" };
      }
    });
  }

  // Filter reviews and inline review comments to trigger time and by actor.
  // This is the same TOCTOU protection applied to issue/PR comments above:
  // anything submitted, created, or edited at/after the trigger is dropped so
  // an attacker cannot inject content into the prompt after an authorized
  // trigger.
  if (reviewData?.nodes) {
    reviewData.nodes = filterCommentsByActor(
      filterReviewsToTriggerTime(reviewData.nodes, triggerTime),
      includeCommentsByActor,
      excludeCommentsByActor,
    );

    for (const review of reviewData.nodes) {
      if (review.comments?.nodes) {
        review.comments.nodes = filterCommentsByActor(
          filterCommentsToTriggerTime(review.comments.nodes, triggerTime),
          includeCommentsByActor,
          excludeCommentsByActor,
        );
      }
    }
  }

  // Prefer the body captured in the webhook payload (TOCTOU protection): it is
  // the body as of event time, before any attacker edit.
  if (originalBody !== undefined) {
    contextData.body = originalBody ?? "";
  } else if (contextData.body && !isBodySafeToUse(contextData, triggerTime)) {
    console.warn(
      `Security: ${isPR ? "PR" : "Issue"} #${prNumber} body was edited after the trigger event. ` +
        `Excluding body content to prevent potential injection attacks.`,
    );
    contextData.body =
      "[Body omitted: it was edited after the triggering event.]";
  }

  let triggerDisplayName: string | null | undefined;
  if (triggerUsername) {
    triggerDisplayName = await fetchUserDisplayName(octokits, triggerUsername);
  }

  if (originalTitle !== undefined) {
    contextData.title = originalTitle;
  }

  return {
    contextData,
    comments,
    changedFiles,
    changedFilesWithSHA,
    reviewData,
    triggerDisplayName,
  };
}

export type UserQueryResponse = {
  user: {
    name: string | null;
  };
};

export async function fetchUserDisplayName(
  octokits: Octokits,
  login: string,
): Promise<string | null> {
  try {
    const result = await octokits.graphql<UserQueryResponse>(USER_QUERY, {
      login,
    });
    return result.user.name;
  } catch (error) {
    console.warn(`Failed to fetch user display name for ${login}:`, error);
    return null;
  }
}
