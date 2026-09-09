import assert from "node:assert/strict";
import test from "node:test";

import {
  assertCanDispatch,
  isLiveObservation,
  isSamePending,
  notificationState,
  releaseWatcher,
  rollbackDispatch,
  shouldCheckState,
} from "./async-lifecycle.ts";
import type { Member, Pending } from "./registry.ts";

function member(pending?: Pending): Member {
  return {
    name: "reviewer",
    paneId: "p1",
    workspaceId: "w1",
    sessionPath: "/tmp/session.jsonl",
    cwd: "/tmp/repo",
    kind: "pi",
    openedAt: "2026-01-01T00:00:00.000Z",
    pending,
  };
}

const pending: Pending = {
  taskId: "audit",
  turn: 2,
  baseline: 1,
  result: "/tmp/result.md",
  sentAt: 1,
};

test("rejects a second dispatch before collect", () => {
  assert.throws(
    () => assertCanDispatch(member(pending)),
    /still has task audit pending/,
  );
  assert.doesNotThrow(() => assertCanDispatch(member()));
});

test("rolls back a dispatch that Herdr did not accept", () => {
  assert.deepEqual(rollbackDispatch(member(pending), pending), {
    ...member(pending),
    task: "audit",
    turns: 2,
    lastResult: "/tmp/result.md",
    pending: undefined,
  });
});

test("matches only the task owned by a watcher", () => {
  assert.equal(isSamePending(pending, { taskId: "audit", turn: 2 }), true);
  assert.equal(isSamePending(undefined, { taskId: "audit", turn: 2 }), false);
  assert.equal(isSamePending({ ...pending, turn: 3 }, { taskId: "audit", turn: 2 }), false);
  assert.equal(isSamePending({ ...pending, taskId: "other" }, { taskId: "audit", turn: 2 }), false);
});

test("maps terminal observations to notification states", () => {
  assert.equal(notificationState({ kind: "done" }), "done");
  assert.equal(notificationState({ kind: "blocked" }), "blocked");
  assert.equal(notificationState({ kind: "pending", state: "gone" }), "gone");
  assert.equal(notificationState({ kind: "pending", state: "working" }), undefined);
});

test("checks state each second during a blocked episode", () => {
  assert.equal(shouldCheckState({ ...pending, notifiedState: "blocked" }, 1), true);
  assert.equal(shouldCheckState(pending, 1), false);
  assert.equal(shouldCheckState(pending, 5), true);
});

test("identifies a live state after a blocked episode", () => {
  assert.equal(isLiveObservation({ kind: "pending", state: "working" }), true);
  assert.equal(isLiveObservation({ kind: "pending", state: "idle" }), true);
  assert.equal(isLiveObservation({ kind: "pending", state: "unknown" }), false);
  assert.equal(isLiveObservation({ kind: "pending", state: "gone" }), false);
  assert.equal(isLiveObservation({ kind: "blocked" }), false);
});

test("a stale watcher cannot delete its replacement", () => {
  const oldController = new AbortController();
  const replacement = new AbortController();
  const watchers = new Map([["reviewer", replacement]]);

  releaseWatcher(watchers, "reviewer", oldController);
  assert.equal(watchers.get("reviewer"), replacement);

  releaseWatcher(watchers, "reviewer", replacement);
  assert.equal(watchers.has("reviewer"), false);
});
