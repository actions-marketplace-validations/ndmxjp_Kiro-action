import { describe, expect, test } from "bun:test";
import { validateBranchName } from "../src/github/operations/branch";
import { generateBranchName } from "../src/utils/branch-template";

describe("validateBranchName", () => {
  const valid = [
    "main",
    "kiro/issue-12-20260101-1200",
    "_release/v1.2.3",
    "fix/#123-thing",
    "feature/paris,france",
    "TICKET-1@add-feature",
  ];

  for (const name of valid) {
    test(`accepts ${name}`, () => {
      expect(() => validateBranchName(name)).not.toThrow();
    });
  }

  const invalid = [
    "",
    "-x",
    "--upload-pack=sh",
    "a branch",
    "a~b",
    "a^b",
    "a:b",
    "a?b",
    "a*b",
    "a[b",
    "a\\b",
    ".hidden",
    "trailing.",
    "trailing/",
    "double//slash",
    "dot..dot",
    "ref.lock",
    "ref@{1}",
    "@",
  ];

  for (const name of invalid) {
    test(`rejects ${JSON.stringify(name)}`, () => {
      expect(() => validateBranchName(name)).toThrow();
    });
  }
});

describe("generateBranchName", () => {
  test("uses the default format when no template is given", () => {
    const name = generateBranchName(undefined, "kiro/", "issue", 42);
    expect(name).toMatch(/^kiro\/issue-42-\d{8}-\d{4}$/);
  });

  test("truncates the default format to 50 characters", () => {
    const name = generateBranchName(undefined, "a".repeat(60), "issue", 1);
    expect(name.length).toBe(50);
  });

  test("substitutes template variables", () => {
    const name = generateBranchName(
      "{{prefix}}{{entityType}}/{{entityNumber}}-{{description}}",
      "kiro/",
      "issue",
      7,
      "abcdef1234567890",
      undefined,
      "Fix the flaky login test please",
    );
    expect(name).toBe("kiro/issue/7-fix-the-flaky-login-test");
  });

  test("collapses segments left empty by a template variable", () => {
    const name = generateBranchName(
      "{{prefix}}{{description}}/{{entityNumber}}",
      "kiro/",
      "issue",
      9,
      undefined,
      undefined,
      "🎉",
    );
    expect(name).toBe("kiro/9");
    expect(() => validateBranchName(name)).not.toThrow();
  });

  test("falls back to the default format when the template resolves to nothing", () => {
    const name = generateBranchName("{{description}}", "kiro/", "issue", 3);
    expect(name).toMatch(/^kiro\/issue-3-\d{8}-\d{4}$/);
  });

  test("sanitizes a scoped label", () => {
    const name = generateBranchName(
      "{{prefix}}{{label}}-{{entityNumber}}",
      "kiro/",
      "issue",
      5,
      undefined,
      "area:permissions",
    );
    expect(name).toBe("kiro/area-permissions-5");
  });
});
