import { describe, expect, test } from "bun:test";
import { updateCommentBody } from "../src/github/operations/comment-logic";

const jobUrl = "https://github.com/o/r/actions/runs/123";

describe("updateCommentBody", () => {
  test("replaces the working marker with a finished header", () => {
    const body = updateCommentBody({
      currentBody:
        "Kiro is working… ⏳\n\nI'll analyze this and get back to you.",
      actionFailed: false,
      executionDetails: { duration_ms: 65_000 },
      jobUrl,
      triggerUsername: "octocat",
    });

    expect(body).toContain("**Kiro finished @octocat's task in 1m 5s**");
    expect(body).not.toContain("Kiro is working");
    expect(body).toContain(`[View job](${jobUrl})`);
  });

  test("reports a failure with the error details in a code block", () => {
    const body = updateCommentBody({
      currentBody: "Kiro is working… ⏳",
      actionFailed: true,
      executionDetails: { duration_ms: 3_000 },
      jobUrl,
      errorDetails: "The Kiro CLI exited with code 1.",
    });

    expect(body).toContain("**Kiro encountered an error after 3s**");
    expect(body).toContain("```\nThe Kiro CLI exited with code 1.\n```");
  });

  test("redacts credentials that leaked into the error text", () => {
    const body = updateCommentBody({
      currentBody: "Kiro is working…",
      actionFailed: true,
      executionDetails: null,
      jobUrl,
      errorDetails: `fatal: could not read https://x-access-token:ghs_${"a".repeat(36)}@github.com/o/r.git`,
    });

    expect(body).toContain("[REDACTED_GITHUB_TOKEN]");
    expect(body).not.toContain("ghs_");
  });

  test("links the branch and drops the initial link lines", () => {
    const body = updateCommentBody({
      currentBody:
        "Kiro is working… ⏳\n\nsummary text\n\n[View job run](https://github.com/o/r/actions/runs/123)\n[View branch](https://github.com/o/r/tree/kiro/issue-1)",
      actionFailed: false,
      executionDetails: null,
      jobUrl,
      branchLink: "\n[View branch](https://github.com/o/r/tree/kiro/issue-1)",
      branchName: "kiro/issue-1",
      triggerUsername: "octocat",
    });

    expect(body).toContain(
      "• [`kiro/issue-1`](https://github.com/o/r/tree/kiro/issue-1)",
    );
    expect(body).not.toContain("[View job run]");
    expect(body).toContain("summary text");
  });

  test("keeps a create-PR link that the model already added", () => {
    const prUrl =
      "https://github.com/o/r/compare/main...kiro/issue-1?quick_pull=1";
    const body = updateCommentBody({
      currentBody: `Kiro is working… ⏳\n\ndone\n\n[Create a PR](${prUrl})`,
      actionFailed: false,
      executionDetails: null,
      jobUrl,
    });

    expect(body).toContain(`• [Create PR ➔](${prUrl})`);
  });
});
