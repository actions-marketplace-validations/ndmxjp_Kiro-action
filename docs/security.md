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

## The agent has no shell

**The agent cannot run commands.** Not git, not the test suite, nothing. This is
forced by how the Kiro CLI gates tools in headless mode, which was measured
rather than assumed — see `.github/workflows/kiro-perm-probe.yml`, which runs the
CLI directly across a matrix of configurations.

On the **v2 engine** (the CLI default, and what `kiro-cli 2.18.1` runs):

| Configuration                                                     | `git status` | file write  | `curl`      |
| ----------------------------------------------------------------- | ------------ | ----------- | ----------- |
| nothing granted                                                   | denied       | denied      | denied      |
| `allowedTools: [fs_read, fs_write]`                               | denied       | **allowed** | denied      |
| `--trust-tools=execute_bash` with `allowedCommands: ["^git .*$"]` | allowed      | allowed     | **allowed** |
| `--trust-all-tools`                                               | allowed      | allowed     | **allowed** |

Two things follow. First, anything not trusted wholesale is refused with
"non-interactive mode (no user to approve)" — including commands the interactive
default policy allows. Second, trusting a tool _overrides_ its `toolsSettings`,
and the CLI says so out loud: "You have trusted execute_bash tool, which
overrides the toolsSettings: allowedCommands". So on v2 there is no way to allow
`git add` without also allowing `curl`.

Rather than hand an LLM an unrestricted shell on a repository, this action grants
no shell and does the committing itself (`src/git/commit.ts`): it stages what
Kiro changed, commits it with the message Kiro left in a file outside the
checkout, and pushes. The commit message and author are therefore decided by the
action, not by the model's shell quoting.

`scripts/git-push.sh` is kept for the opt-in case (`allowed_tools: execute_bash`,
which is unrestricted and documented as such). It accepts exactly
`origin <branch|HEAD>`, rejects any argument starting with `-`, and validates the
ref with `git check-ref-format`, because allowing `git push` with arbitrary
arguments is remote code execution: `git push --receive-pack='sh -c ...' ext::sh
origin` runs a shell. The upstream project fixed the same issue after HackerOne
report #3556799.

## The v3 engine trades the comment for a real policy

The CLI also ships a newer engine, reachable as `kiro-cli chat --v3` and exposed
here as `agent_engine: v3`. Measured on the same build:

|                                   | v2 (default)        | v3                            |
| --------------------------------- | ------------------- | ----------------------------- |
| MCP servers declared by the agent | work                | **ignored entirely**          |
| `shell` allow rules per command   | ignored             | **enforced**                  |
| `fs_write` confined to a path     | overridden by trust | **enforced**                  |
| `--require-mcp-startup`           | fails as documented | no effect (no servers loaded) |

On v3, a rule allowing `git add *` and `git commit *` really did permit exactly
those, a `deny` rule blocked `curl` while naming the agent profile as its source,
and `fs_write` scoped to `./**` blocked a write to `/tmp`. That is the policy
this action would prefer.

MCP needs different wiring there. With the server declared inside the agent
profile, the model could not see the tool at all; with the identical server in
`~/.kiro/settings/mcp.json` and `includeMcpJson: true`, it saw
`mcp_probe_echo_probe` and the call returned. So when `agent_engine: v3` is set,
this action writes its servers to that user-scoped file instead. The nearest
upstream reports are kirodotdev/Kiro#7349 (inline servers ignored over ACP,
closed) and #7425 (servers not loaded in 2.0.0's default mode, open); the v3 case
does not appear to be reported yet.

v3 is not the default anyway, for three reasons: the docs label CLI 3.0 early
access, `includeMcpJson: true` also merges the checkout's
`.kiro/settings/mcp.json` (which is why the config restore matters), and the
engine's registry is fragile in ways others have hit — kirodotdev/Kiro#10733
reports it silently dropping any agent config without a `permissions` block while
`agent validate` still exits 0. Use it for agent-mode automation that needs to
run commands.

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

1. **On v2, file writes are not path-scoped.** Granting `fs_write` grants it
   everywhere: trusting a tool overrides the `allowedPaths` setting that would
   otherwise confine it. A prompt injection that gets the model to write outside
   the checkout — into `$HOME`, say — is not blocked. Runners are ephemeral,
   which limits the blast radius, but do not run this on a long-lived
   self-hosted runner that holds other secrets. `agent_engine: v3` closes this
   (a write to `/tmp` was refused in testing), at the cost of the tracking
   comment.
2. **The agent cannot verify its own work.** With no shell it cannot run the test
   suite or the linter, so every change it proposes is unverified. The prompt
   tells it to say so. Keep required status checks on protected branches.
3. **`trust_all_tools: true` disables gating.** It is an escape hatch for trusted
   automation only; on any engine it allows arbitrary commands.
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
