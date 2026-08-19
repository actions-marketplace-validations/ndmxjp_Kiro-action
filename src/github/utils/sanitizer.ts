/**
 * Sanitization helpers for untrusted GitHub content (issue/PR bodies, comments,
 * review bodies) before it is embedded in a prompt, and for redacting
 * credentials out of anything we write back to GitHub or to disk.
 *
 * Ported from anthropics/claude-code-action (src/github/utils/sanitizer.ts).
 */

export function stripInvisibleCharacters(content: string): string {
  // Zero-width characters and BOM
  content = content.replace(/[\u200B\u200C\u200D\uFEFF]/g, "");
  // C0/C1 control characters (tabs and newlines intentionally preserved)
  content = content.replace(
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g,
    "",
  );
  // Soft hyphen
  content = content.replace(/\u00AD/g, "");
  // Bidirectional overrides / isolates
  content = content.replace(/[\u202A-\u202E\u2066-\u2069]/g, "");
  return content;
}

export function stripMarkdownImageAltText(content: string): string {
  // Inline images: ![alt](url) -> ![](url)
  content = content.replace(/!\[[^\]]*\]\(/g, "![](");
  // Reference-style images: ![alt][ref] -> ![][ref] (keep the label, drop the
  // alt text, which is otherwise a hidden-instruction channel just like the
  // inline form above).
  content = content.replace(/!\[[^\]]*\](\[[^\]]*\])/g, "![]$1");
  return content;
}

export function stripMarkdownLinkTitles(content: string): string {
  content = content.replace(/(\[[^\]]*\]\([^)]+)\s+"[^"]*"/g, "$1");
  content = content.replace(/(\[[^\]]*\]\([^)]+)\s+'[^']*'/g, "$1");
  return content;
}

export function stripHiddenAttributes(content: string): string {
  // Quoted values are matched per quote type so that a value containing the
  // other quote character (e.g. an apostrophe inside a double-quoted value)
  // does not terminate the match early and mangle surrounding content.
  const attributeNames = [
    "alt",
    "title",
    "aria-label",
    "data-[a-zA-Z0-9-]+",
    "placeholder",
  ];
  for (const name of attributeNames) {
    const prefix = `\\s${name}\\s*=\\s*`;
    content = content.replace(new RegExp(`${prefix}"[^"]*"`, "gi"), "");
    content = content.replace(new RegExp(`${prefix}'[^']*'`, "gi"), "");
    content = content.replace(new RegExp(`${prefix}[^\\s>]+`, "gi"), "");
  }
  return content;
}

export function normalizeHtmlEntities(content: string): string {
  content = content.replace(/&#(\d+);/g, (_, dec) => {
    const num = parseInt(dec, 10);
    if (num >= 32 && num <= 126) {
      return String.fromCharCode(num);
    }
    return "";
  });
  content = content.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
    const num = parseInt(hex, 16);
    if (num >= 32 && num <= 126) {
      return String.fromCharCode(num);
    }
    return "";
  });
  return content;
}

export const stripHtmlComments = (content: string) =>
  content.replace(/<!--[\s\S]*?-->/g, "");

export function sanitizeContent(content: string): string {
  content = stripHtmlComments(content);
  content = stripInvisibleCharacters(content);
  content = stripMarkdownImageAltText(content);
  content = stripMarkdownLinkTitles(content);
  content = stripHiddenAttributes(content);
  content = normalizeHtmlEntities(content);
  content = redactGitHubTokens(content);
  return content;
}

export function redactGitHubTokens(content: string): string {
  // Classic PATs (ghp_), OAuth (gho_), user-to-server (ghu_),
  // installation (ghs_) and refresh (ghr_) tokens: prefix + 36 chars.
  content = content.replace(
    /gh[porsu]_[A-Za-z0-9]{36}\b/g,
    "[REDACTED_GITHUB_TOKEN]",
  );

  // Fine-grained personal access tokens (up to 255 chars total)
  content = content.replace(
    /github_pat_[A-Za-z0-9_]{11,221}\b/g,
    "[REDACTED_GITHUB_TOKEN]",
  );

  return content;
}

/**
 * Redact well-known credential formats (GitHub, AWS, Anthropic, Slack, JWTs)
 * from arbitrary text. Callers don't need to know which vendor a value belongs to.
 *
 * Vendor-prefixed formats are matched without a leading word boundary: the
 * prefix already anchors them, and runtime output frequently puts a word
 * character directly against the value (e.g. an ANSI color code ending in `m`,
 * or a serialized JSON escape such as `\n`).
 */
export function redactSecrets(content: string): string {
  content = redactGitHubTokens(content);

  // AWS access key ids: AKIA/ASIA followed by 16 uppercase alphanumerics. All
  // uppercase alphanumeric, so keep a leading boundary to avoid matching inside
  // larger blobs; also treat a JSON escape or ANSI color code as a boundary.
  content = content.replace(
    /(?:\b|(?<=\\(?:[nrtbf"\\/]|u[0-9a-fA-F]{4}))|(?<=\[[0-9;]*m))(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    "[REDACTED_AWS_KEY_ID]",
  );

  // Kiro API keys: ksk_... (prefix documented at
  // kiro.dev/docs/getting-started/authentication). This is the credential this
  // action is handed, so it is the one most likely to be within a run's reach.
  content = content.replace(/ksk_[A-Za-z0-9_-]{8,}/g, "[REDACTED_API_KEY]");

  // Anthropic API keys: sk-ant-...
  content = content.replace(/sk-ant-[A-Za-z0-9_-]{20,}/g, "[REDACTED_API_KEY]");

  // Slack tokens: xoxb-, xoxp-, xoxa-, xoxs-, xoxr-
  content = content.replace(
    /xox[abpsr]-[A-Za-z0-9-]{10,}/g,
    "[REDACTED_SLACK_TOKEN]",
  );

  // JWT-shaped strings: three base64url segments, the first two starting
  // with eyJ (base64 of `{"`).
  content = content.replace(
    /eyJ[A-Za-z0-9_-]{10,2000}\.eyJ[A-Za-z0-9_-]{10,4000}\.[A-Za-z0-9_-]{10,2000}\b/g,
    "[REDACTED_JWT]",
  );

  return content;
}

const ENV_SECRET_NAMES = [
  "KIRO_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "OVERRIDE_GITHUB_TOKEN",
  "DEFAULT_WORKFLOW_TOKEN",
  "GITHUB_APP_PRIVATE_KEY",
];

/**
 * Redact literal secret values that we know about from the environment.
 *
 * Shape matching cannot be complete — a GHES token or a future key format will
 * not match — and GitHub's log masking does not apply to what we write to disk
 * or post to an issue. Values shorter than 8 characters are skipped because
 * redacting them would mangle unrelated text.
 */
export function redactEnvSecrets(content: string): string {
  for (const name of ENV_SECRET_NAMES) {
    const value = process.env[name];
    if (!value || value.length < 8) {
      continue;
    }
    content = content.split(value).join(`[REDACTED_${name}]`);
  }
  return content;
}

/** Redact both shape-matched credentials and known environment secret values. */
export function redactAllSecrets(content: string): string {
  return redactEnvSecrets(redactSecrets(content));
}
