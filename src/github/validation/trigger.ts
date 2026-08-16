import * as core from "@actions/core";
import {
  isIssuesEvent,
  isIssuesAssignedEvent,
  isIssueCommentEvent,
  isPullRequestEvent,
  isPullRequestReviewEvent,
  isPullRequestReviewCommentEvent,
} from "../context";
import type { ParsedGitHubContext } from "../context";

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Matches the trigger phrase as a standalone token: it must be preceded by the
 * start of the string or whitespace, and followed by whitespace, terminal
 * punctuation, or the end of the string. This keeps "@kirosomething" and
 * "email@kiro.dev" from triggering a run.
 */
function triggerRegex(triggerPhrase: string): RegExp {
  return new RegExp(
    `(^|\\s)${escapeRegExp(triggerPhrase)}([\\s.,!?;:]|$)`,
    "i",
  );
}

export function checkContainsTrigger(context: ParsedGitHubContext): boolean {
  const {
    inputs: { assigneeTrigger, labelTrigger, triggerPhrase, prompt },
  } = context;

  // An explicit prompt means the workflow author asked for a run unconditionally.
  if (prompt) {
    console.log("Prompt provided, triggering action");
    return true;
  }

  const regex = triggerRegex(triggerPhrase);

  // Assignee trigger
  if (isIssuesAssignedEvent(context)) {
    const triggerUser = assigneeTrigger.replace(/^@/, "");
    const assigneeUsername = context.payload.assignee?.login || "";

    if (triggerUser && assigneeUsername === triggerUser) {
      console.log(`Issue assigned to trigger user '${triggerUser}'`);
      return true;
    }
  }

  // Label trigger
  if (isIssuesEvent(context) && context.eventAction === "labeled") {
    const labelName =
      (context.payload as { label?: { name?: string } }).label?.name || "";

    if (
      labelTrigger &&
      labelName.toLowerCase() === labelTrigger.toLowerCase()
    ) {
      console.log(`Issue labeled with trigger label '${labelTrigger}'`);
      return true;
    }
  }

  // Issue body/title on creation
  if (isIssuesEvent(context) && context.eventAction === "opened") {
    const issueBody = context.payload.issue.body || "";
    const issueTitle = context.payload.issue.title || "";

    if (regex.test(issueBody)) {
      console.log(`Issue body contains trigger phrase '${triggerPhrase}'`);
      return true;
    }

    if (regex.test(issueTitle)) {
      console.log(`Issue title contains trigger phrase '${triggerPhrase}'`);
      return true;
    }
  }

  // Pull request body/title
  if (isPullRequestEvent(context)) {
    const prBody = context.payload.pull_request.body || "";
    const prTitle = context.payload.pull_request.title || "";

    if (regex.test(prBody)) {
      console.log(
        `Pull request body contains trigger phrase '${triggerPhrase}'`,
      );
      return true;
    }

    if (regex.test(prTitle)) {
      console.log(
        `Pull request title contains trigger phrase '${triggerPhrase}'`,
      );
      return true;
    }
  }

  // Pull request review body
  if (
    isPullRequestReviewEvent(context) &&
    (context.eventAction === "submitted" || context.eventAction === "edited")
  ) {
    const reviewBody = context.payload.review.body || "";
    if (regex.test(reviewBody)) {
      console.log(
        `Pull request review contains trigger phrase '${triggerPhrase}'`,
      );
      return true;
    }
  }

  // Issue comments and inline review comments
  if (
    isIssueCommentEvent(context) ||
    isPullRequestReviewCommentEvent(context)
  ) {
    const commentBody = context.payload.comment.body;
    if (regex.test(commentBody)) {
      console.log(`Comment contains trigger phrase '${triggerPhrase}'`);
      return true;
    }
  }

  console.log(`No trigger was met for ${triggerPhrase}`);
  return false;
}

export async function checkTriggerAction(context: ParsedGitHubContext) {
  const containsTrigger = checkContainsTrigger(context);
  core.setOutput("contains_trigger", containsTrigger.toString());
  return containsTrigger;
}
