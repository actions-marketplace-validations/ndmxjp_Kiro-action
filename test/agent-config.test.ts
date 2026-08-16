import { describe, expect, test } from "bun:test";
import { buildAgentConfig, GIT_PUSH_WRAPPER } from "../src/kiro/agent-config";
import { parseAdditionalPermissions } from "../src/github/token";

const mcpServers = {
  github_comment: { command: "bun", args: ["run", "server.ts"] },
};

describe("buildAgentConfig", () => {
  test("grants the MCP servers it was given, and never merges repo MCP config", () => {
    const config = buildAgentConfig({
      mode: "tag",
      mcpServers,
      extraTools: "",
      extraShellCommands: "",
      model: "",
      systemPrompt: "be helpful",
    });

    expect(config.tools).toContain("@github_comment");
    expect(config.allowedTools).toContain("@github_comment");
    expect(config.includeMcpJson).toBe(false);
    expect(config.mcpServers).toBe(mcpServers);
  });

  test("does not blanket-allow the shell capability", () => {
    const config = buildAgentConfig({
      mode: "tag",
      mcpServers,
      extraTools: "",
      extraShellCommands: "",
      model: "",
      systemPrompt: "",
    });

    expect(config.tools).toContain("shell");
    expect(config.allowedTools).not.toContain("shell");
  });

  test("allows the push wrapper but not a bare git push", () => {
    const config = buildAgentConfig({
      mode: "tag",
      mcpServers,
      extraTools: "",
      extraShellCommands: "",
      model: "",
      systemPrompt: "",
    });

    const shellRule = config.permissions.rules.find(
      (rule) => rule.capability === "shell",
    );
    expect(shellRule?.effect).toBe("allow");
    expect(shellRule?.match).toContain(`${GIT_PUSH_WRAPPER} *`);
    expect(shellRule?.match).not.toContain("git push *");
  });

  test("appends extra tools and shell patterns from inputs", () => {
    const config = buildAgentConfig({
      mode: "agent",
      mcpServers: {},
      extraTools: "web_search, @other",
      extraShellCommands: "bun test *, bun run build",
      model: "some-model",
      systemPrompt: "",
    });

    expect(config.tools).toContain("web_search");
    expect(config.allowedTools).toContain("@other");
    expect(config.model).toBe("some-model");

    const shellRule = config.permissions.rules[0];
    expect(shellRule?.match).toContain("bun test *");
    expect(shellRule?.match).toContain("bun run build");
  });

  test("omits the model key when no model is configured", () => {
    const config = buildAgentConfig({
      mode: "agent",
      mcpServers: {},
      extraTools: "",
      extraShellCommands: "",
      model: "",
      systemPrompt: "",
    });

    expect("model" in config).toBe(false);
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
