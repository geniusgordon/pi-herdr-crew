# Crew task reports `done` before the task finishes

## Summary

The crew watcher reports task completion after the first completed Pi turn.
A crew task can contain multiple Pi turns when a background task starts a follow-up turn.

An early `collect` then clears the task state before the member writes `result.md`.
The member continues its work, but the extension no longer tracks the task.

## Observed case

Task: `web-banner-dead-branches`

Member session:

```text
/Users/gordon/.pi/agent/sessions/--Users-gordon-.herdr-worktrees-firstory-web-crew-fix-discount-banner-branches--/2026-09-09T09-08-55-143Z_01a0856d-68e6-750e-8c7a-bc7200a0d248.jsonl
```

Parent session:

```text
/Users/gordon/.pi/agent/sessions/--Users-gordon-Works-firstory-projects-workspaces-fix-discount--/2026-09-09T08-20-10-408Z_01a08540-c828-71c6-b4d3-bff007af7e53.jsonl
```

## Timeline

1. At `09:14:07.353`, the member writes its first `zentui-turn-summary`.
2. At `09:14:08.103`, the parent receives the incorrect `done` event.
3. At `09:14:22.314`, `collect` finds no `result.md` and reports `state=working`.
4. At `09:14:25.967`, the member finishes a second Pi turn.
5. At `09:18:10.283`, the member writes the real `result.md`.
6. At `09:18:17.813`, the member finishes its final Pi turn.

The extension reports completion about four minutes before the task completes.

## Root cause 1: a completed turn is not a completed task

`src/transcript.ts:56-61` increments `turnCount` for each `zentui-turn-summary`.

```ts
if (entry.type === "custom" && entry.customType === "zentui-turn-summary") {
  turnCount += 1;
}
```

`src/index.ts:756-765` returns `done` when one new turn exists.
It does not first verify the live Herdr state or the result file.

```ts
const transcript = await readTranscript(member.sessionPath).catch(() => empty);
if (transcript.turnCount > baseline) return { kind: "done", transcript };
```

A background task can create this valid sequence:

```text
turn 1: start dependency installation
turn 2: start validation after installation
turn 3: start a review after validation
turn 4: write result.md and finish
```

The watcher treats turn 1 as completion for the full crew task.

## Root cause 2: an early collect deletes recovery state

`src/index.ts:599-602` clears `member.pending` before result validation.

```ts
persist({ ...member, pending: undefined });
```

`src/index.ts:604-615` checks `result.md` only after that state change.
When the result does not exist, the extension returns a partial reply but loses task ownership.

A later `collect` then fails with:

```text
Member web-banners has no task in flight. Use action "ask" first.
```

The final result remains available only through `crew result --task_id`.

## Expected behavior

For the default file protocol, report completion only when all conditions hold:

1. The transcript contains a new turn.
2. Herdr reports a settled member state.
3. The task result file exists.

Keep `member.pending` when `collect` finds a working member or a missing result file.

For an inline task, use a settled Herdr state and a new transcript turn.
A short stability window can prevent a temporary idle state before an automatic follow-up turn.

## Suggested implementation

Change `inspectTurn` so a new turn does not directly mean `done`.
Read the live member state before the completion decision.

For file tasks, let the watcher also check the expected result path.
Alternatively, add a task-completion predicate above `inspectTurn`.

Move this state change after successful result validation:

```ts
persist({ ...member, pending: undefined });
```

When `result.md` does not exist, return `pending: true` and retain the watcher state.

## Required regression tests

1. Return `pending` for a new turn while the member state is `working`.
2. Return `pending` for a settled member when `result.md` does not exist.
3. Return `done` for a settled member when `result.md` exists.
4. Preserve `member.pending` after an early `collect`.
5. Send one completion event after a background follow-up turn writes the result.

## Commands used

```bash
herdr agent list
grep "zentui-turn-summary" <member-session.jsonl>
grep "web-banners" <parent-session.jsonl>
nl -ba src/index.ts
nl -ba src/transcript.ts
```
