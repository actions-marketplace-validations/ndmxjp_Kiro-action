import { execFileSync } from "child_process";
import { rmSync } from "fs";
import { fetchDepthArgs } from "./fetch-depth";

/**
 * Paths that are both PR-controllable and read from the working directory when
 * the Kiro CLI (or git) starts up.
 *
 *   .kiro/         — agents, steering, hooks, settings/mcp.json. Agent configs
 *                    declare MCP servers and tool permissions; hooks run shell
 *                    commands. All of it is honored from cwd.
 *   .amazonq/      — legacy config directory still read by the CLI lineage.
 *   .mcp.json      — MCP server definitions, i.e. commands to execute.
 *   AGENTS.md,
 *   KIRO.md        — instruction files loaded into the model's context.
 *   .gitmodules    — makes `git fetch` reach out to attacker-chosen remotes.
 *   .ripgreprc     — read by ripgrep, which backs the grep tool.
 *   .husky/        — git hooks, executed on `git commit`.
 *
 * Deliberately not restored:
 *   .git/          — not tracked by git, so a PR commit cannot place files
 *                    there; restoring it would undo the PR checkout.
 *   ~/.gitconfig,
 *   ~/.bashrc      — read from $HOME, which the checkout cannot reach.
 *   .vscode/,
 *   .idea/         — IDE config; nothing in the CLI startup path reads them.
 */
const SENSITIVE_PATHS = [
  ".kiro",
  ".amazonq",
  ".mcp.json",
  "AGENTS.md",
  "KIRO.md",
  ".gitmodules",
  ".ripgreprc",
  ".husky",
];

/**
 * Restores security-sensitive config paths from the PR base branch.
 *
 * Headless mode trusts the working directory: the CLI reads agent definitions,
 * MCP server config, hooks, and steering files from cwd and acts on them before
 * any tool-permission gating. When this action checks out a PR head, all of that
 * is attacker-controlled.
 *
 * Rather than enumerate every dangerous key, this replaces those paths wholesale
 * with the versions from the PR base branch, which a maintainer has reviewed and
 * merged. Paths that do not exist on base stay deleted.
 *
 * The restore shows up as a working-tree change, but it does not ride along in
 * the agent's commit: src/git/commit.ts snapshots the tree immediately before the
 * CLI starts and stages only paths that differ from that snapshot. Verified on a
 * test pull request, where the log read "Ignoring 2 path(s) that were already
 * modified before the run: .kiro/steering/injected.md, bun.lock" and the run
 * committed nothing.
 *
 * Also note that only the paths below come from the base branch; the rest of the
 * working tree stays at the PR head. A base-branch hook that calls out through
 * files a PR can change — package-manager scripts (`bun run`, `npm run`),
 * Makefile targets, repo-relative script paths — therefore still runs whatever
 * the PR head provides. Keep restored hooks self-contained.
 *
 * @param baseBranch - PR base branch name. Must already be validated
 *   (branch.ts calls validateBranchName on it before returning).
 */
export function restoreConfigFromBase(baseBranch: string): void {
  console.log(
    `Restoring ${SENSITIVE_PATHS.join(", ")} from origin/${baseBranch} (PR head is untrusted)`,
  );

  // Delete the PR-controlled versions BEFORE fetching, so an attacker-controlled
  // .gitmodules is absent during the network operation. With git's default
  // fetch.recurseSubmodules=on-demand, a hostile .gitmodules makes fetch try to
  // reach submodule remotes and block on credential prompts — an indefinite CI
  // hang. Deleting first closes that window.
  //
  // If the restore below fails for a path, that path stays deleted, which is the
  // safe fallback. A bare `git checkout` would not remove files the PR added, so
  // the delete has to come first regardless.
  for (const path of SENSITIVE_PATHS) {
    rmSync(path, { recursive: true, force: true });
  }

  // --no-recurse-submodules: suppress submodule fetching regardless of config.
  // Defense in depth alongside the delete above.
  execFileSync(
    "git",
    [
      "fetch",
      "origin",
      baseBranch,
      ...fetchDepthArgs(1),
      "--no-recurse-submodules",
    ],
    { stdio: "inherit", env: process.env },
  );

  for (const path of SENSITIVE_PATHS) {
    try {
      execFileSync("git", ["checkout", `origin/${baseBranch}`, "--", path], {
        stdio: "pipe",
      });
    } catch {
      // Path does not exist on base — it stays deleted.
    }
  }

  // `git checkout <ref> -- <path>` stages what it restores. Unstage it so the
  // revert does not silently leak into commits Kiro makes later.
  try {
    execFileSync("git", ["reset", "--", ...SENSITIVE_PATHS], { stdio: "pipe" });
  } catch {
    // Nothing was staged, or the paths do not exist on HEAD — either is fine.
  }
}
