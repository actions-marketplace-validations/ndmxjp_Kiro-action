import type { GitHubContext } from "../github/context";

export type CommonFields = {
  repository: string;
  kiroCommentId: string;
  triggerPhrase: string;
  triggerUsername?: string;
  triggerUserId?: number;
  prompt?: string;
  kiroBranch?: string;
};

type PullRequestReviewCommentEvent = {
  eventName: "pull_request_review_comment";
  isPR: true;
  prNumber: string;
  commentId?: string;
  commentBody: string;
  kiroBranch?: string;
  baseBranch?: string;
};

type PullRequestReviewEvent = {
  eventName: "pull_request_review";
  isPR: true;
  prNumber: string;
  /** Absent for approvals submitted without a body. */
  commentBody?: string;
  kiroBranch?: string;
  baseBranch?: string;
};

type IssueCommentEvent = {
  eventName: "issue_comment";
  commentId: string;
  issueNumber: string;
  isPR: false;
  baseBranch: string;
  kiroBranch: string;
  commentBody: string;
};

// Not a distinct GitHub event: issue comments and PR comments both arrive as
// issue_comment.
type PullRequestCommentEvent = {
  eventName: "issue_comment";
  commentId: string;
  prNumber: string;
  isPR: true;
  commentBody: string;
  kiroBranch?: string;
  baseBranch?: string;
};

type IssueOpenedEvent = {
  eventName: "issues";
  eventAction: "opened";
  isPR: false;
  issueNumber: string;
  baseBranch: string;
  kiroBranch: string;
};

type IssueAssignedEvent = {
  eventName: "issues";
  eventAction: "assigned";
  isPR: false;
  issueNumber: string;
  baseBranch: string;
  kiroBranch: string;
  assigneeTrigger?: string;
};

type IssueLabeledEvent = {
  eventName: "issues";
  eventAction: "labeled";
  isPR: false;
  issueNumber: string;
  baseBranch: string;
  kiroBranch: string;
  labelTrigger: string;
};

type PullRequestEvent = {
  eventName: "pull_request";
  /** opened, synchronize, ... */
  eventAction?: string;
  isPR: true;
  prNumber: string;
  kiroBranch?: string;
  baseBranch?: string;
};

export type EventData =
  | PullRequestReviewCommentEvent
  | PullRequestReviewEvent
  | PullRequestCommentEvent
  | IssueCommentEvent
  | IssueOpenedEvent
  | IssueAssignedEvent
  | IssueLabeledEvent
  | PullRequestEvent;

export type PreparedContext = CommonFields & {
  eventData: EventData;
  githubContext?: GitHubContext;
};
