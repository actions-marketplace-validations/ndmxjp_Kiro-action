# Security

This action gives a model write access to your repository, driven by text that
anyone can write. This page describes what is defended, and what is not.

## Who can trigger a run

- The actor must have `write` or `admin` permission on the repository. Everyone
  else is rejected before anything else happens.
- Bots cannot trigger runs unless they are listed in `allowed_bots` (or it is set
  to `*`).
- For `workflow_run` events, the actor that started the upstream run is checked
  as well.

Adding the trigger phrase to a comment is not, on its own, authorisation: it is
the _commenter's_ repository permission that decides.

## Prompt injection

Issue bodies, comments, and review comments are attacker-controlled data. Before
any of it reaches the prompt it is:

- **Pinned to trigger time.** Comments created or edited at/after the triggering
  event are dropped, and the issue/PR title and body come from the webhook
  payload rather than from a later API read. This closes the window where an
  attacker edits a comment after an authorised user triggers a run.
- **Stripped of hidden-instruction channels.** HTML comments, zero-width and
  bidi-override characters, markdown image alt text, link titles, and
  `alt`/`title`/`aria-label`/`data-*`/`placeholder` attributes are removed, and
  HTML entities outside printable ASCII are dropped.

The prompt also tells the model that only the triggering comment carries
instructions and that everything else is reference material. That is a mitigation,
not a guarantee: a sufficiently convincing comment may still steer the model.
Treat anything Kiro produces on a public repository as an untrusted proposal, and
keep required reviews on protected branches.

## Untrusted config in a pull request checkout

The CLI reads configuration from the working directory: agent definitions, MCP
server declarations, hooks, and steering files. On a pull request that directory
is written by the PR author, so before the CLI starts, these paths are replaced
with the versions from the base branch:

`.kiro/`, `.amazonq/`, `.mcp.json`, `AGENTS.md`, `KIRO.md`, `.gitmodules`,
`.ripgreprc`, `.husky/`

They are **deleted first and fetched afterwards**, because a hostile
`.gitmodules` present during a `git fetch` can make git reach out to
attacker-chosen remotes and hang the job on a credential prompt. If a path does
not exist on the base branch it stays deleted.

Consequences worth knowing:

- If a pull request legitimately changes `.kiro/`, and Kiro later commits with
  `git add -A`, the revert is included in that commit.
- Only those paths are restored. A base-branch hook that shells out through
  something a PR _can_ change (`bun run <script>`, a Makefile target, a
  repo-relative script) still executes the PR's version. Keep restored hooks
  self-contained.

## What the agent may run

The agent gets read and search tools outright, a **write tool confined to the
checkout**, and a **shell limited to specific commands**. How that is enforced was
measured rather than assumed — `.github/workflows/kiro-perm-probe.yml` runs the CLI
directly across a matrix of configurations.

The mechanism on the v2 engine (the CLI default) is `toolsSettings`, and the
essential detail is that **it only applies to tools that are not trusted**:

| Configuration                                       | `git status --short` | write in repo | write to /tmp | `curl`      |
| --------------------------------------------------- | -------------------- | ------------- | ------------- | ----------- |
| nothing granted                                     | denied               | denied        | denied        | denied      |
| tools trusted via `allowedTools`                    | allowed              | allowed       | **allowed**   | allowed     |
| `--trust-tools=execute_bash` with `allowedCommands` | allowed              | —             | —             | **allowed** |
| `--trust-all-tools`                                 | allowed              | allowed       | allowed       | **allowed** |
| **untrusted + `toolsSettings`**                     | **allowed**          | **allowed**   | **denied**    | **denied**  |

Trusting a tool overrides the settings that scope it, and the CLI says so out
loud: "You have trusted execute_bash tool, which overrides the toolsSettings". So
`fs_write` and `execute_bash` are listed in `tools` but deliberately left out of
`allowedTools`. Anything neither allowed nor matched is refused with
"non-interactive mode (no user to approve)", because there is nobody to prompt.

Granted by default: `git status`, `git diff`, `git log`, `git show`,
`git rev-parse`, `git ls-files`, `git branch`. Denied whatever a workflow asks
for, since deny is evaluated first: `curl`, `wget`, `sudo`, `rm -rf`, `nc`, `ssh`,
`git push`, `git config`, `git remote`. The last three matter because the push URL
carries the GitHub token and because arbitrary `git push` arguments are remote code
execution (`git push --receive-pack='sh -c ...' ext::sh origin`, the class of issue
behind HackerOne #3556799 against the upstream action).

`allowed_shell_commands` extends the allow list — `bun test *` and the like. The
patterns are regexes on v2, which the CLI anchors with `\A` and `\z`; the input is
accepted in glob form and translated, so a workflow never has to know that. Writing
them pre-anchored as `^git status.*$` matches nothing, which is what made an
earlier round of testing here conclude, wrongly, that scoping was impossible.

## Committing is done by the action, not the agent

`git push`, `git commit`, and `git add` are all denied to the agent. It edits files;
afterwards the action stages what changed, commits it with the message the agent
left in a file under `$RUNNER_TEMP`, and pushes (`src/git/commit.ts`). The commit
message and author are therefore decided by this action rather than by the model's
shell quoting, and the push never goes through a command the model composed.

`scripts/git-push.sh` remains for the opt-in case: a workflow that puts
`execute_bash` in `allowed_tools` bypasses the scoping entirely and gets an
unrestricted shell, which is documented as such.

## The v3 engine is equivalent, and optional

The CLI also ships a newer engine, reachable as `kiro-cli chat --v3` and exposed
here as `agent_engine: v3`. It enforces the same limits through `permissions.rules`
instead of `toolsSettings`, and this action emits whichever schema matches the
engine — never both, since handing v2 a config with a `permissions` block made it
drop the config entirely ("no agent with name … found. Falling back to user
specified default").

Two v3 quirks are worth knowing, both measured:

- It ignores `mcpServers` declared inside an agent profile. The same server in
  `~/.kiro/settings/mcp.json` with `includeMcpJson: true` works, so that is where
  this action writes them on v3 — which also merges the checkout's copy, hence the
  config restore above. The nearest upstream reports are kirodotdev/Kiro#7349
  (inline servers ignored over ACP, closed) and #7425 (not loaded in 2.0.0's
  default mode, open); the v3 case does not appear to be reported.
- The CLI exits after answering but the KAS server it starts as a grandchild keeps
  running and holds the output pipes, which would keep this action's own process
  from exiting. The CLI is therefore started in its own process group, and the
  group is signalled and the pipes released once the run is over.

v3 is not the default because 3.0 is documented as early access, `includeMcpJson`
widens what gets loaded, and its registry is fragile in ways others have hit —
kirodotdev/Kiro#10733 has it silently dropping any agent config without a
`permissions` block while `agent validate` still exits 0.

## Credentials

- `KIRO_API_KEY` is registered as a masked secret and never written to the
  execution log: output is passed through both a pattern-based redactor (GitHub,
  AWS, Slack, JWT shapes) and a literal-value redactor for the env secrets this
  action knows about.
- The credential `actions/checkout` leaves in `.git/config` is removed and
  replaced with this action's own token, so tools running in the working tree do
  not inherit the checkout's identity.
- The token is embedded in the `origin` remote URL, which is how pushes
  authenticate. It is therefore readable by anything that can run
  `git remote -v` — which is why `git config` and `git remote` are not on the
  shell allowlist.
- GitHub App tokens are revoked in an `always()` post step.

## Known gaps

These are real limitations, not oversights:

1. **The agent cannot verify its own work unless you let it.** Out of the box it
   can read and inspect git history but not run your test suite, so a change it
   proposes is unverified; the prompt tells it to say so. Grant what it needs with
   `allowed_shell_commands` — and remember that whatever you grant, a prompt
   injection can also reach.
2. **A denied command is only denied by pattern.** The allow and deny lists match
   command text, so a granted command that itself takes arbitrary arguments (a
   task runner, `bash -c`, a script that shells out) widens the hole as far as that
   command goes. Grant specific commands, not interpreters.
3. **`trust_all_tools: true`, and naming `execute_bash` in `allowed_tools`, both
   disable the scoping.** They are escape hatches for trusted automation only.
4. **No commit signing.** The upstream action can commit through the GitHub API so
   commits are signed; this port commits with the git CLI, so commits are
   unsigned. A branch protection rule requiring signed commits will reject them.
5. **Inline review comments are not supported.** Kiro reports through one comment.
6. **No sandbox for non-write users.** The upstream action can run untrusted
   content in an isolated subprocess; this port simply refuses to run for actors
   without write access.

## Recommendations

- Gate the job with an `if:` condition on the trigger phrase so a runner is not
  started for every comment.
- Do not use `pull_request_target`. It runs with a token that has write access in
  the context of the _base_ repository while checking out fork code.
- Keep `permissions:` at the minimum the workflow needs. `actions: read` is only
  needed if you want CI-failure analysis.
- Require reviews on protected branches. Kiro cannot approve or merge, and it
  should stay that way.
- Report a vulnerability in this action by opening a security advisory on the
  repository rather than a public issue.
