# Crew Completion Barrier

Status: implemented. Regression validation passed; the final scoped release review found no residual regressions. Live host validation remains open.

## Goal

Collect one user request's required crew results and deliver one combined answer.
Keep dispatch asynchronous. Preserve independent tasks and immediate blocker notifications.

## Verified baseline

- `src/index.ts:110-133` restores members and starts or stops session-scoped watchers.
- `src/index.ts:635-670` persists task metadata before dispatch and starts a watcher after dispatch.
- `src/index.ts:991-998` sends each member notification with `triggerTurn: true`.
- `src/registry.ts:55-68` stores task identity and per-member notification state.
- `src/registry.ts:117-125` restores all session entries rather than the active branch alone.
- `src/async-lifecycle.ts:25-44` requires a settled child, a new turn, and the expected result artifact.

`Promise.all` over `open` or `ask` waits for dispatch receipts, not task completion.
The barrier must aggregate watcher outcomes instead.

## Pi delivery contract

Installed Pi source:
`/Users/gordon/.pi/agent/install/releases/1.2.0/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1824-1857`.

- `followUp` with `triggerTurn: false` does not request another model turn.
- Such a message still enters model context; `display: false` hides only its presentation.
- `followUp` with `triggerTurn: true` queues a follow-up or starts an idle agent.
- `nextTurn` queues for a later run rather than a completion wake-up.

Use `appendEntry` for individual batch outcomes, not silent custom messages.
Use one aggregate custom message when the complete required set settles.

`pi.sendMessage` does not acknowledge durable delivery or model consumption.
The runtime wrapper catches asynchronous send failures separately:
`/Users/gordon/.pi/agent/install/releases/1.2.0/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:2734-2743`.

One normal-runtime submission is feasible. Exactly-once crash delivery is not an available guarantee.

## Decision: declare the required set before dispatch

Extend the existing `crew` tool. Add `batch`, `batch_cancel`, and optional
`batch_id` on `open`, `ask`, and `status`. Keep other calls unchanged.

Proposed calls:

```text
crew action=batch expected_members=["api","tests"]
# Returns batch_id immediately; registration is already sealed.
crew action=open member=api batch_id=<id> task_id=api-audit task="..."
crew action=open member=tests batch_id=<id> task_id=test-audit task="..."
# The parent yields. Watchers emit one aggregate settled event.
crew action=collect member=api
crew action=collect member=tests
```

Reject empty sets, duplicate names, unknown batch IDs, foreign owners, and duplicate slot claims.
Each member owns one slot and one task per batch. A completed batch cannot accept more tasks.

Do not register existing dispatched tasks retrospectively. A fast task can already send its
individual completion event before registration. That queued event cannot be withdrawn.
Do not infer membership from every open member or use a debounce timer as a completion test.

## State model

Store a versioned batch record separately from member records:

```text
batchId, ownerSessionId, orchestratorCwd, createdAt
expectedSlots: immutable member names
bindings: memberName, memberId, generation, ownerSessionId, taskId, turn
slotState: awaiting-dispatch | preparing | running | dispatch-uncertain
           | done | dispatch-failed | gone | closed | ownership-lost | cancelled
attention: blocked episode marker
notification: stable event ID and normal-runtime submission marker
```

Claim a slot before startup or preparation. Bind its exact task before final prompt dispatch.
Persist outcomes independently of `member.pending`; collection must not erase batch history.
After successful result validation, `collectMember` must commit the exact bound slot's `done`
outcome through the synchronous batch transition before it clears `member.pending`. Calculate readiness in
that same transition. Failed validation retains pending state and leaves the slot unresolved.
This handles collection before the watcher records completion.
Reuse the existing completion predicate. File creation alone does not release the barrier.

A batch settles when every expected slot reaches a terminal state. Report `all_done` separately.
A settled task can contain a BLOCKED result; technical completion does not prove research success.
Awaiting-dispatch slots remain unresolved until dispatch or explicit cancellation.

On `batch_cancel`, leave child processes and results intact. Restore ordinary child notifications.
For children already settled silently, re-evaluate notification state so cancellation cannot hide their result.

## Outcome and notification policy

| Observation | Batch action |
|---|---|
| done | Persist the outcome; suppress the individual completion message. |
| blocked | Keep the slot unresolved; emit one immediate attention event per blocked episode. |
| gone or ownership-lost | Record terminal failure; emit immediate attention. |
| confirmed non-dispatch | Record dispatch-failed; return the error in the dispatch receipt. |
| ambiguous dispatch transport failure | Retain the exact binding; expose uncertainty and reconcile; never automatically resend. |

When all slots terminate, submit one bounded `herdr-crew-batch` follow-up event.
Include batch ID, outcomes, and exact task references. Keep result payloads in files.
Attention events are exceptions to the single completion event, not successful batch completion.
Preserve the current attention delivery mode initially; a switch to steering is not required for this feature.

## Implementation seams

1. Add `src/completion-barrier.ts` with validation, slot transitions, identity checks, and readiness calculation.
2. Add a batch registry with synchronous transitions. Persist `herdr-crew-batch-state` through `appendEntry`; synchronous updates serialize observations without an extra queue.
3. Extend the schema and dispatch paths in `src/index.ts:508-673`. Claim slots before side effects and bind before dispatch.
4. Route observations in `src/index.ts:964-1025`. Handle ownership loss before the existing early watcher return.
5. Record completion before collection clears pending state. Reconcile startup, close, transfer, and cancellation; document the API and delivery guidance.

Use a per-member dispatch critical section. Concurrent calls currently check pending state before
asynchronous preparation at `src/index.ts:548-549`; that check alone does not reserve a member.
Use a per-batch synchronous transition for the final readiness decision so simultaneous completions submit one event.
Do not hold multiple ownership locks across asynchronous waits without a defined lock order.

`src/index.ts:1243-1247` removes supervisors after successful close. Update matching unresolved
slots before that removal. A failed dirty-worktree close must leave its slot unresolved.
Ownership transfer changes generation at `src/ownership.ts:146-153`; the original batch must not
follow the child into another parent session. Strip foreign batch linkage during adoption.

Restore batch records before watchers start at `src/index.ts:123-125`.
Use active-branch entries for the new state, as the extension contract specifies.
Do not silently migrate the existing all-entry member restore in this feature.
Reconcile live ownership and pending identities after reload or tree navigation.
Stop old supervisors before replacing branch state; abandoned branches must not emit notifications.

If shutdown interrupts preparation or dispatch, expose uncertainty through batch status.
The session log and ownership sidecars do not form an atomic transaction.

## Delivery guarantee

Guarantee one aggregate submission during normal execution, not exactly-once delivery across crashes.
Use a stable event ID for duplicate recognition and persist terminal state for recovery inspection.
Record notification intent before submission. On restore, inspect the persisted aggregate message
before retrying an unresolved intent; an in-memory queued message can disappear on process exit.
A full durable outbox and parent acknowledgement protocol is outside this initial feature.
The design must document this crash window rather than hide it behind a sent boolean.

## Required tests

- Pure reducer: fixed membership, duplicate claims, exact identity, terminal failure, cancellation, and out-of-order completion.
- Notification routing: zero individual success events, one aggregate event, immediate deduplicated blocker events, and unchanged ungated tasks.
- Races: simultaneous completion, fast completion before other dispatches, concurrent asks, and ambiguous prompt acceptance.
- Recovery: reload, branch change, collected results, closed panes, foreign adoption, and interrupted notification submission.
- Live Pi/Herdr: idle parent, busy parent, blocker recovery, and two children with deliberately different completion times.

## Research artifacts

- `.pi/crew/barrier-runtime/result.md`: Pi runtime contract and delivery risks.
- `.pi/crew/barrier-lifecycle/result.md`: lifecycle, public API review, and test matrix.

## Validation so far

- `git status --short` returned no repository changes before this note.
- Read-only inspection confirmed the current per-member wake-up path.
- `/Users/gordon/.pi/agent/AGENTS.md:67-75` now specifies combined research delivery.
- `git diff --check` and a Python assertion check passed: one delivery section, combined-answer rule, and an explicit delivery limitation.
- Fresh review found two proposal defects: aggregate emission after failure and collection before watcher completion. Both received explicit rules.
- The implementation adds a synchronous batch reducer, explicit API, lifecycle hooks, and extension integration tests.
- `npm test && npm run typecheck && git diff --check` passed after the first review fixes: 73 tests passed.
- Follow-up review found role-prompt epoch, temporary-query, and guarded ownership-transfer defects. Each received a fix.
- Final `npm test && npm run typecheck && git diff --check` passed: 75 tests passed, zero failures.
- The final fixed-snapshot review found no residual regressions in the three-fix scope. The reviewer did not run commands or validate live host delivery.
- A real Pi/Herdr idle-parent and busy-parent batch experiment has not run.
