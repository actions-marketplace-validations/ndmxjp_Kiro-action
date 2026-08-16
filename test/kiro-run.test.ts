import { describe, expect, test } from "bun:test";
import { stripAnsi } from "../src/kiro/run";

const ESC = "\u001B";

describe("stripAnsi", () => {
  test("removes colour and reset sequences", () => {
    expect(stripAnsi(`${ESC}[32mgreen${ESC}[0m`)).toBe("green");
  });

  test("removes cursor hide/show sequences", () => {
    expect(stripAnsi(`${ESC}[?25lworking${ESC}[?25h`)).toBe("working");
  });

  test("removes 256-colour sequences", () => {
    expect(stripAnsi(`${ESC}[38;5;244m244 bytes${ESC}[0m`)).toBe("244 bytes");
  });

  test("removes cursor movement sequences", () => {
    expect(stripAnsi(`${ESC}[1Gline${ESC}[2K`)).toBe("line");
  });

  test("leaves ordinary text, newlines, and tabs untouched", () => {
    expect(stripAnsi("plain\n\ttext ✓")).toBe("plain\n\ttext ✓");
  });

  test("clears a real captured line from the Kiro CLI", () => {
    // Taken verbatim from a smoke-test run's execution file.
    const captured = `${ESC}[m ✓ ${ESC}[0mSuccessfully read ${ESC}[38;5;244m163 bytes${ESC}[0m from /tmp/package.json`;
    const stripped = stripAnsi(captured);

    expect(stripped).toBe(
      " ✓ Successfully read 163 bytes from /tmp/package.json",
    );
    expect(stripped).not.toContain(ESC);
  });
});
