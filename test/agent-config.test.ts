import { describe, expect, test } from "bun:test";
import {
  buildAgentConfig,
  hasShellAccess,
  willGrantShell,
  type BuildAgentConfigParams,
} from "../src/kiro/agent-config";
import { parseAdditionalPermissions } from "../src/github/token";

const mcpServers = {
  github_comment: { command: "bun", args: ["run", "server.ts"] },
};

function config(overrides: Partial<BuildAgentConfigParams> = {}) {
  return buildAgentConfig({
    mode: "tag",
    engine: "v2",
    mcpServers,
    extraTools: "",
    extraShellCommands: "",
    model: "",
    systemPrompt: "be helpful",
    ...overrides,
  });
}

describe("buildAgentConfig on the v2 engine", () => {
  test("grants the MCP servers it was given, and never merges repo MCP config", () => {
    const built = config();

    expect(built.tools).toContain("@github_comment");
    expect(built.allowedTools).toContain("@github_comment");
    expect(built.includeMcpJson).toBe(false);
    expect(built.mcpServers).toBe(mcpServers);
  });

  test("grants read and write tools but no shell", () => {
    const built = config();

    expect(built.allowedTools).toContain("fs_read");
    expect(built.allowedTools).toContain("fs_write");
    expect(built.allowedTools).not.toContain("execute_bash");
    expect(hasShellAccess(built)).toBe(false);
  });

  test("emits no capability rules — v2 drops a config that carries them", () => {
    // Measured: passing a config with a `permissions` block to the v2 engine
    // produced "no agent with name ... found. Falling back to user specified
    // default", so the two schemas must never be mixed.
    expect(config().permissions).toBeUndefined();
  });

  test("does not merge mcp.json, which the checkout can control", () => {
    expect(config().includeMcpJson).toBe(false);
  });

  test("ignores allowed_shell_commands, because v2 cannot scope shell", () => {
    const built = config({ extraShellCommands: "bun test *" });

    expect(hasShellAccess(built)).toBe(false);
    expect(built.permissions).toBeUndefined();
  });

  test("still grants shell when a workflow names it in allowed_tools", () => {
    const built = config({ extraTools: "execute_bash" });

    expect(hasShellAccess(built)).toBe(true);
  });

  test("grants every tool it lists, since an ungranted tool cannot run headlessly", () => {
    const built = config({ extraTools: "web_search" });

    expect(built.tools).toEqual(built.allowedTools);
    expect(built.allowedTools).toContain("web_search");
  });
});

describe("buildAgentConfig on the v3 engine", () => {
  test("merges mcp.json, since v3 ignores servers in the agent profile", () => {
    expect(config({ engine: "v3" }).includeMcpJson).toBe(true);
  });

  test("allows this action's own MCP servers", () => {
    const rules = config({ engine: "v3" }).permissions?.rules ?? [];
    const mcp = rules.find((rule) => rule.capability === "mcp");

    expect(mcp).toEqual({
      capability: "mcp",
      match: ["github_comment/*"],
      effect: "allow",
    });
  });

  test("adds no mcp rule when there are no servers", () => {
    const rules =
      config({ engine: "v3", mcpServers: {} }).permissions?.rules ?? [];

    expect(rules.some((rule) => rule.capability === "mcp")).toBe(false);
  });

  test("confines writes to the checkout", () => {
    const rules = config({ engine: "v3" }).permissions?.rules ?? [];
    const write = rules.find((rule) => rule.capability === "fs_write");

    expect(write).toEqual({
      capability: "fs_write",
      match: ["./**"],
      effect: "allow",
    });
  });

  test("honours allowed_shell_commands and grants the shell tool", () => {
    const built = config({
      engine: "v3",
      extraShellCommands: "bun test *, git add *",
    });
    const rules = built.permissions?.rules ?? [];
    const allow = rules.find(
      (rule) => rule.capability === "shell" && rule.effect === "allow",
    );

    expect(allow?.match).toEqual(["bun test *", "git add *"]);
    expect(hasShellAccess(built)).toBe(true);
  });

  test("does not grant shell when no commands were allowed", () => {
    const built = config({ engine: "v3" });
    const rules = built.permissions?.rules ?? [];

    expect(hasShellAccess(built)).toBe(false);
    expect(
      rules.some(
        (rule) => rule.capability === "shell" && rule.effect === "allow",
      ),
    ).toBe(false);
  });

  test("always denies the dangerous commands, since deny outranks allow", () => {
    const rules =
      config({ engine: "v3", extraShellCommands: "bash *" }).permissions
        ?.rules ?? [];
    const deny = rules.find(
      (rule) => rule.capability === "shell" && rule.effect === "deny",
    );

    expect(deny?.match).toContain("curl *");
    expect(deny?.match).toContain("sudo *");
    expect(deny?.match).toContain("rm -rf *");
  });
});

describe("willGrantShell", () => {
  test("is false by default", () => {
    expect(
      willGrantShell({ engine: "v2", extraTools: "", extraShellCommands: "" }),
    ).toBe(false);
  });

  test("is true when shell is named in allowed_tools, on either engine", () => {
    for (const engine of ["v2", "v3"] as const) {
      expect(
        willGrantShell({
          engine,
          extraTools: "shell",
          extraShellCommands: "",
        }),
      ).toBe(true);
    }
  });

  test("is true on v3 with allowed shell commands, false on v2", () => {
    expect(
      willGrantShell({
        engine: "v3",
        extraTools: "",
        extraShellCommands: "bun test *",
      }),
    ).toBe(true);
    expect(
      willGrantShell({
        engine: "v2",
        extraTools: "",
        extraShellCommands: "bun test *",
      }),
    ).toBe(false);
  });
});

describe("parseAdditionalPermissions", () => {
  test("returns the defaults when nothing is configured", () => {
    expect(parseAdditionalPermissions(undefined)).toEqual({
      contents: "write",
      pull_requests: "write",
      issues: "write",
    });
  });

  test("merges configured permissions over the defaults", () => {
    expect(parseAdditionalPermissions("actions: read\ncontents: read")).toEqual(
      {
        contents: "read",
        pull_requests: "write",
        issues: "write",
        actions: "read",
      },
    );
  });

  test("ignores malformed lines", () => {
    expect(parseAdditionalPermissions("nonsense\n\nactions: read")).toEqual({
      contents: "write",
      pull_requests: "write",
      issues: "write",
      actions: "read",
    });
  });
});
