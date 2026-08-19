#!/usr/bin/env node
/**
 * Bundles the action into dist/ so a run needs nothing but the runner's own
 * Node: no Bun to install, no dependency resolution against a registry, and the
 * bytes that execute are the bytes committed at that tag.
 *
 * Three entry points, because the MCP servers run as separate processes that the
 * Kiro CLI starts by command line (see src/mcp/prepare-mcp-config.ts).
 *
 *   bun run build          write dist/
 *   bun run build:check    fail if dist/ is stale (used by CI)
 */

import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";

const ENTRY_POINTS = {
  // The action itself. action.yml invokes this one.
  "index.mjs": "src/entrypoints/main.ts",
  "mcp/github-comment-server.mjs": "src/mcp/github-comment-server.ts",
  "mcp/github-actions-server.mjs": "src/mcp/github-actions-server.ts",
};

const check = process.argv.includes("--check");

rmSync("dist", { recursive: true, force: true });

for (const [outfile, entry] of Object.entries(ENTRY_POINTS)) {
  await build({
    entryPoints: [entry],
    outfile: `dist/${outfile}`,
    bundle: true,
    platform: "node",
    // The runner's Node, measured at v22.23.2 on ubuntu-latest, not the newest
    // release. CI prints the version so this stays honest.
    target: "node22",
    format: "esm",
    // Minified: a bundle diff is unreadable either way, so the tradeoff is only
    // about how much generated data lands in git on every dependency bump.
    // 3.0 MB unminified against 1.6 MB minified, measured.
    minify: true,
    sourcemap: false,
    legalComments: "none",
    // The MCP SDK and Octokit are ESM with dynamic requires in places; banner
    // gives the bundle a working `require` for those.
    banner: {
      js: [
        "import { createRequire as __createRequire } from 'node:module';",
        "const require = __createRequire(import.meta.url);",
      ].join("\n"),
    },
  });
  console.log(`built dist/${outfile}`);
}

if (check) {
  try {
    execFileSync("git", ["diff", "--exit-code", "--stat", "--", "dist"], {
      stdio: "inherit",
    });
    console.log("dist/ is up to date");
  } catch {
    console.error(
      "\ndist/ is stale: rebuild with `bun run build` and commit the result.",
    );
    process.exit(1);
  }
}
