# pi-herdr-lane

Run pi subagents as visible Herdr panes. Read their answers from the child
session file, not from the terminal.

## Why

A lane answer must not enter the parent context whole.

`herdr agent read` returns the raw terminal, which carries the startup banner,
the skill list, the extension list, and the token bar. Reading the child session
file instead removes that noise, but it does not bound the size: a verbose lane
still dumps its whole answer into the parent.

The file protocol bounds it. The parent writes a brief, the lane writes a result
file, and the lane replies with one summary line.

Measured on one audit of a 6-line file, where the lane produced 15942 bytes:

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
ln -s /path/to/pi-herdr/src ~/.pi/agent/extensions/herdr-lane
```

## The `lane` tool

One tool, six actions.

| Action | What it does |
|---|---|
| `open` | Create a tab, or a git worktree, then start an agent under a lane name |
| `ask` | Write a brief, send the task, wait, return the summary line and the result shape |
| `result` | List the result sections, or return one named section |
| `status` | One line per lane with live Herdr state |
| `trace` | The lane's tool calls and messages in order |
| `keys` | Send logical keys such as `esc` or `ctrl+c` to a blocked lane |
| `close` | Close the tab, or remove the worktree |

### Read-only lane

```
lane action=open   lane=review-api
lane action=ask    lane=review-api task_id="error-audit" task="Read src/index.ts and audit every unhandled error path."
lane action=result lane=review-api section="No timeout"
lane action=close  lane=review-api
```

`open` creates a full-width tab, because a split shrinks the caller and a narrow
pane truncates every agent UI. Pass `layout="split"` for a sibling pane in the
current tab. Focus stays in the calling pane either way.

The tab lands in the workspace that owns the lane's repository, not in the
caller's workspace.

## The file protocol

One directory per task:

```
.pi/lanes/<task_id>/brief.md       turn 1, written by the parent
.pi/lanes/<task_id>/result.md      turn 1, written by the lane
.pi/lanes/<task_id>/brief-2.md     turn 2
.pi/lanes/<task_id>/result-2.md    turn 2
.pi/lanes/<task_id>/app.ts.patch   any extra artifact the lane writes
```

`task_id` defaults to the lane name. Pass it when one lane runs several tasks.
The extension reports every extra file in that directory, so an artifact never
goes unnoticed.

The brief fixes the contract: write the answer to the result file, reply with one
line starting DONE or BLOCKED, and never paste the answer into the reply.

Pass `inline=true` to skip the file for a one-line answer, where a file costs
more than it saves.

A lane that ignores the brief still answers. The extension falls back to its
reply instead of losing the work.

### Writing lane, isolated worktree

One directory tolerates one writer. Two writers in one directory destroy each
other's edits. Give each writing lane its own worktree:

```
lane action=open  lane=fix-auth worktree=true
lane action=ask   lane=fix-auth task="..."
lane action=close lane=fix-auth
```

`worktree=true` runs `herdr worktree create`, which adds a real git worktree and
opens a new workspace on it. The branch defaults to `lane/<name>`. Pass `branch`
and `base` to override.

Herdr has no parent workspace field. It groups a worktree workspace under the
source repository instead, through `source_workspace_id` from `worktree list`.
The extension passes that value, so the lane workspace lands beside its parent
repository rather than at the end of the workspace list.

A worktree lane runs in the worktree, so its `.pi/lanes` directory lives there
too, not in the source checkout.

`close` refuses a dirty worktree and keeps the lane open, so uncommitted work
survives. Pass `force=true` to discard it. Herdr removes the worktree but never
deletes the branch.

## Behavior that matters

**A lane starts with an empty conversation.** It cannot see the parent session.
Put every needed fact in the task text.

**A lane outlives its parent.** A new or reloaded parent calls `herdr agent list`
and adopts every named agent it does not know. `status` marks such a lane
`adopted`. Adoption also reclaims a name left behind by a failed `open`.

**Lane state comes from Herdr, not from a promise.** `idle`, `working`,
`blocked`, `done`, `unknown`. Trust `idle` and `done`. `unknown` does not prove
that a lane finished.

**Project trust blocks a child.** A pi child in a new directory stops at the
trust dialog, and a worktree path is always new. The extension passes
`--no-approve`, which ignores project-local `.pi` resources. Pass `trust=true`
to load them with `--approve`.

**A fresh tab pane is not ready at once.** `agent start` then fails with
`agent_pane_busy`. Measured on one machine, the shell needs about one second, so
the extension retries for up to 15 seconds.

**The lane child gets `--name`, not `--session-id`.** A fresh session id makes pi
print a warning on every lane start. The name shows in the lane footer and the
tab title instead, and Herdr reports the session path anyway.

**A blocked lane returns a pane tail, not a hang.** `ask` never answers a dialog
by itself. It reports the dialog and stops. Answer it with `keys` after the user
decides.

**The user can take over any lane.** A lane is a real pane. Switch to it and
type.

## Command

```
/lanes         list open lanes
/lanes close   close every open lane, after one confirmation
```

## Files

| Path | Contents |
|---|---|
| `src/index.ts` | The `lane` tool, the `/lanes` command, and the actions |
| `src/herdr.ts` | `herdr` CLI wrapper, JSON and text variants |
| `src/protocol.ts` | Brief and result files, task directories, section reads |
| `src/transcript.ts` | Child session JSONL reader |
| `src/registry.ts` | Lane bookkeeping, persisted through `pi.appendEntry` |
