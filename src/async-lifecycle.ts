import type { Member, Pending } from "./registry.js";

export type SettledState = "done" | "blocked" | "gone";

export type WatchOutcome =
  | { kind: "done" }
  | { kind: "blocked" }
  | { kind: "pending"; state: string };

export type PendingIdentity = Pick<Pending, "taskId" | "turn">;

export type CompletionObservation = {
  baseline: number;
  turnCount: number;
  state: string;
  resultExpected: boolean;
  resultExists: boolean;
  followUpPending?: boolean;
  settledForMs?: number;
};

export const INLINE_SETTLE_MS = 2_000;

/** Require a new turn, a settled member, and the expected result artifact. */
export function classifyTaskCompletion(observation: CompletionObservation): WatchOutcome {
  if (observation.state === "blocked") return { kind: "blocked" };
  if (observation.state === "gone") return { kind: "pending", state: "gone" };
  if (observation.turnCount <= observation.baseline) {
    return { kind: "pending", state: observation.state };
  }
  if (observation.state !== "idle" && observation.state !== "done") {
    return { kind: "pending", state: observation.state };
  }
  if (observation.followUpPending) return { kind: "pending", state: observation.state };
  if (!observation.resultExpected && (observation.settledForMs ?? 0) < INLINE_SETTLE_MS) {
    return { kind: "pending", state: observation.state };
  }
  if (observation.resultExpected && !observation.resultExists) {
    return { kind: "pending", state: observation.state };
  }
  return { kind: "done" };
}

/** Clear task ownership only after result collection succeeds. */
export function finalizeCollectedTask(member: Member, succeeded: boolean): Member {
  return succeeded ? { ...member, pending: undefined } : member;
}

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
  return pending.notifiedState === "blocked" || pending.settledAt !== undefined || tick % 5 === 0;
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
