import * as core from "@actions/core";
import { createSign } from "crypto";
import { GITHUB_API_URL } from "./api/config";
import { retryWithBackoff } from "../utils/retry";

export type TokenSource = "input" | "app" | "workflow";

export type ResolvedToken = {
  token: string;
  source: TokenSource;
};

/**
 * Permissions requested for a GitHub App installation token. Kept narrow: the
 * action needs to read the issue/PR, comment on it, and push a branch.
 */
const DEFAULT_PERMISSIONS: Record<string, string> = {
  contents: "write",
  pull_requests: "write",
  issues: "write",
};

/**
 * Parses the `additional_permissions` input (newline-separated `key: value`
 * pairs, e.g. `actions: read`) and merges it over the defaults.
 */
export function parseAdditionalPermissions(
  raw: string | undefined,
): Record<string, string> {
  const permissions = { ...DEFAULT_PERMISSIONS };
  if (!raw?.trim()) {
    return permissions;
  }

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const separator = trimmed.indexOf(":");
    if (separator === -1) {
      core.warning(
        `Ignoring malformed additional_permissions entry: "${trimmed}" (expected "key: value")`,
      );
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (key && value) {
      permissions[key] = value;
    }
  }

  return permissions;
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Builds a short-lived app JWT (RS256), as required to call the App endpoints.
 * `iat` is backdated 60s to tolerate clock skew between the runner and GitHub.
 */
export function createAppJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }),
  );

  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const signature = base64url(signer.sign(privateKey.replace(/\\n/g, "\n")));

  return `${header}.${payload}.${signature}`;
}

async function githubJson(
  path: string,
  init: { method: string; token: string; body?: unknown },
): Promise<unknown> {
  const response = await fetch(`${GITHUB_API_URL}${path}`, {
    method: init.method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${init.token}`,
      "x-github-api-version": "2022-11-28",
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `GitHub API ${init.method} ${path} failed with ${response.status}: ${text}`,
    );
  }

  return text ? JSON.parse(text) : {};
}

/**
 * Exchanges a GitHub App's credentials for an installation access token scoped
 * to the current repository.
 */
export async function exchangeForAppToken(
  appId: string,
  privateKey: string,
  permissions: Record<string, string>,
): Promise<string> {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) {
    throw new Error(
      "GITHUB_REPOSITORY is not set; cannot resolve the app installation",
    );
  }
  const [owner, repo] = repository.split("/");

  const jwt = createAppJwt(appId, privateKey);

  const installation = (await githubJson(
    `/repos/${owner}/${repo}/installation`,
    { method: "GET", token: jwt },
  )) as { id?: number };

  if (!installation.id) {
    throw new Error(
      `GitHub App ${appId} does not appear to be installed on ${repository}`,
    );
  }

  const result = (await githubJson(
    `/app/installations/${installation.id}/access_tokens`,
    {
      method: "POST",
      token: jwt,
      body: { permissions, repositories: [repo] },
    },
  )) as { token?: string };

  if (!result.token) {
    throw new Error("GitHub App token exchange returned no token");
  }

  return result.token;
}

/**
 * Resolves the GitHub token to use for the run, in priority order:
 *
 *   1. the `github_token` input, if provided;
 *   2. a GitHub App installation token, if `github_app_id` and
 *      `github_app_private_key` are provided;
 *   3. `${{ github.token }}`, the workflow's own token.
 *
 * App tokens are minted here and revoked by the action's post step, so they
 * live only as long as the job.
 */
export async function setupGitHubToken(): Promise<ResolvedToken> {
  const providedToken = process.env.OVERRIDE_GITHUB_TOKEN;
  if (providedToken) {
    core.info("Using the github_token provided as an input");
    return { token: providedToken, source: "input" };
  }

  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  if (appId && privateKey) {
    core.info(`Requesting an installation token for GitHub App ${appId}`);
    const permissions = parseAdditionalPermissions(
      process.env.ADDITIONAL_PERMISSIONS,
    );
    const token = await retryWithBackoff(() =>
      exchangeForAppToken(appId, privateKey, permissions),
    );
    core.setSecret(token);
    return { token, source: "app" };
  }

  if (appId || privateKey) {
    throw new Error(
      "github_app_id and github_app_private_key must be provided together",
    );
  }

  const workflowToken = process.env.DEFAULT_WORKFLOW_TOKEN;
  if (workflowToken) {
    core.info("Using the workflow's github.token");
    return { token: workflowToken, source: "workflow" };
  }

  throw new Error(
    "No GitHub token available. Provide `github_token`, or a GitHub App via `github_app_id` + `github_app_private_key`.",
  );
}
