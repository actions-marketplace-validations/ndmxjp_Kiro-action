import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * Guards against manifest mistakes that only surface when a runner loads
 * action.yml, which no unit test would otherwise reach.
 *
 * The motivating bug: `${{ secrets.KIRO_API_KEY }}` in an input *description*.
 * The runner parses expressions in descriptions too, and the `secrets` context
 * does not exist in an action manifest, so the whole manifest failed to load
 * with "Unrecognized named-value: 'secrets'".
 */
const manifest = readFileSync(
  join(import.meta.dir, "..", "action.yml"),
  "utf8",
);

/** Lines that are entirely a YAML comment carry no expressions. */
const significantLines = manifest
  .split("\n")
  .filter((line) => !/^\s*#/.test(line));

const expressions = significantLines
  .flatMap((line) => [...line.matchAll(/\$\{\{(.+?)\}\}/g)])
  .map((match) => (match[1] ?? "").trim());

// Contexts an action manifest may reference. `secrets`, `vars`, and `needs`
// are workflow-only and fail manifest validation.
const ALLOWED_CONTEXTS = [
  "inputs",
  "steps",
  "github",
  "runner",
  "env",
  "job",
  "strategy",
  "matrix",
  "hashFiles",
  "always",
  "success",
  "failure",
  "cancelled",
  "format",
  "toJson",
  "fromJson",
];

describe("action.yml", () => {
  test("contains expressions at all (the scan is not vacuous)", () => {
    expect(expressions.length).toBeGreaterThan(10);
  });

  test("references no workflow-only context", () => {
    const offenders = expressions.filter((expression) =>
      /\b(secrets|vars|needs)\./.test(expression),
    );
    expect(offenders).toEqual([]);
  });

  test("every expression starts with a context valid in a manifest", () => {
    const offenders = expressions.filter((expression) => {
      const root = expression.match(/^([A-Za-z_][A-Za-z0-9_]*)/)?.[1];
      return !root || !ALLOWED_CONTEXTS.includes(root);
    });
    expect(offenders).toEqual([]);
  });

  test("every referenced input is declared", () => {
    const declared = new Set<string>();
    let inInputs = false;
    for (const line of significantLines) {
      if (/^inputs:\s*$/.test(line)) {
        inInputs = true;
        continue;
      }
      if (/^[a-z]+:\s*$/.test(line)) {
        inInputs = false;
        continue;
      }
      const name = inInputs ? line.match(/^ {2}([a-z0-9_]+):\s*$/)?.[1] : null;
      if (name) {
        declared.add(name);
      }
    }

    expect(declared.size).toBeGreaterThan(10);
    expect(declared.has("kiro_api_key")).toBe(true);

    const referenced = new Set(
      expressions
        .map((expression) => expression.match(/^inputs\.([a-z0-9_]+)/)?.[1])
        .filter((name): name is string => Boolean(name)),
    );

    const undeclared = [...referenced].filter((name) => !declared.has(name));
    expect(undeclared).toEqual([]);
  });

  test("every step output read by outputs: comes from the run step", () => {
    const stepIds = new Set(
      significantLines
        .map((line) => line.match(/^\s+id:\s*([A-Za-z0-9_-]+)\s*$/)?.[1])
        .filter((id): id is string => Boolean(id)),
    );

    const referencedSteps = new Set(
      expressions
        .map((expression) => expression.match(/^steps\.([A-Za-z0-9_-]+)/)?.[1])
        .filter((id): id is string => Boolean(id)),
    );

    const unknown = [...referencedSteps].filter((id) => !stepIds.has(id));
    expect(unknown).toEqual([]);
  });
});
