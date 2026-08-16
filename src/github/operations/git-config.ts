/**
 * Configure git so that commits made during the run are attributed correctly
 * and pushes authenticate with this action's token.
 */

import { execFileSync } from "child_process";
import type { GitHubContext } from "../context";
import { GITHUB_SERVER_URL } from "../api/config";

type GitUser = {
  login: string;
  id: number;
};

function git(args: string[]): void {
  execFileSync("git", args, { stdio: "inherit", env: process.env });
}

export async function configureGitAuth(
  githubToken: string,
  context: GitHubContext,
  user: GitUser,
) {
  // Derive the noreply email domain from GITHUB_SERVER_URL so GHES works too.
  const serverUrl = new URL(GITHUB_SERVER_URL);
  const noreplyDomain =
    serverUrl.hostname === "github.com"
      ? "users.noreply.github.com"
      : `users.noreply.${serverUrl.hostname}`;

  const botName = user.login;
  const botId = user.id;

  console.log(`Setting git user as ${botName}...`);
  git(["config", "user.name", botName]);
  git(["config", "user.email", `${botId}+${botName}@${noreplyDomain}`]);
  console.log(`✓ Set git user as ${botName}`);

  await replaceCheckoutCredentials(githubToken, context);

  console.log("Git authentication configured successfully");
}

/**
 * Replace the credential that actions/checkout persisted in the working tree.
 *
 * actions/checkout stores its token as an `http.<server>/.extraheader` entry in
 * .git/config for the duration of the job. Kiro and the tools it invokes run
 * inside this working tree, so remove that entry and back git with this
 * action's own token instead.
 */
export async function replaceCheckoutCredentials(
  githubToken: string,
  context: GitHubContext,
) {
  const serverUrl = new URL(GITHUB_SERVER_URL);

  console.log("Removing existing git authentication headers...");
  try {
    git(["config", "--unset-all", `http.${GITHUB_SERVER_URL}/.extraheader`]);
    console.log("✓ Removed existing authentication headers");
  } catch {
    console.log("No existing authentication headers to remove");
  }

  console.log("Updating remote URL with authentication...");
  const remoteUrl = `https://x-access-token:${githubToken}@${serverUrl.host}/${context.repository.owner}/${context.repository.repo}.git`;
  git(["remote", "set-url", "origin", remoteUrl]);
  console.log("✓ Updated remote URL with authentication token");
}
