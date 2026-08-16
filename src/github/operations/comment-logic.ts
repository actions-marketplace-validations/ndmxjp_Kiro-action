import { GITHUB_SERVER_URL } from "../api/config";
import { redactAllSecrets } from "../utils/sanitizer";
import { WORKING_PATTERN } from "./comments/common";

export type ExecutionDetails = {
  duration_ms?: number;
};

export type CommentUpdateInput = {
  currentBody: string;
  actionFailed: boolean;
  executionDetails: ExecutionDetails | null;
  jobUrl: string;
  branchLink?: string;
  prLink?: string;
  branchName?: string;
  triggerUsername?: string;
  errorDetails?: string;
};

export function ensureProperlyEncodedUrl(url: string): string | null {
  try {
    // If this parses, the URL is already usable; spaces still need encoding.
    new URL(url);
    if (url.includes(" ")) {
      const [baseUrl, queryString] = url.split("?");
      if (queryString) {
        const params = new URLSearchParams();
        for (const pair of queryString.split("&")) {
          const [key, value = ""] = pair.split("=");
          if (key) {
            // Decode first in case it is partially encoded, then re-encode.
            params.set(key, decodeURIComponent(value));
          }
        }
        return `${baseUrl}?${params.toString()}`;
      }
      return url.replace(/ /g, "%20");
    }
    return url;
  } catch {
    try {
      let fixedUrl = url.replace(/ /g, "%20");

      const urlParts = fixedUrl.split("?");
      if (urlParts.length > 1 && urlParts[1]) {
        const [baseUrl, queryString] = urlParts;
        const fixedQuery = queryString.replace(/([^%]|^):(?!%2F%2F)/g, "$1%3A");
        fixedUrl = `${baseUrl}?${fixedQuery}`;
      }

      new URL(fixedUrl);
      return fixedUrl;
    } catch {
      return null;
    }
  }
}

/**
 * Rewrites the tracking comment for the end of the run: replaces the "working"
 * marker with a result header, and re-attaches the job/branch/PR links.
 */
export function updateCommentBody(input: CommentUpdateInput): string {
  const {
    currentBody: originalBody,
    executionDetails,
    jobUrl,
    branchLink,
    prLink,
    actionFailed,
    branchName,
    triggerUsername,
    errorDetails,
  } = input;

  let bodyContent = originalBody.replace(WORKING_PATTERN, "").trim();

  // Preserve a "Create PR" link that a previous update already added.
  let prLinkFromContent = "";
  const prLinkPattern = /\[Create .* PR\]\((.*)\)$/m;
  const prLinkMatch = bodyContent.match(prLinkPattern);

  if (prLinkMatch && prLinkMatch[1]) {
    const encodedUrl = ensureProperlyEncodedUrl(prLinkMatch[1]);
    if (encodedUrl) {
      prLinkFromContent = encodedUrl;
      bodyContent = bodyContent.replace(prLinkMatch[0], "").trim();
    }
  }

  let durationStr = "";
  if (executionDetails?.duration_ms !== undefined) {
    const totalSeconds = Math.round(executionDetails.duration_ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    durationStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
  }

  let header: string;
  if (actionFailed) {
    header = "**Kiro encountered an error";
    if (durationStr) {
      header += ` after ${durationStr}`;
    }
    header += "**";
  } else {
    const usernameMatch = bodyContent.match(/@([a-zA-Z0-9-]+)/);
    const username =
      triggerUsername || (usernameMatch ? usernameMatch[1] : "user");

    header = `**Kiro finished @${username}'s task`;
    if (durationStr) {
      header += ` in ${durationStr}`;
    }
    header += "**";
  }

  let links = ` —— [View job](${jobUrl})`;

  if (branchName || branchLink) {
    let finalBranchName = branchName;
    let branchUrl = "";

    if (branchLink) {
      const urlMatch = branchLink.match(/\((https?:\/\/.*)\)/);
      if (urlMatch && urlMatch[1]) {
        branchUrl = urlMatch[1];
      }

      if (!finalBranchName) {
        const branchNameMatch = branchLink.match(/tree\/([^"'\)]+)/);
        if (branchNameMatch) {
          finalBranchName = branchNameMatch[1];
        }
      }
    }

    if (!branchUrl && finalBranchName) {
      const repoMatch = jobUrl.match(/\/([^\/]+)\/([^\/]+)\/actions\/runs\//);
      if (repoMatch) {
        branchUrl = `${GITHUB_SERVER_URL}/${repoMatch[1]}/${repoMatch[2]}/tree/${finalBranchName}`;
      }
    }

    if (finalBranchName && branchUrl) {
      links += ` • [\`${finalBranchName}\`](${branchUrl})`;
    } else if (finalBranchName) {
      links += ` • \`${finalBranchName}\``;
    }
  }

  const prUrl =
    prLinkFromContent || (prLink ? prLink.match(/\(([^)]+)\)/)?.[1] : "");
  if (prUrl) {
    links += ` • [Create PR ➔](${prUrl})`;
  }

  let newBody = `${header}${links}`;

  // Error text can embed runtime credentials (for example a token inside a git
  // remote URL) that are not registered as workflow secrets, so redact known
  // formats and known env values before posting.
  if (actionFailed && errorDetails) {
    newBody += `\n\n\`\`\`\n${redactAllSecrets(errorDetails)}\n\`\`\``;
  }

  newBody += `\n\n---\n`;

  // Drop the link lines the initial comment added; they are re-added above.
  bodyContent = bodyContent.replace(/\n?\[View job run\]\([^\)]+\)/g, "");
  bodyContent = bodyContent.replace(/\n?\[View branch\]\([^\)]+\)/g, "");
  bodyContent = bodyContent.replace(/\n*---\n*Duration: [0-9]+m? [0-9]+s/g, "");

  newBody += bodyContent;

  return newBody.trim();
}
