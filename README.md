# pi-herdr-crew

Run pi subagents as a crew of visible Herdr tabs. Each member answers through a
markdown file, not through the terminal.

## Why

A member answer must not enter the parent context whole.

`herdr agent read` returns the raw terminal, which carries the startup banner,
the skill list, the extension list, and the token bar. Reading the child session
file instead removes that noise, but it does not bound the size: a verbose member
still dumps its whole answer into the parent.

The file protocol bounds it. The parent writes a brief, the member writes a result
file, and the member replies with one summary line.

Measured on one audit of this repository, where the member produced 12283 bytes:

| Read path | Bytes the parent consumes |
|---|---|
| `herdr agent read` | 12283 plus terminal noise |
| child session JSONL | 12283 |
| file protocol | 124 plus a section list |

## Split of duty

- Herdr owns the process, the pane, and the lifecycle state.
- A markdown file owns the payload.
- The child session JSONL owns the trace and the fallback reply.

The extension reads a terminal in one case only: a startup or approval dialog.
Such a dialog exists on screen and never in a file.

## Prerequisites

Two things, both required.

1. Run pi inside a Herdr pane, so `HERDR_ENV=1`.
2. Install the Herdr pi integration once per machine:

```bash
herdr integration install pi
herdr integration status | head -1   # expect: pi: current
```

That command writes `~/.pi/agent/extensions/herdr-agent-state.ts`. The extension
reports two facts to Herdr over the pane socket:

| Report | Value |
|---|---|
| `pane.report_agent_session` | the absolute path of the pane's session JSONL |
| `pane.report_agent` | the agent state: `working`, `blocked`, or `idle` |

The crew tool needs both:

- `open` reads the session path from `herdr agent start`. Without the integration
  it reports no session file, and `open` fails.
- `ask`, `collect`, `result`, and `trace` read that session file.
- `status` and the blocked-dialog check read the agent state.

Rerun the install command when `herdr integration status` reports `outdated`. A
Herdr upgrade can raise the integration version.

## Install

```bash
pi install git:github.com/geniusgordon/pi-herdr-crew
```

Try it for one run, with no change to your settings:

```bash
pi -e git:github.com/geniusgordon/pi-herdr-crew
```

Install for one project instead of every project:

```bash
pi install -l git:github.com/geniusgordon/pi-herdr-crew
```

Remove it:

```bash
pi remove git:github.com/geniusgordon/pi-herdr-crew
```

A local checkout installs from its path:

```bash
pi install /path/to/pi-herdr-crew
```

## The `crew` tool

One tool, nine actions.

| Action | What it does |
|---|---|
| `open` | Create a tab or worktree, start an agent, and dispatch an optional first task |
| `adopt` | Transfer a live member to this Pi session after confirmation |
| `ask` | Write a brief and dispatch a task to an open member |
| `collect` | Return a settled task summary and result shape without waiting |
| `result` | List the result sections, or return one named section |
| `status` | One line per member with live Herdr state |
| `trace` | Show the member's tool calls and messages |
| `keys` | Send logical keys such as `esc` or `ctrl+c` |
| `close` | Close the tab, or remove the worktree |

### One-task member

Dispatch one task, wait for the notification, then collect and close:

```
crew action=open    member=review-api task_id="error-audit" task="Read src/index.ts and audit every unhandled error path."
crew action=collect member=review-api
crew action=result  task_id="error-audit" section="No timeout"
crew action=close   member=review-api
```

`open` and `ask` return after dispatch. A session-scoped supervisor watches the
child transcript. It sends a small follow-up message when the task finishes,
blocks, or loses its pane. The message wakes an idle main agent.

`collect` never waits. Call it after the completion notification. It validates
the result, returns its bounded shape, and clears the pending task.

### Reusable member

Use the explicit actions when one member must receive more than one task:

```
crew action=open    member=review-api task_id="error-audit" task="Read src/index.ts and audit every unhandled error path."
crew action=collect member=review-api
crew action=result  member=review-api section="No timeout"
crew action=ask     member=review-api task_id="follow-up" task="Check the proposed correction."
crew action=collect member=review-api
crew action=close   member=review-api
```

Close a member after the final result. Keep it open only for reuse, correction,
or user takeover. Collect each task before you dispatch the next task.

### Read-only member
```
crew action=open   member=review-api task_id="error-audit" task="Read src/index.ts and audit every unhandled error path."
crew action=result member=review-api section="No timeout"
crew action=close  member=review-api
```

`open` accepts every `ask` field: `task`, `task_id`, `context`, and `inline`.
A `task` on `open` runs as the member's first task, so one call replaces `open`
then `ask`. Use `ask` for a second or later task on that member.

Startup costs a few seconds before dispatch. After dispatch, the tool returns at
once and the supervisor owns completion detection.

`open` creates a full-width tab, because a split shrinks the caller and a narrow
pane truncates every agent UI. Pass `layout="split"` for a sibling pane in the
current tab. Focus stays in the calling pane either way.

The tab lands in the workspace that owns the member's repository, not in the
caller's workspace. A directory with no open workspace uses the caller's
workspace instead.

## The file protocol

One directory per task, in the orchestrator's working directory:

```
<your cwd>/.pi/crew/<task_id>/brief.md      turn 1, written by the orchestrator
<your cwd>/.pi/crew/<task_id>/result.md     turn 1, written by the member
<your cwd>/.pi/crew/<task_id>/brief-2.md    turn 2
<your cwd>/.pi/crew/<task_id>/result-2.md   turn 2
```

The orchestrator's directory owns these files, not the member's. A worktree
member runs in a directory that `close` removes, so a result stored there dies
with it. The member therefore receives absolute paths.

Two kinds of file, two places:

| Kind | Example | Location |
|---|---|---|
| Result | `result.md` | orchestrator cwd, survives close |
| Work product | `FIX.ts`, a patch | member cwd, committed with the code |

`task_id` defaults to the member name. Pass it when one member runs several
tasks. A task outlives its member, so `result` accepts a `task_id` with no
member name:

```
crew action=result task_id="error-audit"
```

The extension writes `.pi/crew/.gitignore` containing `*` on first use, so these
files never reach Git.

The brief fixes the contract: write the answer to the result file, reply with one
line starting DONE or BLOCKED, and never paste the answer into the reply.

Pass `inline=true` to skip the file for a one-line answer, where a file costs
more than it saves.

A member that ignores the brief still answers. The extension falls back to its
reply instead of losing the work.

### Writing member, isolated worktree

One directory tolerates one writer. Two writers in one directory destroy each
other's edits. Give each writing member its own worktree:

```
crew action=open  member=fix-auth worktree=true task="..."
crew action=close member=fix-auth
```

`worktree=true` runs `herdr worktree create`, which adds a real git worktree and
opens a new workspace on it. The branch defaults to `crew/<name>`. Pass `branch`
and `base` to override.

Herdr has no parent workspace field. It groups a worktree workspace under the
source repository instead, through `source_workspace_id` from `worktree list`.
The extension passes that value, so the member workspace lands beside its parent
repository rather than at the end of the workspace list. A repository with no
open workspace has no such id, so the extension falls back to `--cwd`.

A worktree member runs in the worktree, so its `.pi/members` directory lives there
too, not in the source checkout.

`close` refuses a dirty worktree and keeps the member open, so uncommitted work
survives. Pass `force=true` to discard it. Herdr removes the worktree but never
deletes the branch.

## Behavior that matters

**A member starts with an empty conversation.** It cannot see the parent session.
Put every needed fact in the task text.

**A member outlives its parent.** A new or reloaded parent reconnects live
members owned by the same Pi session. The ownership record uses the child
session path to reject a different agent with the same name.

**Ownership is isolated by Pi session.** `status` and automatic reconnect ignore
members owned by other sessions. Use `adopt` to transfer a live member after a
confirmation. A generation check lets only one concurrent transfer succeed.

**Notifications follow ownership.** A watcher checks the owner and generation
while it sends a notification. A transfer invalidates the old watcher before it
can send a later notification.

**Member state comes from Herdr, not from a promise.** `idle`, `working`,
`blocked`, `done`, `unknown`. Trust `idle` and `done`. `unknown` does not prove
that a member finished.

**Project trust blocks a child.** A pi child in a new directory stops at the
trust dialog, and a worktree path is always new. The extension passes
`--no-approve`, which ignores project-local `.pi` resources. Pass `trust=true`
to load them with `--approve`.

**`ask` is asynchronous.** It persists the task before dispatch. A supervisor
then watches the child session file and sends a follow-up message to the main
agent when the task state changes:

```
crew action=open member=a task="..."
crew action=open member=b task="..."
# Each completion notification tells the main agent which member to collect.
crew action=collect member=a
crew action=collect member=b
```

The notification contains only the member, task, turn, and state. The result
stays in its file until the main agent calls `collect` or `result`.

**The settle signal is the child session file, not the Herdr lifecycle.**
`agent prompt` returns before the child leaves its settled state, so a lifecycle
wait can observe the old state and return at once. A completed turn appends a
turn summary to the child session file, which is unambiguous.

**A fresh tab pane is not ready at once.** `agent start` then fails with
`agent_pane_busy`. Measured on one machine, the shell needs about one second, so
the extension retries for up to 15 seconds.

**The member child gets `--name`, not `--session-id`.** A fresh session id makes pi
print a warning on every member start. The name shows in the member footer and the
tab title instead, and Herdr reports the session path anyway.

**A blocked member returns a pane tail, not a hang.** `ask` never answers a dialog
by itself. It reports the dialog and stops. Answer it with `keys` after the user
decides.

**The user can take over any open member.** A member is a real pane. Switch to
it and type. Close it only after its result is durable.

## Command

```
/crew         list the open crew
/crew close   close every member, after one confirmation
```

## Files

| Path | Contents |
|---|---|
| `src/index.ts` | The `crew` tool, the `/crew` command, and the actions |
| `src/herdr.ts` | `herdr` CLI wrapper, JSON and text variants |
| `src/protocol.ts` | Brief and result files, task directories, section reads |
| `src/transcript.ts` | Child session JSONL reader |
| `src/registry.ts` | Member bookkeeping, persisted through `pi.appendEntry` |
