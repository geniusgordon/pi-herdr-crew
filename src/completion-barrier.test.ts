import assert from "node:assert/strict";
import test from "node:test";
import { CompletionBarriers, BATCH_ENTRY, type TaskBinding } from "./completion-barrier.ts";

const binding = (memberName: string, turn = 1): TaskBinding => ({
  memberName, memberId: memberName, ownerSessionId: "parent", generation: 1, taskId: `${memberName}-audit`, turn,
});

function setup(names = ["api", "tests"]) {
  const entries: any[] = [];
  const messages: any[] = [];
  const barriers = new CompletionBarriers({
    persist: (record) => entries.push({ type: "custom", customType: BATCH_ENTRY, data: structuredClone(record) }),
    notify: (record) => messages.push(structuredClone(record)),
  });
  const batch = barriers.create(names, "parent", "/repo");
  return { barriers, batch, entries, messages };
}

test("waits for the fixed required set, then submits one aggregate", () => {
  const { barriers, batch, messages } = setup();
  barriers.claim(batch.id, "api", "parent");
  barriers.bind(batch.id, binding("api"));
  assert.equal(barriers.observe(batch.id, binding("api"), "done"), true);
  assert.equal(messages.length, 0);
  barriers.claim(batch.id, "tests", "parent");
  barriers.bind(batch.id, binding("tests"));
  barriers.observe(batch.id, binding("tests"), "done");
  barriers.observe(batch.id, binding("tests"), "done");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].allDone, true);
});

test("validates membership and rejects repeated or foreign claims", () => {
  const { barriers, batch } = setup();
  assert.throws(() => barriers.create([], "parent", "/repo"), /nonempty/);
  assert.throws(() => barriers.create(["api", "api"], "parent", "/repo"), /duplicate/);
  assert.throws(() => barriers.create(["BAD"], "parent", "/repo"), /invalid/);
  assert.throws(() => barriers.claim(batch.id, "other", "parent"), /expected/);
  assert.throws(() => barriers.claim(batch.id, "api", "foreign"), /another/);
  barriers.claim(batch.id, "api", "parent");
  assert.throws(() => barriers.claim(batch.id, "api", "parent"), /claimed/);
});

test("rejects stale task and ownership identities", () => {
  const { barriers, batch, messages } = setup(["api"]);
  barriers.claim(batch.id, "api", "parent");
  barriers.bind(batch.id, binding("api"));
  for (const stale of [binding("api", 2), { ...binding("api"), generation: 2 }, { ...binding("api"), memberId: "replacement" }]) {
    assert.equal(barriers.observe(batch.id, stale, "done"), false);
  }
  assert.equal(messages.length, 0);
});

test("settles failed dispatches without claiming all tasks completed", () => {
  const { barriers, batch, messages } = setup();
  barriers.claim(batch.id, "api", "parent");
  barriers.failDispatch(batch.id, "api");
  barriers.claim(batch.id, "tests", "parent");
  barriers.bind(batch.id, binding("tests"));
  barriers.observe(batch.id, binding("tests"), "gone");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].allDone, false);
});

test("blocked and uncertain slots remain unresolved", () => {
  const { barriers, batch, messages } = setup(["api"]);
  barriers.claim(batch.id, "api", "parent");
  barriers.bind(batch.id, binding("api"));
  barriers.observe(batch.id, binding("api"), "dispatch-uncertain");
  assert.equal(barriers.get(batch.id, "parent").slots.api.state, "dispatch-uncertain");
  assert.equal(messages.length, 0);
  barriers.observe(batch.id, binding("api"), "done");
  assert.equal(messages.length, 1);
});

test("cancellation releases grouping but preserves completed outcomes", () => {
  const { barriers, batch, messages } = setup();
  barriers.claim(batch.id, "api", "parent");
  barriers.bind(batch.id, binding("api"));
  barriers.observe(batch.id, binding("api"), "done");
  barriers.cancel(batch.id, "parent");
  assert.equal(barriers.active(batch.id), false);
  assert.equal(barriers.observe(batch.id, binding("api"), "done"), false);
  assert.equal(barriers.get(batch.id, "parent").slots.api.state, "done");
  assert.equal(barriers.get(batch.id, "parent").slots.tests.state, "cancelled");
  assert.equal(messages.length, 0);
});

test("restores a pending batch without losing a collected completion", () => {
  const { barriers, batch, entries, messages } = setup();
  barriers.claim(batch.id, "api", "parent");
  barriers.bind(batch.id, binding("api"));
  barriers.observe(batch.id, binding("api"), "done");
  barriers.restore(entries, "parent");
  barriers.claim(batch.id, "tests", "parent");
  barriers.bind(batch.id, binding("tests"));
  barriers.observe(batch.id, binding("tests"), "done");
  assert.equal(messages.length, 1);
});

test("reload retries missing queued events, but not persisted aggregate messages", () => {
  const { barriers, batch, entries, messages } = setup(["api"]);
  barriers.claim(batch.id, "api", "parent");
  barriers.bind(batch.id, binding("api"));
  barriers.observe(batch.id, binding("api"), "done");
  const saved = [...entries];
  barriers.restore(saved, "parent", true);
  barriers.resumeNotifications();
  assert.equal(messages.length, 2);
  barriers.restore([...saved, { type: "custom_message", customType: "herdr-crew-batch", details: { eventId: batch.eventId } }], "parent");
  barriers.resumeNotifications();
  assert.equal(messages.length, 2);
});

test("same-runtime tree restoration preserves queued aggregate submission", () => {
  const { barriers, batch, entries, messages } = setup(["api"]);
  barriers.claim(batch.id, "api", "parent");
  barriers.bind(batch.id, binding("api"));
  barriers.observe(batch.id, binding("api"), "done");
  barriers.restore(entries, "parent");
  barriers.resumeNotifications();
  assert.equal(messages.length, 1);
});

test("active branch restoration discards abandoned and foreign batches", () => {
  const { barriers, batch, entries } = setup();
  barriers.restore(entries, "foreign");
  assert.equal(barriers.active(batch.id), false);
  barriers.restore([], "parent");
  assert.equal(barriers.active(batch.id), false);
});
