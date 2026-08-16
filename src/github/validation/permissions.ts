import * as core from "@actions/core";
import { isWorkflowRunEvent, type GitHubContext } from "../context";
import type { Octokit } from "@octokit/rest";

/**
 * Check if a bot actor is in the allowed bots list.
 * `*` allows every bot; otherwise the comma-separated list is matched
 * case-insensitively, with an optional `[bot]` suffix on either side.
 */
export function isAllowedBot(actor: string, allowedBots: string): boolean {
  const trimmed = allowedBots.trim();
  if (trimmed === "*") return true;
  if (!trimmed) return false;

  const allowedList = trimmed
    .split(",")
    .map((bot) =>
      bot
        .trim()
        .toLowerCase()
        .replace(/\[bot\]$/, ""),
    )
    .filter((bot) => bot.length > 0);

  const normalizedActor = actor.toLowerCase().replace(/\[bot\]$/, "");
  return allowedList.includes(normalizedActor);
}

/**
 * Collect the actors whose repository access should be checked. This is
 * normally just the workflow actor (GITHUB_ACTOR). For workflow_run events
 * the actor that started the upstream run is checked as well when it differs,
 * since that is the account the run originates from.
 */
function getActorsToCheck(context: GitHubContext): string[] {
  const actors = [context.actor];

  if (isWorkflowRunEvent(context)) {
    const runActor = context.payload.workflow_run?.actor?.login;
    if (runActor && !actors.includes(runActor)) {
      core.info(
        `workflow_run was started by ${runActor}; checking permissions for that actor as well`,
      );
      actors.push(runActor);
    }
  }

  return actors;
}

/** Returns true only if every relevant actor has write access to the repo. */
export async function checkWritePermissions(
  octokit: Octokit,
  context: GitHubContext,
): Promise<boolean> {
  for (const actor of getActorsToCheck(context)) {
    const allowed = await checkActorWritePermissions(octokit, context, actor);
    if (!allowed) return false;
  }
  return true;
}

async function checkActorWritePermissions(
  octokit: Octokit,
  context: GitHubContext,
  actor: string,
): Promise<boolean> {
  const { repository } = context;
  const allowedBots = context.inputs.allowedBots ?? "";

  try {
    core.info(`Checking permissions for actor: ${actor}`);

    // GitHub Apps show up with a [bot] suffix. Usernames cannot contain "["
    // or "]", so the suffix is a reliable bot signal without an API lookup.
    if (actor.endsWith("[bot]")) {
      core.info(`Actor is a GitHub App: ${actor}`);
      return true;
    }

    // For all other actors, resolve the account via the collaborator
    // permission endpoint. allowed_bots is only consulted in the catch block
    // below, after the API has confirmed the actor is not a regular user
    // account (e.g. GitHub Apps whose GITHUB_ACTOR has no [bot] suffix).
    const response = await octokit.repos.getCollaboratorPermissionLevel({
      owner: repository.owner,
      repo: repository.repo,
      username: actor,
    });

    const permissionLevel = response.data.permission;
    core.info(`Permission level retrieved: ${permissionLevel}`);

    if (permissionLevel === "admin" || permissionLevel === "write") {
      core.info(`Actor has write access: ${permissionLevel}`);
      return true;
    }

    core.warning(`Actor has insufficient permissions: ${permissionLevel}`);
    return false;
  } catch (error) {
    // The collaborator permission API only works for user accounts.
    if (error instanceof Error && error.message.includes("is not a user")) {
      core.info(
        `Actor ${actor} is not a GitHub user (likely a GitHub App). Checking allowed_bots...`,
      );
      if (isAllowedBot(actor, allowedBots)) {
        core.info(
          `Non-user actor ${actor} is in allowed_bots list, granting access`,
        );
        return true;
      }
      core.warning(
        `Non-user actor ${actor} is not in allowed_bots list. Add it to allowed_bots or use '*' to allow all bots.`,
      );
      return false;
    }

    core.error(`Failed to check permissions: ${error}`);
    throw new Error(`Failed to check permissions for ${actor}: ${error}`);
  }
}
