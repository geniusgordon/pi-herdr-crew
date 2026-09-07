# pi-herdr-lane

Run pi subagents as visible Herdr panes. Read their answers from the child
session file, not from the terminal.

## Why

`herdr agent read` returns the raw terminal. That snapshot carries the startup
banner, the context list, the skill list, the extension list, the model bar, and
the token bar. The answer sits in the middle of it.

Measured on one 4-word answer:

| Read path | Bytes the parent consumes |
|---|---|
| `herdr agent read` | about 2500 |
| child session JSONL, last assistant message | about 40 |

`herdr agent start` already reports the child session file as
`.result.agent.agent_session.value`. This extension reads that file.

## Split of duty

- Herdr owns the process, the pane, and the lifecycle state.
- The child session JSONL owns the data.

The extension reads a terminal in one case only: a startup or approval dialog.
Such a dialog exists on screen and never in the JSONL.

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
| `open` | Split a pane, or create a git worktree, then start an agent under a lane name |
| `ask` | Send a task, wait for the lane to settle, return the final answer only |
| `status` | One line per lane with live Herdr state |
| `trace` | The lane's tool calls and messages in order |
| `keys` | Send logical keys such as `esc` or `ctrl+c` to a blocked lane |
| `close` | Close the pane, or remove the worktree |

### Read-only lane, same directory

```
lane action=open   lane=review-api
lane action=ask    lane=review-api task="Read src/index.ts and list every unhandled error path."
lane action=close  lane=review-api
```

The new pane is a sibling in the current tab. A wide pane splits right, a narrow
pane splits down. Focus stays in the calling pane.

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
| `src/transcript.ts` | Child session JSONL reader |
| `src/registry.ts` | Lane bookkeeping, persisted through `pi.appendEntry` |
