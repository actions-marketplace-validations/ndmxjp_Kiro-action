/**
 * Set up the appropriate branch for the event:
 * - Open PR: check out the PR branch
 * - Issue, or closed/merged PR: create a new branch from the source branch
 */

import { execFileSync } from "child_process";
import type { ParsedGitHubContext } from "../context";
import type { GitHubPullRequest } from "../types";
import type { Octokits } from "../api/client";
import type { FetchDataResult } from "../data/fetcher";
import { generateBranchName } from "../../utils/branch-template";
import { fetchDepthArgs } from "./fetch-depth";

/** Returns the first label on the issue/PR, if any. */
function extractFirstLabel(githubData: FetchDataResult): string | undefined {
  const labels = githubData.contextData.labels?.nodes;
  return labels && labels.length > 0 ? labels[0]?.name : undefined;
}

/**
 * Validates a git branch name against a strict allowlist pattern.
 *
 * Valid branch names:
 * - Start with an alphanumeric character, underscore, or `@` (not a dash, which
 *   would let the value be read as a command-line option)
 * - Contain only alphanumerics, `/`, `-`, `_`, `.`, `#`, `+`, `,`, `@`
 * - Do not start or end with a period, end with a slash, or end with `.lock`
 * - Do not contain `..`, `//`, or `@{`
 * - Are not the single character `@` (HEAD shorthand in git revision syntax)
 * - Do not contain control characters, spaces, or `~^:?*[]\`
 */
export function validateBranchName(branchName: string): void {
  if (!branchName || branchName.trim().length === 0) {
    throw new Error("Branch name cannot be empty");
  }

  if (branchName.startsWith("-")) {
    throw new Error(
      `Invalid branch name: "${branchName}". Branch names cannot start with a dash.`,
    );
  }

  if (/[\x00-\x1F\x7F ~^:?*[\]\\]/.test(branchName)) {
    throw new Error(
      `Invalid branch name: "${branchName}". Branch names cannot contain control characters, spaces, or special git characters (~^:?*[\\]).`,
    );
  }

  // All git calls in this action use execFileSync (never a shell), so these
  // characters carry no injection risk; the pattern exists to keep values that
  // git itself would reject or reinterpret from reaching it.
  const validPattern = /^[a-zA-Z0-9@_][a-zA-Z0-9/_.#+,@-]*$/;
  if (!validPattern.test(branchName)) {
    throw new Error(
      `Invalid branch name: "${branchName}". Branch names must start with an alphanumeric character, underscore, or '@' and contain only alphanumeric characters, forward slashes, hyphens, underscores, periods, hashes (#), plus signs (+), commas (,), or at signs (@).`,
    );
  }

  if (branchName.startsWith(".") || branchName.endsWith(".")) {
    throw new Error(
      `Invalid branch name: "${branchName}". Branch names cannot start or end with a period.`,
    );
  }

  if (branchName.endsWith("/")) {
    throw new Error(
      `Invalid branch name: "${branchName}". Branch names cannot end with a slash.`,
    );
  }

  if (branchName.includes("//")) {
    throw new Error(
      `Invalid branch name: "${branchName}". Branch names cannot contain consecutive slashes.`,
    );
  }

  if (branchName.includes("..")) {
    throw new Error(
      `Invalid branch name: "${branchName}". Branch names cannot contain '..'`,
    );
  }

  if (branchName.endsWith(".lock")) {
    throw new Error(
      `Invalid branch name: "${branchName}". Branch names cannot end with '.lock'`,
    );
  }

  if (branchName.includes("@{")) {
    throw new Error(
      `Invalid branch name: "${branchName}". Branch names cannot contain '@{'`,
    );
  }

  // Per git-check-ref-format a refname cannot be the single character "@"; "@"
  // also resolves to HEAD in git revision syntax, so a bare "@" must never
  // reach git as a branch argument where it could be read as a revision.
  if (branchName === "@") {
    throw new Error(
      `Invalid branch name: "@". Branch names cannot be the single character '@'.`,
    );
  }
}

/**
 * Runs a git command without a shell.
 *
 * execFileSync passes arguments straight to the git binary, so values that
 * would be shell metacharacters (`;`, `|`, `&&`, ...) cannot be interpreted.
 */
function execGit(args: string[]): void {
  execFileSync("git", args, { stdio: "inherit", env: process.env });
}

/** Returns true when the ref already exists on origin. */
function remoteBranchExists(branchName: string): boolean {
  try {
    execFileSync(
      "git",
      ["ls-remote", "--exit-code", "origin", `refs/heads/${branchName}`],
      { stdio: ["ignore", "ignore", "ignore"], env: process.env },
    );
    return true;
  } catch {
    return false;
  }
}

export type BranchInfo = {
  baseBranch: string;
  /** Set only when the action created a new branch for this run. */
  kiroBranch?: string;
  currentBranch: string;
};

export async function setupBranch(
  octokits: Octokits,
  githubData: FetchDataResult,
  context: ParsedGitHubContext,
): Promise<BranchInfo> {
  const { owner, repo } = context.repository;
  const entityNumber = context.entityNumber;
  const { baseBranch, branchPrefix, branchNameTemplate } = context.inputs;
  const isPR = context.isPR;

  if (isPR) {
    const prData = githubData.contextData as GitHubPullRequest;
    const prState = prData.state;

    if (prState === "CLOSED" || prState === "MERGED") {
      console.log(
        `PR #${entityNumber} is ${prState}, creating new branch from source...`,
      );
      // Fall through to the new-branch path used for issues.
    } else {
      console.log("This is an open PR, checking out PR branch...");

      const branchName = prData.headRefName;

      // Determine the fetch depth from the PR commit count, with a floor of 20.
      // Only applied when the checkout is already shallow — see fetchDepthArgs.
      const commitCount = prData.commits.totalCount;
      const fetchDepth = Math.max(commitCount, 20);
      const depthArgs = fetchDepthArgs(fetchDepth);

      console.log(
        `PR #${entityNumber}: ${commitCount} commits, ${
          depthArgs.length > 0
            ? `using fetch depth ${fetchDepth}`
            : "fetching without a depth limit (checkout has full history)"
        }`,
      );

      validateBranchName(branchName);

      // For cross-repository (fork) PRs, fetch via the pull ref: the branch
      // only exists on the fork's remote, not on origin.
      if (prData.isCrossRepository) {
        console.log(
          `PR #${entityNumber} is from a fork, fetching via refs/pull/${entityNumber}/head...`,
        );
        execGit([
          "fetch",
          "origin",
          ...depthArgs,
          `pull/${entityNumber}/head:${branchName}`,
        ]);
      } else {
        execGit(["fetch", "origin", ...depthArgs, branchName]);
      }
      execGit(["checkout", branchName, "--"]);

      console.log(`Successfully checked out PR branch for PR #${entityNumber}`);

      const prBaseBranch = prData.baseRefName;
      validateBranchName(prBaseBranch);

      return {
        baseBranch: prBaseBranch,
        currentBranch: branchName,
      };
    }
  }

  // Resolve the source branch: the configured base branch, or the repo default.
  let sourceBranch: string;
  if (baseBranch) {
    sourceBranch = baseBranch;
  } else {
    const repoResponse = await octokits.rest.repos.get({ owner, repo });
    sourceBranch = repoResponse.data.default_branch;
  }

  const entityType = isPR ? "pr" : "issue";

  try {
    // Resolve the source branch SHA, which also verifies the branch exists.
    const sourceBranchRef = await octokits.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${sourceBranch}`,
    });

    const sourceSHA = sourceBranchRef.data.object.sha;
    console.log(`Source branch SHA: ${sourceSHA}`);

    const firstLabel = extractFirstLabel(githubData);
    const title = githubData.contextData.title;

    let newBranch = generateBranchName(
      branchNameTemplate,
      branchPrefix,
      entityType,
      entityNumber,
      sourceSHA,
      firstLabel,
      title,
    );

    if (remoteBranchExists(newBranch)) {
      console.log(
        `Branch '${newBranch}' already exists, falling back to default format`,
      );
      newBranch = generateBranchName(
        undefined, // force the default template
        branchPrefix,
        entityType,
        entityNumber,
        sourceSHA,
        firstLabel,
        title,
      );
    }

    validateBranchName(newBranch);
    validateBranchName(sourceBranch);

    console.log(
      `Creating local branch ${newBranch} for ${entityType} #${entityNumber} from source branch: ${sourceBranch}...`,
    );

    // Check out the source branch first so the new branch has the right base.
    execGit(["fetch", "origin", sourceBranch, ...fetchDepthArgs(1)]);
    execGit(["checkout", sourceBranch, "--"]);
    execGit(["checkout", "-b", newBranch]);

    console.log(
      `Successfully created and checked out local branch: ${newBranch}`,
    );

    return {
      baseBranch: sourceBranch,
      kiroBranch: newBranch,
      currentBranch: newBranch,
    };
  } catch (error) {
    console.error("Error in branch setup:", error);
    throw error;
  }
}
