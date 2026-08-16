import { execFileSync } from "child_process";
import type { Octokits } from "../api/client";
import { GITHUB_SERVER_URL } from "../api/config";

function git(args: string[]): string {
  return execFileSync("git", args, {
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * After the run, decide what to do with the branch the action created:
 * commit and push anything Kiro left uncommitted, or delete the branch if it
 * turned out to be empty.
 *
 * Returns the branch link to show in the tracking comment (empty when the
 * branch has nothing on it).
 */
export async function checkAndCommitOrDeleteBranch(
  octokit: Octokits,
  owner: string,
  repo: string,
  kiroBranch: string | undefined,
  baseBranch: string,
): Promise<{ shouldDeleteBranch: boolean; branchLink: string }> {
  if (!kiroBranch) {
    return { shouldDeleteBranch: false, branchLink: "" };
  }

  const branchUrl = `${GITHUB_SERVER_URL}/${owner}/${repo}/tree/${kiroBranch}`;
  let branchLink = "";
  let shouldDeleteBranch = false;

  let branchExistsRemotely = false;
  try {
    await octokit.rest.repos.getBranch({ owner, repo, branch: kiroBranch });
    branchExistsRemotely = true;
  } catch (error) {
    if ((error as { status?: number }).status === 404) {
      console.log(`Branch ${kiroBranch} does not exist remotely`);
    } else {
      console.error("Error checking if branch exists:", error);
    }
  }

  if (!branchExistsRemotely) {
    console.log(
      `Branch ${kiroBranch} does not exist remotely, no branch link will be added`,
    );
    return { shouldDeleteBranch: false, branchLink: "" };
  }

  try {
    const { data: comparison } =
      await octokit.rest.repos.compareCommitsWithBasehead({
        owner,
        repo,
        basehead: `${baseBranch}...${kiroBranch}`,
      });

    if (comparison.total_commits === 0) {
      console.log(
        `Branch ${kiroBranch} has no commits from Kiro, checking for uncommitted changes...`,
      );

      try {
        const hasUncommittedChanges =
          git(["status", "--porcelain"]).trim().length > 0;

        if (hasUncommittedChanges) {
          console.log("Found uncommitted changes, committing them...");

          const runId = process.env.GITHUB_RUN_ID || "unknown";
          git(["add", "-A"]);
          git([
            "commit",
            "-m",
            `Auto-commit: Save uncommitted changes from Kiro\n\nRun ID: ${runId}`,
          ]);
          git(["push", "origin", kiroBranch]);

          console.log(
            "✅ Successfully committed and pushed uncommitted changes",
          );
          branchLink = `\n[View branch](${branchUrl})`;
        } else {
          console.log(
            "No uncommitted changes found, marking branch for deletion",
          );
          shouldDeleteBranch = true;
        }
      } catch (gitError) {
        console.error("Error checking/committing changes:", gitError);
        // If git state cannot be inspected, assume the branch may have content.
        branchLink = `\n[View branch](${branchUrl})`;
      }
    } else {
      branchLink = `\n[View branch](${branchUrl})`;
    }
  } catch (error) {
    console.error("Error comparing commits on the Kiro branch:", error);
    // The branch exists remotely, so link to it even if the compare failed.
    branchLink = `\n[View branch](${branchUrl})`;
  }

  if (shouldDeleteBranch) {
    try {
      await octokit.rest.git.deleteRef({
        owner,
        repo,
        ref: `heads/${kiroBranch}`,
      });
      console.log(`✅ Deleted empty branch: ${kiroBranch}`);
    } catch (deleteError) {
      console.error(`Failed to delete branch ${kiroBranch}:`, deleteError);
      // Continue even if deletion fails.
    }
  }

  return { shouldDeleteBranch, branchLink };
}
