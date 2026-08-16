import * as core from "@actions/core";
import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { stripInvisibleCharacters } from "../github/utils/sanitizer";

/** Longest commit message we will pass on to git, subject and body together. */
const MAX_MESSAGE_BYTES = 8 * 1024;

export type CommitAndPushParams = {
  /** Branch to push to. Must already be validated with validateBranchName. */
  branch: string;
  /** File the agent was asked to write its commit message to, if it made changes. */
  messageFile: string;
  /** Fallback subject when the agent wrote no message. */
  fallbackSubject: string;
  /** `Co-authored-by:` trailer to append, if the trigger user is known. */
  coAuthorLine?: string;
};

export type CommitAndPushResult = {
  /** Whether the working tree had anything to commit. */
  changed: boolean;
  committed: boolean;
  pushed: boolean;
  sha?: string;
  message?: string;
};

function git(args: string[]): string {
  return execFileSync("git", args, {
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Commits whatever the agent changed and pushes it.
 *
 * The Kiro CLI cannot run git itself in headless mode — tool trust there is
 * all-or-nothing, so granting `git add` would mean granting `curl` too (see
 * src/kiro/agent-config.ts). Committing from the action instead keeps the agent
 * shell-free, and has the side benefit that the commit message and author are
 * decided here rather than by the model's shell quoting.
 */
export function commitAndPush(
  params: CommitAndPushParams,
): CommitAndPushResult {
  const { branch, messageFile, fallbackSubject, coAuthorLine } = params;

  let status: string;
  try {
    status = git(["status", "--porcelain"]);
  } catch (error) {
    core.warning(`Could not read git status; skipping the commit: ${error}`);
    return { changed: false, committed: false, pushed: false };
  }

  if (status.trim().length === 0) {
    core.info("Kiro made no file changes; nothing to commit.");
    return { changed: false, committed: false, pushed: false };
  }

  core.info(`Working tree has changes:\n${status.trim()}`);

  const message = buildMessage(messageFile, fallbackSubject, coAuthorLine);

  try {
    git(["add", "-A"]);
  } catch (error) {
    core.warning(`Could not stage changes: ${error}`);
    return { changed: true, committed: false, pushed: false };
  }

  // `git add -A` can end up staging nothing (for example when every change is
  // to an ignored path), and `git commit` fails outright in that case.
  try {
    git(["diff", "--cached", "--quiet"]);
    core.info("Nothing staged after `git add -A`; not committing.");
    return { changed: true, committed: false, pushed: false };
  } catch {
    // Non-zero exit means there are staged changes, which is what we want.
  }

  try {
    git(["commit", "-m", message]);
  } catch (error) {
    core.warning(`Could not commit: ${error}`);
    return { changed: true, committed: false, pushed: false };
  }

  const sha = git(["rev-parse", "HEAD"]).trim();
  core.info(`Committed ${sha} on ${branch}`);

  try {
    git(["push", "origin", branch]);
  } catch (error) {
    core.warning(`Could not push to ${branch}: ${error}`);
    return { changed: true, committed: true, pushed: false, sha, message };
  }

  core.info(`Pushed ${sha} to ${branch}`);
  return { changed: true, committed: true, pushed: true, sha, message };
}

/**
 * Reads the commit message the agent was asked to write, falling back to a
 * generated subject.
 *
 * The message is model-authored, so it is stripped of control and
 * direction-override characters and capped. It reaches git as a single argv
 * element, so no quoting or option-injection concern applies.
 */
function buildMessage(
  messageFile: string,
  fallbackSubject: string,
  coAuthorLine?: string,
): string {
  let message = "";

  if (existsSync(messageFile)) {
    try {
      message = stripInvisibleCharacters(readFileSync(messageFile, "utf8"))
        .trim()
        .slice(0, MAX_MESSAGE_BYTES);
    } catch (error) {
      core.warning(`Could not read ${messageFile}: ${error}`);
    }
  }

  if (!message) {
    core.info("No commit message from the agent; using the default subject.");
    message = fallbackSubject;
  }

  // A leading dash would make the subject look like an option to tools that
  // later re-parse the message, and git rejects an empty subject line.
  message = message.replace(/^-+\s*/, "").trim() || fallbackSubject;

  if (coAuthorLine && !message.includes(coAuthorLine)) {
    message += `\n\n${coAuthorLine}`;
  }

  return message;
}
