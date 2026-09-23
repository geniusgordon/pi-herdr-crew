import assert from "node:assert/strict";
import test from "node:test";

import { waitForAgentSession } from "./session-readiness.ts";

test("waits until a started agent reports its Pi session", async () => {
  const observations = [
    { agent_status: "working" },
    { agent_status: "working", agent_session: { value: "/tmp/member.jsonl" } },
  ];
  let now = 0;

  const agent = await waitForAgentSession(
    observations.shift(),
    async () => observations.shift(),
    { timeoutMs: 1_000, pollMs: 10, now: () => now, delay: async (ms) => { now += ms; } },
  );

  assert.equal(agent?.agent_session?.value, "/tmp/member.jsonl");
});

test("does not accept a session reported after the deadline", async () => {
  const initial = { agent_status: "working" };
  let now = 0;
  let observations = 0;
  const remaining: number[] = [];

  const agent = await waitForAgentSession(
    initial,
    async (remainingMs) => {
      remaining.push(remainingMs);
      observations += 1;
      now += 15;
      return { agent_session: { value: "/tmp/late.jsonl" } };
    },
    { timeoutMs: 20, pollMs: 10, now: () => now, delay: async (ms) => { now += ms; } },
  );

  assert.equal(agent, initial);
  assert.equal(observations, 1);
  assert.deepEqual(remaining, [10]);
});

test("stops an active polling delay when cancelled", async () => {
  const controller = new AbortController();

  const waiting = waitForAgentSession(undefined, async () => undefined, {
    timeoutMs: 1_000,
    pollMs: 500,
    signal: controller.signal,
  });
  controller.abort();

  await assert.rejects(waiting, { name: "AbortError" });
});

test("retries a temporary observation failure", async () => {
  let now = 0;
  let observations = 0;

  const agent = await waitForAgentSession(
    undefined,
    async () => {
      observations += 1;
      if (observations === 1) throw new Error("temporary");
      return { agent_session: { value: "/tmp/member.jsonl" } };
    },
    {
      timeoutMs: 30,
      pollMs: 10,
      now: () => now,
      delay: async (ms) => { now += ms; },
      shouldRetry: (error) => error instanceof Error && error.message === "temporary",
    },
  );

  assert.equal(agent?.agent_session?.value, "/tmp/member.jsonl");
  assert.equal(observations, 2);
});
