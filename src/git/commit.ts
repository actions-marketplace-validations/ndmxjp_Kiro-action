import * as core from "@actions/core";
import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { stripInvisibleCharacters } from "../github/utils/sanitizer";

/** Longest commit message we will pass on to git, subject and body together. */
const MAX_MESSAGE_BYTES = 8 * 1024;

/**
 * Paths that were already dirty before the agent ran, mapped to the hash of
 * their contents at that moment. Used to keep changes the action itself made —
 * its own `bun install`, or the sensitive-config restore on a pull request —
 * out of the agent's commit.
 */
export type WorkingTreeSnapshot = Map<string, string>;

export type CommitAndPushParams = {
  /** Branch to push to. Must already be validated with validateBranchName. */
  branch: string;
  /** File the agent was asked to write its commit message to, if it made changes. */
  messageFile: string;
  /** Fallback subject when the agent wrote no message. */
  fallbackSubject: string;
  /** `Co-authored-by:` trailer to append, if the trigger user is known. */
  coAuthorLine?: string;
  /** Working tree state from before the run; see WorkingTreeSnapshot. */
  baseline?: WorkingTreeSnapshot;
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
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Paths git reports as changed, including untracked files individually
 * (`-uall`, so an untracked directory does not collapse into one entry that
 * cannot be hashed or staged precisely).
 */
function changedPaths(): string[] {
  const entries = git(["status", "--porcelain=1", "-z", "-uall"])
    .split("\0")
    .filter((entry) => entry.length > 0);

  const paths: string[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (path) {
      paths.push(path);
    }
    // A rename entry is followed by its origin path as a separate NUL field.
    if (code.startsWith("R") || code.startsWith("C")) {
      const origin = entries[++index];
      if (origin) {
        paths.push(origin);
      }
    }
  }
  return paths;
}

/** Hash of a path's current contents, or "absent" when it is gone. */
function contentHash(path: string): string {
  if (!existsSync(path)) {
    return "absent";
  }
  try {
    return git(["hash-object", "--", path]).trim();
  } catch {
    // Directories and unreadable paths cannot be hashed; treat them as changed
    // so they are never silently skipped.
    return `unhashable:${Math.random()}`;
  }
}

/**
 * Records what is already dirty before the agent runs, so its commit contains
 * only what it actually changed.
 */
export function snapshotWorkingTree(): WorkingTreeSnapshot {
  const snapshot: WorkingTreeSnapshot = new Map();
  try {
    for (const path of changedPaths()) {
      snapshot.set(path, contentHash(path));
    }
  } catch (error) {
    core.warning(
      `Could not snapshot the working tree; the commit may include unrelated changes: ${error}`,
    );
  }
  if (snapshot.size > 0) {
    core.info(
      `Ignoring ${snapshot.size} path(s) that were already modified before the run: ${[
        ...snapshot.keys(),
      ].join(", ")}`,
    );
  }
  return snapshot;
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
  const { branch, messageFile, fallbackSubject, coAuthorLine, baseline } =
    params;

  let paths: string[];
  try {
    paths = changedPaths().filter(
      (path) =>
        !baseline?.has(path) || baseline.get(path) !== contentHash(path),
    );
  } catch (error) {
    core.warning(`Could not read git status; skipping the commit: ${error}`);
    return { changed: false, committed: false, pushed: false };
  }

  if (paths.length === 0) {
    core.info("Kiro made no file changes; nothing to commit.");
    return { changed: false, committed: false, pushed: false };
  }

  core.info(`Kiro changed ${paths.length} path(s):\n${paths.join("\n")}`);

  const message = buildMessage(messageFile, fallbackSubject, coAuthorLine);

  try {
    // Stage only what the agent touched. `git add -A` would also pick up
    // whatever the action itself left in the working tree.
    for (let index = 0; index < paths.length; index += 200) {
      git(["add", "--", ...paths.slice(index, index + 200)]);
    }
  } catch (error) {
    core.warning(`Could not stage changes: ${error}`);
    return { changed: true, committed: false, pushed: false };
  }

  // Staging can still end up empty (for example when every changed path is
  // ignored), and `git commit` fails outright in that case.
  try {
    git(["diff", "--cached", "--quiet"]);
    core.info("Nothing staged after adding those paths; not committing.");
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
