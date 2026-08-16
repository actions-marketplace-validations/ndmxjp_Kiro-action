import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { commitAndPush, snapshotWorkingTree } from "../src/git/commit";

/**
 * These run against a real repository pair on disk: a bare "remote" and a clone
 * that stands in for the runner's checkout. Nothing is mocked, so the test
 * covers the actual git invocations, including the push.
 */
const created: string[] = [];

function makeRepoPair() {
  const root = mkdtempSync(join(tmpdir(), "kiro-commit-test-"));
  created.push(root);

  const remote = join(root, "remote.git");
  const work = join(root, "work");

  const git = (cwd: string, args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8" });

  execFileSync("git", ["init", "--bare", "--initial-branch=main", remote]);
  execFileSync("git", ["clone", remote, work], { stdio: "ignore" });
  git(work, ["config", "user.email", "kiro@example.com"]);
  git(work, ["config", "user.name", "Kiro"]);
  writeFileSync(join(work, "README.md"), "start\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "-m", "initial"]);
  git(work, ["push", "-u", "origin", "main"]);

  return { root, remote, work, git };
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function inDirectory<T>(dir: string, fn: () => T): T {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(previous);
  }
}

describe("commitAndPush", () => {
  test("reports no change when the working tree is clean", () => {
    const { work } = makeRepoPair();

    const result = inDirectory(work, () =>
      commitAndPush({
        branch: "main",
        messageFile: join(work, "does-not-exist.txt"),
        fallbackSubject: "fallback",
      }),
    );

    expect(result).toEqual({ changed: false, committed: false, pushed: false });
  });

  test("commits and pushes an edit, using the agent's message", () => {
    const { work, git, root } = makeRepoPair();
    const messageFile = join(root, "message.txt");

    writeFileSync(join(work, "README.md"), "changed\n");
    writeFileSync(join(work, "new-file.txt"), "added\n");
    writeFileSync(messageFile, "Fix the thing\n\nBecause it was broken.\n");

    const result = inDirectory(work, () =>
      commitAndPush({
        branch: "main",
        messageFile,
        fallbackSubject: "fallback",
        coAuthorLine:
          "Co-authored-by: Someone <1+someone@users.noreply.github.com>",
      }),
    );

    expect(result.changed).toBe(true);
    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(true);
    expect(result.sha).toMatch(/^[0-9a-f]{40}$/);

    const message = git(work, ["log", "-1", "--pretty=%B"]);
    expect(message).toContain("Fix the thing");
    expect(message).toContain("Because it was broken.");
    expect(message).toContain(
      "Co-authored-by: Someone <1+someone@users.noreply.github.com>",
    );

    // The push really landed: the bare remote has the same commit.
    const remoteLog = execFileSync(
      "git",
      ["-C", work, "log", "--oneline", "origin/main", "-1"],
      { encoding: "utf8" },
    );
    expect(remoteLog).toContain("Fix the thing");

    // Untracked files are included, so a newly created file is committed too.
    const files = git(work, ["show", "--name-only", "--pretty=", "HEAD"]);
    expect(files).toContain("new-file.txt");
  });

  test("falls back to the generated subject when the agent wrote no message", () => {
    const { work, git, root } = makeRepoPair();

    writeFileSync(join(work, "README.md"), "changed\n");

    const result = inDirectory(work, () =>
      commitAndPush({
        branch: "main",
        messageFile: join(root, "missing.txt"),
        fallbackSubject: "Apply changes from Kiro for issue #7",
      }),
    );

    expect(result.committed).toBe(true);
    expect(git(work, ["log", "-1", "--pretty=%s"]).trim()).toBe(
      "Apply changes from Kiro for issue #7",
    );
  });

  test("strips a leading dash so the subject cannot look like an option", () => {
    const { work, git, root } = makeRepoPair();
    const messageFile = join(root, "message.txt");

    writeFileSync(join(work, "README.md"), "changed\n");
    writeFileSync(messageFile, "--force-looking subject\n");

    inDirectory(work, () =>
      commitAndPush({
        branch: "main",
        messageFile,
        fallbackSubject: "fallback",
      }),
    );

    expect(git(work, ["log", "-1", "--pretty=%s"]).trim()).toBe(
      "force-looking subject",
    );
  });

  test("leaves out changes that were already there before the run", () => {
    const { work, git, root } = makeRepoPair();

    // Stand-ins for what the action itself leaves behind: a lockfile from its
    // own install, and an edit to a tracked file.
    writeFileSync(join(work, "bun.lock"), "generated by the action\n");
    writeFileSync(join(work, "README.md"), "touched by the action\n");

    const baseline = inDirectory(work, () => snapshotWorkingTree());
    expect([...baseline.keys()].sort()).toEqual(["README.md", "bun.lock"]);

    // Now the agent edits something else.
    writeFileSync(join(work, "docs.md"), "from the agent\n");

    const result = inDirectory(work, () =>
      commitAndPush({
        branch: "main",
        messageFile: join(root, "missing.txt"),
        fallbackSubject: "Apply changes from Kiro",
        baseline,
      }),
    );

    expect(result.committed).toBe(true);
    const files = git(work, ["show", "--name-only", "--pretty=", "HEAD"]);
    expect(files).toContain("docs.md");
    expect(files).not.toContain("bun.lock");
    expect(files).not.toContain("README.md");
  });

  test("still commits a pre-existing path when the agent changes it further", () => {
    const { work, git, root } = makeRepoPair();

    writeFileSync(join(work, "README.md"), "touched by the action\n");
    const baseline = inDirectory(work, () => snapshotWorkingTree());

    // Same path, different content: the status code is unchanged, so this only
    // works because the snapshot records content hashes.
    writeFileSync(join(work, "README.md"), "and then by the agent\n");

    const result = inDirectory(work, () =>
      commitAndPush({
        branch: "main",
        messageFile: join(root, "missing.txt"),
        fallbackSubject: "Apply changes from Kiro",
        baseline,
      }),
    );

    expect(result.committed).toBe(true);
    expect(git(work, ["show", "--name-only", "--pretty=", "HEAD"])).toContain(
      "README.md",
    );
  });

  test("reports no change when only the action's own leftovers are present", () => {
    const { work, root } = makeRepoPair();

    writeFileSync(join(work, "bun.lock"), "generated by the action\n");
    const baseline = inDirectory(work, () => snapshotWorkingTree());

    const result = inDirectory(work, () =>
      commitAndPush({
        branch: "main",
        messageFile: join(root, "missing.txt"),
        fallbackSubject: "Apply changes from Kiro",
        baseline,
      }),
    );

    expect(result).toEqual({ changed: false, committed: false, pushed: false });
  });

  test("reports the failure instead of throwing when the push is rejected", () => {
    const { work, root } = makeRepoPair();

    writeFileSync(join(work, "README.md"), "changed\n");
    // Point origin at nothing so the push cannot succeed.
    execFileSync("git", [
      "-C",
      work,
      "remote",
      "set-url",
      "origin",
      join(root, "absent.git"),
    ]);

    const result = inDirectory(work, () =>
      commitAndPush({
        branch: "main",
        messageFile: join(root, "missing.txt"),
        fallbackSubject: "fallback",
      }),
    );

    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(false);
    expect(result.sha).toMatch(/^[0-9a-f]{40}$/);
  });
});
