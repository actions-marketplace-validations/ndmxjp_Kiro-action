import { describe, expect, test } from "bun:test";
import {
  actorMatchesPattern,
  parseActorFilter,
  shouldIncludeCommentByActor,
} from "../src/github/utils/actor-filter";
import { filterCommentsByActor } from "../src/github/data/fetcher";

describe("parseActorFilter", () => {
  test("splits and trims", () => {
    expect(parseActorFilter(" a , b ,, c ")).toEqual(["a", "b", "c"]);
  });

  test("returns nothing for an empty filter", () => {
    expect(parseActorFilter("   ")).toEqual([]);
  });
});

describe("actorMatchesPattern", () => {
  test("matches exactly", () => {
    expect(actorMatchesPattern("dependabot[bot]", "dependabot[bot]")).toBe(
      true,
    );
  });

  test("*[bot] matches any bot", () => {
    expect(actorMatchesPattern("renovate[bot]", "*[bot]")).toBe(true);
    expect(actorMatchesPattern("human", "*[bot]")).toBe(false);
  });
});

describe("shouldIncludeCommentByActor", () => {
  test("includes everything when there are no filters", () => {
    expect(shouldIncludeCommentByActor("anyone", [], [])).toBe(true);
  });

  test("exclusion wins over inclusion", () => {
    expect(
      shouldIncludeCommentByActor("bot[bot]", ["bot[bot]"], ["*[bot]"]),
    ).toBe(false);
  });

  test("an include list is an allowlist", () => {
    expect(shouldIncludeCommentByActor("other", ["me"], [])).toBe(false);
    expect(shouldIncludeCommentByActor("me", ["me"], [])).toBe(true);
  });
});

describe("filterCommentsByActor", () => {
  const comments = [
    { author: { login: "human" } },
    { author: { login: "renovate[bot]" } },
    { author: null },
  ];

  test("returns everything when no filters are set", () => {
    expect(filterCommentsByActor(comments)).toHaveLength(3);
  });

  test("excludes bots without dereferencing a deleted author", () => {
    expect(filterCommentsByActor(comments, "", "*[bot]")).toEqual([
      { author: { login: "human" } },
      { author: null },
    ]);
  });

  test("treats a deleted author as 'ghost'", () => {
    expect(filterCommentsByActor(comments, "", "ghost")).toEqual([
      { author: { login: "human" } },
      { author: { login: "renovate[bot]" } },
    ]);
  });
});
