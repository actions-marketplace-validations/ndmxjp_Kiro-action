# Kiro Action

Run the [Kiro CLI](https://kiro.dev) on GitHub issues and pull requests. Mention
`@kiro` in a comment and it reads the thread, works in a branch, and reports back
by editing a single tracking comment.

<!-- prettier-ignore -->
> [!IMPORTANT]
> **Unofficial community project.** This action is not affiliated with, sponsored
> by, or endorsed by Amazon Web Services. "Kiro" and "Amazon Web Services" are
> trademarks of Amazon.com, Inc. or its affiliates. It is a port of
> [anthropics/claude-code-action](https://github.com/anthropics/claude-code-action)
> (MIT) to the Kiro CLI.
>
> The Kiro project publishes its own action at
> [kirodotdev-labs/kiro-action](https://github.com/kirodotdev-labs/kiro-action),
> which covers the same ground. If you want the one closest to the Kiro project,
> use that. This one exists to carry over claude-code-action's hardening: content
> pinned to trigger time, prompt-injection stripping, CLI-executed config restored
> from the base branch on pull requests, a shell scoped to named commands, writes
> confined to the checkout, and commits made by the action rather than by the
> model.

## Quick start

Add `KIRO_API_KEY` to your repository secrets, then create
`.github/workflows/kiro.yml`:

```yaml
name: Kiro

on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
  issues:
    types: [opened, labeled, assigned]

jobs:
  kiro:
    # Skip the job entirely unless the trigger phrase is present, so the runner
    # is not started for every comment in the repository.
    if: |
      contains(github.event.comment.body, '@kiro') ||
      contains(github.event.issue.body, '@kiro') ||
      github.event.action == 'labeled' ||
      github.event.action == 'assigned'
    runs-on: ubuntu-latest
    permissions:
      contents: write
      issues: write
      pull-requests: write
      actions: read # optional: lets Kiro read CI results on a PR
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0

      - uses: ndmxjp/Kiro-action@v0
        with:
          kiro_api_key: ${{ secrets.KIRO_API_KEY }}
```

Then comment on an issue:

```
@kiro the retry helper drops the last error. Can you fix it and add a test?
```

## Two modes

The mode is detected from the event and inputs; there is nothing to configure.

**Tag mode** — a human wrote the trigger phrase, added the trigger label, or
assigned the trigger user. The action posts a tracking comment, creates a branch
(for issues and closed PRs) or checks out the PR branch, builds a prompt from the
whole thread, and lets Kiro answer or implement. All output goes into that one
comment.

**Agent mode** — the workflow passes a `prompt`. No tracking comment, no branch
creation: the workflow decides what happens. Use it for scheduled jobs, labels
that kick off a fixed task, or `workflow_dispatch`.

```yaml
- uses: ndmxjp/Kiro-action@v0
  with:
    kiro_api_key: ${{ secrets.KIRO_API_KEY }}
    prompt: |
      Review the diff in this pull request for missing error handling.
      Write your findings to review.md; do not modify any other file.
```

Set `track_progress: true` to get the tracking comment _and_ a fixed prompt.

## What it can and cannot do

Can: answer questions, review code, edit files, read CI results for the PR, and
hand you a pre-filled "Create a PR" link. The action commits and pushes whatever
it edited, to a branch it created or to the PR branch.

Cannot: run commands you have not allowed (see
[docs/security.md](docs/security.md)); commit or push by itself; open, approve, or
merge a pull request; submit a formal PR review; post more than one comment; or
touch `.github/workflows`. Only users with write access to the repository can
trigger a run.

## Inputs

`kiro_api_key` is the only required input. The rest are documented in
[docs/configuration.md](docs/configuration.md); the most commonly used are:

| Input                    | Default        | Purpose                                        |
| ------------------------ | -------------- | ---------------------------------------------- |
| `kiro_api_key`           | —              | Kiro API key. Required.                        |
| `prompt`                 | `""`           | Instructions; selects agent mode.              |
| `trigger_phrase`         | `@kiro`        | Phrase that starts a tag-mode run.             |
| `label_trigger`          | `kiro`         | Label that starts a tag-mode run.              |
| `branch_prefix`          | `kiro/`        | Prefix for created branches.                   |
| `allowed_shell_commands` | `""`           | Commands the agent may run, e.g. `bun test *`. |
| `effort`                 | `""`           | CLI reasoning effort: `low`…`max`.             |
| `timeout_minutes`        | `""`           | Hard limit on the CLI run.                     |
| `github_token`           | `github.token` | Identity to act as.                            |

Outputs: `conclusion`, `contains_trigger`, `execution_file`, `branch_name`,
`comment_id`, `github_token`.

While a run is going the comment reads `Kiro is working… ⏳` and the agent rewrites
it as the work advances. `working_indicator` can replace the emoji with an image of
your own — see
[docs/configuration.md](docs/configuration.md#an-animated-in-progress-indicator).

## Permissions and safety

The action runs an LLM against content that anyone can write, so read
[docs/security.md](docs/security.md) before enabling it on a public repository.
In short:

- Only actors with write access can trigger a run.
- Comments and bodies are pinned to their state at trigger time, then stripped of
  hidden-instruction channels before reaching the prompt.
- On a pull request, config that the CLI executes (`.kiro/`, `.mcp.json`,
  `AGENTS.md`, `.gitmodules`, `.husky/`, …) is restored from the base branch, so a
  PR cannot introduce hooks or MCP servers that run in this job.
- The agent's shell is limited to specific commands (read-only git by default, plus
  whatever `allowed_shell_commands` adds), and its writes are confined to the
  checkout. `git push`, `git config`, `curl` and friends are refused outright, and
  the action does the committing and pushing itself.
- Do not use `pull_request_target`, and do not set `trust_all_tools: true`, on a
  repository that accepts pull requests from strangers.

## Requirements

- A Kiro API key (`KIRO_API_KEY`).
- A runner with network access: the action installs the Kiro CLI, which then
  talks to the Kiro service. Nothing else is fetched — the action itself ships as
  a bundle in `dist/`, so no dependency install happens at run time.
- `actions/checkout` with `fetch-depth: 0` is recommended so diffs against the
  base branch work.

## Documentation

- [docs/configuration.md](docs/configuration.md) — every input, and how tools and
  permissions are granted to the CLI.
- [docs/security.md](docs/security.md) — threat model, what is defended, and the
  known gaps.
- [docs/faq.md](docs/faq.md) — differences from the upstream Claude action and
  common problems.
- [examples/](examples/) — ready-to-copy workflows.

## Development

```sh
bun install --frozen-lockfile   # build from the locked tree, or dist/ will differ
bun run typecheck
bun run format:check
bun test
bun run build                   # rebuild dist/ after changing src/
```

`dist/` is committed: `action.yml` runs the bundle so a workflow needs no
dependency install. CI fails if it is stale, so rebuild and commit it with any
change under `src/`.

## Licence

MIT. See [LICENSE](LICENSE). Derived from
[anthropics/claude-code-action](https://github.com/anthropics/claude-code-action),
also MIT.
