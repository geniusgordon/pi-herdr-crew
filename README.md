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

Measured on one audit of a 6-line file, where the member produced 15942 bytes:

| Read path | Bytes the parent consumes |
|---|---|
| `herdr agent read` | 15942 plus terminal noise |
| child session JSONL | 15942 |
| file protocol | 167 plus a section list |

## Split of duty

- Herdr owns the process, the pane, and the lifecycle state.
- A markdown file owns the payload.
- The child session JSONL owns the trace and the fallback reply.

The extension reads a terminal in one case only: a startup or approval dialog.
Such a dialog exists on screen and never in a file.

## Install

Requires pi inside a Herdr pane, so `HERDR_ENV=1`.

Test one run:

```bash
pi -e /path/to/pi-herdr/src/index.ts
```

Install for every project:

```bash
ln -s /path/to/pi-herdr/src ~/.pi/agent/extensions/herdr-crew
```

## The `crew` tool

One tool, eight actions.

| Action | What it does |
|---|---|
| `open` | Create a tab, or a git worktree, then start an agent under a member name |
| `ask` | Write a brief, send the task, wait, return the summary line and the result shape |
| `collect` | Wait for a task sent with `wait=false`, or resume a wait that ran out of budget |
| `result` | List the result sections, or return one named section |
| `status` | One line per member with live Herdr state |
| `trace` | The member's tool calls and messages in order |
| `keys` | Send logical keys such as `esc` or `ctrl+c` to a blocked member |
| `close` | Close the tab, or remove the worktree |

### Read-only member

```
crew action=open   member=review-api
crew action=ask    member=review-api task_id="error-audit" task="Read src/index.ts and audit every unhandled error path."
crew action=result member=review-api section="No timeout"
crew action=close  member=review-api
```

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
crew action=open  member=fix-auth worktree=true
crew action=ask   member=fix-auth task="..."
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

**A member outlives its parent.** A new or reloaded parent calls `herdr agent list`
and adopts every named agent it does not know. `status` marks such a member
`adopted`. Adoption also reclaims a name left behind by a failed `open`.

**Member state comes from Herdr, not from a promise.** `idle`, `working`,
`blocked`, `done`, `unknown`. Trust `idle` and `done`. `unknown` does not prove
that a member finished.

**Project trust blocks a child.** A pi child in a new directory stops at the
trust dialog, and a worktree path is always new. The extension passes
`--no-approve`, which ignores project-local `.pi` resources. Pass `trust=true`
to load them with `--approve`.

**`ask` does not hold one long call.** A single blocking call can exceed the
parent tool-call budget. The call is then killed, the answer is lost, and the
member keeps working. So `ask` sends the prompt, then waits separately. Pass
`wait=false` to return at once, then `collect` each member:

```
crew action=ask member=a task="..." wait=false
crew action=ask member=b task="..." wait=false
crew action=status
crew action=collect member=a
crew action=collect member=b
```

A wait that runs out of budget reports the live state and keeps the task in
flight, so a later `collect` still returns the answer.

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

**The user can take over any member.** A member is a real pane. Switch to it and
type.

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
