import type { Member, Pending } from "./registry.js";

export type SettledState = "done" | "blocked" | "gone";

export type WatchOutcome =
  | { kind: "done" }
  | { kind: "blocked" }
  | { kind: "pending"; state: string };

export type PendingIdentity = Pick<Pending, "taskId" | "turn">;

/** Match a current pending task against the watcher task. */
export function isSamePending(current: Pending | undefined, watched: PendingIdentity): current is Pending {
  return current?.taskId === watched.taskId && current.turn === watched.turn;
}

/** Require one collected task before a member accepts another task. */
export function assertCanDispatch(member: Member): void {
  if (!member.pending) return;
  throw new Error(
    `Member ${member.name} still has task ${member.pending.taskId} pending. ` +
      `Wait for its notification, then collect it before asking again.`,
  );
}

/** Keep task metadata but clear a task that Herdr did not accept. */
export function rollbackDispatch(member: Member, pending: Pending): Member {
  return {
    ...member,
    task: pending.taskId,
    turns: pending.turn,
    lastResult: pending.result,
    pending: undefined,
  };
}

/** Convert a watcher observation into a parent notification state. */
export function notificationState(outcome: WatchOutcome): SettledState | undefined {
  if (outcome.kind === "done") return "done";
  if (outcome.kind === "blocked") return "blocked";
  return outcome.state === "gone" ? "gone" : undefined;
}

export function shouldCheckState(pending: Pending, tick: number): boolean {
  return pending.notifiedState === "blocked" || tick % 5 === 0;
}

export function isLiveObservation(outcome: WatchOutcome): boolean {
  return outcome.kind === "pending" && outcome.state !== "unknown" && outcome.state !== "gone";
}

/** Delete a watcher only when the finishing controller still owns its slot. */
export function releaseWatcher(
  watchers: Map<string, AbortController>,
  memberName: string,
  controller: AbortController,
): void {
  if (watchers.get(memberName) === controller) watchers.delete(memberName);
}
