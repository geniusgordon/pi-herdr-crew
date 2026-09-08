import assert from "node:assert/strict";
import test from "node:test";

import { classifyTaskResult, planCleanup, settleCleanup } from "./lifecycle.ts";

function harness(options: {
  policy?: "after-result" | "keep";
  durable?: boolean;
  state?: string;
  dirty?: boolean;
  closeError?: Error;
} = {}) {
  let closeCalls = 0;
  const result = settleCleanup({
    member: "reviewer",
    policy: options.policy ?? "after-result",
    durable: options.durable ?? true,
    getState: async () => options.state ?? "done",
    close: async () => {
      closeCalls += 1;
      if (options.closeError) throw options.closeError;
      return { text: "closed", dirty: options.dirty };
    },
  });
  return { result, closeCalls: () => closeCalls };
}

test("classifies file and inline run results", () => {
  assert.deepEqual(classifyTaskResult({ result: { exists: true } }, false), {
    durable: true,
    deferred: false,
  });
  assert.deepEqual(classifyTaskResult({ final: "done" }, true), {
    durable: true,
    deferred: false,
  });
});

test("classifies blocked, timed-out, and missing run results", () => {
  for (const details of [{ blocked: true }, { pending: true }, { resultMissing: true }]) {
    assert.deepEqual(classifyTaskResult(details, false), {
      durable: false,
      deferred: true,
    });
  }
});

test("keep policy wins for a pending background run", () => {
  const decision = classifyTaskResult({ pending: true }, false);
  assert.deepEqual(planCleanup("keep", decision), { kind: "keep" });
  assert.deepEqual(planCleanup("after-result", decision), { kind: "defer" });
});

test("closes after a durable result", async () => {
  const subject = harness();
  assert.deepEqual(await subject.result, {
    state: "closed",
    message: "Panel: closed automatically for member reviewer.",
  });
  assert.equal(subject.closeCalls(), 1);
});

test("keeps the panel when the caller selects keep", async () => {
  const subject = harness({ policy: "keep" });
  assert.equal((await subject.result).state, "kept");
  assert.equal(subject.closeCalls(), 0);
});

test("keeps the panel when the result file is missing", async () => {
  const subject = harness({ durable: false });
  assert.equal((await subject.result).state, "deferred");
  assert.equal(subject.closeCalls(), 0);
});

test("keeps blocked, timed-out, unknown, and lost panels", async (t) => {
  for (const state of ["blocked", "working", "unknown", "gone"]) {
    await t.test(state, async () => {
      const subject = harness({ state });
      assert.equal((await subject.result).state, "deferred");
      assert.equal(subject.closeCalls(), 0);
    });
  }
});

test("keeps a dirty worktree", async () => {
  const subject = harness({ dirty: true });
  assert.equal((await subject.result).state, "retained-dirty");
  assert.equal(subject.closeCalls(), 1);
});

test("preserves the result when cleanup fails", async () => {
  const subject = harness({ closeError: new Error("Herdr unavailable") });
  assert.deepEqual(await subject.result, {
    state: "failed",
    message: "Panel: automatic cleanup failed for member reviewer: Herdr unavailable",
  });
  assert.equal(subject.closeCalls(), 1);
});
