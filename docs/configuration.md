# Configuration

## Inputs

### Credentials

| Input                    | Default               | Notes                                                                                                                                                                                                  |
| ------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `kiro_api_key`           | —                     | **Required.** The Kiro CLI's only non-interactive credential. Pass it from a secret.                                                                                                                   |
| `github_token`           | `${{ github.token }}` | Identity the action acts as: comments, commits, pushes. Provide a PAT if you want commits attributed to a person, or if pushes must trigger other workflows (the default token deliberately does not). |
| `github_app_id`          | `""`                  | Set with `github_app_private_key` to mint a short-lived installation token instead.                                                                                                                    |
| `github_app_private_key` | `""`                  | PEM private key for that app. Store it as a secret.                                                                                                                                                    |
| `additional_permissions` | `""`                  | Extra scopes for the app token, as newline-separated `key: value` pairs. Defaults are `contents: write`, `pull_requests: write`, `issues: write`.                                                      |

When a GitHub App token is minted, the action revokes it in a post step, so it is
valid only for the duration of the job.

### What to run

| Input                 | Default | Notes                                                                                                                                                            |
| --------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt`              | `""`    | Instructions. Providing this selects agent mode.                                                                                                                 |
| `custom_instructions` | `""`    | Appended to the tag-mode prompt as `<custom_instructions>`. Use it for standing rules ("always run the linter", "never touch the migrations directory").         |
| `trigger_phrase`      | `@kiro` | Matched as a standalone token, case-insensitively, in issue and PR bodies and titles, comments, and review bodies. `@kirodotdev` and `me@kiro.dev` do not match. |
| `assignee_trigger`    | `""`    | Username whose assignment starts a run. A leading `@` is optional.                                                                                               |
| `label_trigger`       | `kiro`  | Label whose addition starts a run. Compared case-insensitively.                                                                                                  |
| `track_progress`      | `false` | Forces tag mode even when `prompt` is set: you get the tracking comment and the fixed prompt. Only valid for issue and pull request events.                      |

### Branching

| Input                  | Default      | Notes                                                                                                                                                                                                                                           |
| ---------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `base_branch`          | repo default | Branch new work starts from.                                                                                                                                                                                                                    |
| `branch_prefix`        | `kiro/`      | Prefix for created branches.                                                                                                                                                                                                                    |
| `branch_name_template` | `""`         | Template with `{{prefix}}`, `{{entityType}}`, `{{entityNumber}}`, `{{timestamp}}`, `{{sha}}`, `{{label}}`, `{{description}}`. Falls back to `<prefix><type>-<number>-<timestamp>` if it renders empty or the name already exists on the remote. |

On an **open pull request** no branch is created: the PR branch is checked out and
pushed to. On an **issue** or a **closed/merged PR** a new branch is created from
`base_branch`. If nothing was committed to it, the branch is deleted at the end of
the run.

### Kiro CLI behaviour

| Input                    | Default | Notes                                                                                                 |
| ------------------------ | ------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `effort`                 | `""`    | `low`, `medium`, `high`, `xhigh`, `max`. Passed as `--effort`.                                        |
| `model`                  | `""`    | Recorded as `model` in the generated agent config.                                                    |
| `allowed_tools`          | `""`    | Comma-separated extra tool names, e.g. `web_search`, or `@my_server` for every tool of an MCP server. |
| `allowed_shell_commands` | `""`    | Comma-separated extra shell patterns, e.g. `bun test *,bun run build`.                                |
| `trust_all_tools`        | `false` | Passes `--trust-all-tools`. Removes tool gating entirely — see [security.md](security.md).            |
| `kiro_args`              | `""`    | Extra arguments appended to `kiro-cli chat`. Parsed into argv; shell operators (`&&`, `;`, `          | `) are rejected because nothing here goes through a shell. |
| `timeout_minutes`        | `""`    | Sends `SIGTERM` after this many minutes, then `SIGKILL` ten seconds later.                            |

### Filtering and identity

| Input                       | Default                           | Notes                                                                                                                             |
| --------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `allowed_bots`              | `""`                              | Comma-separated bot usernames allowed to trigger a run, or `*` for all. Bots cannot trigger runs otherwise.                       |
| `include_comments_by_actor` | `""`                              | Allowlist of comment authors to include in the prompt. `*[bot]` matches every bot. Empty means include everyone.                  |
| `exclude_comments_by_actor` | `""`                              | Denylist of comment authors. Exclusion wins over inclusion. Useful for muting noisy CI bots.                                      |
| `bot_id`, `bot_name`        | `41898282`, `github-actions[bot]` | Used for `user.name`/`user.email` on commits. Change these when using a PAT or an app so commits are attributed to that identity. |

### Runtime

| Input                         | Default | Notes                                                                                                                             |
| ----------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `path_to_kiro_cli_executable` | `""`    | Use an existing binary instead of installing. This is the way to pin a CLI version; the install script always fetches the latest. |
| `path_to_bun_executable`      | `""`    | Use an existing Bun instead of installing one.                                                                                    |
| `display_report`              | `true`  | Append the CLI output to the job summary.                                                                                         |

## Outputs

| Output             | Notes                                                                |
| ------------------ | -------------------------------------------------------------------- |
| `conclusion`       | `success` or `failure`.                                              |
| `contains_trigger` | `false` means no trigger matched and nothing ran.                    |
| `execution_file`   | Path to the captured CLI output (secrets redacted).                  |
| `branch_name`      | The branch this run created, if any.                                 |
| `comment_id`       | Id of the tracking comment, in tag mode.                             |
| `github_token`     | The token the run used, so later steps can act as the same identity. |

## How tools are granted

The Kiro CLI has no `--mcp-config` flag, so the action writes a custom agent
config to `~/.kiro/agents/kiro-action.json` and runs
`kiro-cli chat --no-interactive --agent kiro-action`. That file carries the MCP
servers and the tool list for the run.

It is written to the home directory rather than the repository's `.kiro/agents/`
on purpose: the checkout is untrusted on a pull request, and a file inside it
would also be swept up by the `git add -A` this action makes later.

Granted by default:

- `fs_read`, `grep`, `glob` — reading and searching.
- `fs_write`, `code` — file editing.
- Every tool of the MCP servers the action starts:
  - `github_comment` (tag mode) — `update_kiro_comment`, which rewrites the
    tracking comment. This is the only way Kiro can say anything to a human.
  - `github_ci` (tag mode, pull requests, requires `actions: read`) —
    `get_ci_status`, `get_workflow_run_details`, `download_job_log`.

**No shell.** The agent cannot run git, tests, or anything else. In headless mode
the CLI's tool trust is all-or-nothing — granting `git add` also grants `curl` —
so this action grants no shell and commits and pushes on the agent's behalf after
the run. It asks the agent to leave a commit message in a file under
`$RUNNER_TEMP`; if none is there, a generated subject is used. The measurements
behind this are in [security.md](security.md).

If `actions: read` is missing from the job's `permissions`, the CI server is
skipped with a warning rather than failing the run.

## Choosing an engine

|                                 | `agent_engine: v2` (default) | `agent_engine: v3`   |
| ------------------------------- | ---------------------------- | -------------------- |
| Tracking comment (MCP)          | works                        | **does not work**    |
| `allowed_shell_commands`        | ignored                      | enforced per command |
| Writes confined to the checkout | no                           | yes                  |

Use the default for anything that reports back to an issue or pull request. Use
`v3` for agent-mode automation that needs to run commands:

```yaml
with:
  kiro_api_key: ${{ secrets.KIRO_API_KEY }}
  agent_engine: v3
  allowed_shell_commands: "bun install,bun test *,bun run lint"
  prompt: |
    Fix the failing tests. Run `bun test` to check your work.
```

`curl`, `wget`, `sudo`, `rm -rf`, `nc`, and `ssh` are denied on v3 regardless of
what `allowed_shell_commands` says, because a deny rule outranks an allow rule.

## Custom MCP servers

There is no input for extra MCP servers yet. Two workarounds:

1. Point the CLI at your own agent config with
   `kiro_args: --agent /path/to/agent.json`, which overrides the generated one
   (you then also own the tool and permission lists).
2. On a repository that does not take pull requests from strangers, commit
   `.kiro/agents/<name>.json` and select it the same way.

Note that the generated config sets `includeMcpJson: false`, so a repository's
`.kiro/settings/mcp.json` is deliberately _not_ merged.
