import type { GitHubContext } from "../github/context";
import {
  isEntityContext,
  isIssueCommentEvent,
  isPullRequestReviewCommentEvent,
  isPullRequestEvent,
  isIssuesEvent,
  isPullRequestReviewEvent,
} from "../github/context";
import { checkContainsTrigger } from "../github/validation/trigger";

export type AutoDetectedMode = "tag" | "agent";

/**
 * Picks the execution mode from the event and inputs.
 *
 * - tag: a human mentioned the trigger phrase (or labeled/assigned an issue).
 *   Kiro posts a tracking comment and reports through it.
 * - agent: the workflow supplied an explicit prompt. No tracking comment;
 *   this is the automation path.
 */
export function detectMode(context: GitHubContext): AutoDetectedMode {
  if (context.inputs.trackProgress) {
    validateTrackProgressEvent(context);
  }

  // track_progress asks for the tracking comment explicitly, so it forces tag
  // mode even when a prompt is present.
  if (context.inputs.trackProgress && isEntityContext(context)) {
    if (
      isPullRequestEvent(context) ||
      isIssuesEvent(context) ||
      isIssueCommentEvent(context) ||
      isPullRequestReviewCommentEvent(context) ||
      isPullRequestReviewEvent(context)
    ) {
      return "tag";
    }
  }

  if (isEntityContext(context)) {
    // Comment and review events
    if (
      isIssueCommentEvent(context) ||
      isPullRequestReviewCommentEvent(context) ||
      isPullRequestReviewEvent(context)
    ) {
      if (context.inputs.prompt) {
        return "agent";
      }
      if (checkContainsTrigger(context)) {
        return "tag";
      }
    }

    // Issue events
    if (isIssuesEvent(context)) {
      if (context.inputs.prompt) {
        return "agent";
      }
      if (checkContainsTrigger(context)) {
        return "tag";
      }
    }
  }

  // Anything else (including pull_request opened/synchronize and the
  // automation events) runs in agent mode, which does nothing without a prompt.
  return "agent";
}

function validateTrackProgressEvent(context: GitHubContext): void {
  const validEvents = [
    "pull_request",
    "issues",
    "issue_comment",
    "pull_request_review_comment",
    "pull_request_review",
  ];
  if (!validEvents.includes(context.eventName)) {
    throw new Error(
      `track_progress is only supported for events: ${validEvents.join(", ")}. ` +
        `Current event: ${context.eventName}`,
    );
  }

  if (context.eventName === "pull_request" && context.eventAction) {
    const validActions = [
      "opened",
      "synchronize",
      "ready_for_review",
      "reopened",
      "labeled",
    ];
    if (!validActions.includes(context.eventAction)) {
      throw new Error(
        "track_progress for pull_request events is only supported for actions: " +
          `${validActions.join(", ")}. Current action: ${context.eventAction}`,
      );
    }
  }
}
