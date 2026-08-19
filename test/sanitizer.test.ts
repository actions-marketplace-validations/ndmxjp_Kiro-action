import { describe, expect, test } from "bun:test";
import {
  redactGitHubTokens,
  redactSecrets,
  sanitizeContent,
  stripHiddenAttributes,
  stripInvisibleCharacters,
  stripMarkdownImageAltText,
} from "../src/github/utils/sanitizer";

describe("stripInvisibleCharacters", () => {
  test("removes zero-width characters and bidi overrides", () => {
    expect(stripInvisibleCharacters("he​llo‮world")).toBe("helloworld");
  });

  test("keeps newlines and tabs", () => {
    expect(stripInvisibleCharacters("a\n\tb")).toBe("a\n\tb");
  });
});

describe("stripMarkdownImageAltText", () => {
  test("drops inline alt text, keeps the url", () => {
    expect(stripMarkdownImageAltText("![ignore me](https://x/y.png)")).toBe(
      "![](https://x/y.png)",
    );
  });

  test("drops reference alt text, keeps the label", () => {
    expect(stripMarkdownImageAltText("![ignore me][ref]")).toBe("![][ref]");
  });
});

describe("stripHiddenAttributes", () => {
  test("removes attributes that carry hidden text", () => {
    const input = `<img src="a.png" alt="do this" title='or this' data-x=that>`;
    expect(stripHiddenAttributes(input)).toBe(`<img src="a.png">`);
  });

  test("does not truncate a double-quoted value containing an apostrophe", () => {
    const input = `<img alt="it's fine" src="a.png">`;
    expect(stripHiddenAttributes(input)).toBe(`<img src="a.png">`);
  });
});

describe("sanitizeContent", () => {
  test("removes html comments", () => {
    expect(sanitizeContent("before<!-- hidden -->after")).toBe("beforeafter");
  });

  test("redacts tokens found in untrusted content", () => {
    const token = `ghp_${"a".repeat(36)}`;
    expect(sanitizeContent(`token: ${token}`)).toBe(
      "token: [REDACTED_GITHUB_TOKEN]",
    );
  });
});

describe("redactGitHubTokens", () => {
  test("redacts every documented token prefix", () => {
    for (const prefix of ["ghp", "gho", "ghu", "ghs", "ghr"]) {
      const token = `${prefix}_${"b".repeat(36)}`;
      expect(redactGitHubTokens(token)).toBe("[REDACTED_GITHUB_TOKEN]");
    }
  });

  test("redacts fine-grained tokens", () => {
    expect(redactGitHubTokens(`github_pat_${"c".repeat(30)}`)).toBe(
      "[REDACTED_GITHUB_TOKEN]",
    );
  });
});

describe("redactSecrets", () => {
  test("redacts an AWS access key id even next to an ANSI colour code", () => {
    expect(redactSecrets("[32mAKIAIOSFODNN7EXAMPLE")).toBe(
      "[32m[REDACTED_AWS_KEY_ID]",
    );
  });

  test("redacts a JWT", () => {
    const jwt = `eyJ${"a".repeat(20)}.eyJ${"b".repeat(20)}.${"c".repeat(20)}`;
    expect(redactSecrets(jwt)).toBe("[REDACTED_JWT]");
  });

  test("redacts a Kiro API key", () => {
    expect(redactSecrets(`key=ksk_${"a".repeat(32)}`)).toBe(
      "key=[REDACTED_API_KEY]",
    );
  });

  test("leaves ordinary text alone", () => {
    expect(redactSecrets("nothing secret here")).toBe("nothing secret here");
  });
});
