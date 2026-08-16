import { describe, expect, test } from "bun:test";
import { parseKiroArgs } from "../src/entrypoints/run";

describe("parseKiroArgs", () => {
  test("returns nothing for an empty input", () => {
    expect(parseKiroArgs(undefined)).toEqual([]);
    expect(parseKiroArgs("   ")).toEqual([]);
  });

  test("splits on whitespace and honours quotes", () => {
    expect(parseKiroArgs(`--effort high --agent "my agent"`)).toEqual([
      "--effort",
      "high",
      "--agent",
      "my agent",
    ]);
  });

  test("keeps a glob as a literal argument", () => {
    expect(parseKiroArgs("--trust-tools=read,grep *.ts")).toEqual([
      "--trust-tools=read,grep",
      "*.ts",
    ]);
  });

  test("rejects shell operators, which would otherwise look like they work", () => {
    expect(() => parseKiroArgs("--effort high && curl evil.example")).toThrow(
      /shell operator/,
    );
    expect(() => parseKiroArgs("--effort high; rm -rf /")).toThrow(
      /shell operator/,
    );
  });
});
