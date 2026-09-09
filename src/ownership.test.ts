import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { OwnershipConflictError, OwnershipStore } from "./ownership.ts";

async function withStore(run: (store: OwnershipStore) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "crew-ownership-"));
  try {
    await run(new OwnershipStore(root));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("transfer preserves pending member state for the new owner", async () => {
  await withStore(async (store) => {
    const opened = await store.reserve({ memberName: "review-state", ownerSessionId: "owner-a" });
    const active = await store.activate(opened, {
      paneId: "w1:p4",
      sessionPath: "/sessions/member-state.jsonl",
    });
    const saved = await store.saveMember(active, {
      name: "review-state",
      pending: { taskId: "audit", turn: 1 },
    });

    const transferred = await store.transfer(saved, "owner-b");
    assert.deepEqual(transferred.member, {
      name: "review-state",
      pending: { taskId: "audit", turn: 1 },
    });
  });
});

test("a transfer cannot cross a current-owner operation", async () => {
  await withStore(async (store) => {
    const opened = await store.reserve({ memberName: "review-rocket", ownerSessionId: "owner-a" });
    const active = await store.activate(opened, {
      paneId: "w1:p3",
      sessionPath: "/sessions/member-rocket.jsonl",
    });
    let releaseOperation = () => {};
    const operationStarted = new Promise<void>((resolve) => {
      releaseOperation = resolve;
    });
    let enterOperation = () => {};
    const operationEntered = new Promise<void>((resolve) => {
      enterOperation = resolve;
    });

    const operation = store.runIfCurrent(active, async () => {
      enterOperation();
      await operationStarted;
      return "sent";
    });
    await operationEntered;
    const transfer = store.transfer(active, "owner-b");

    assert.equal((await store.get("review-rocket"))?.ownerSessionId, "owner-a");
    releaseOperation();
    assert.equal(await operation, "sent");
    assert.equal((await transfer).ownerSessionId, "owner-b");
  });
});

test("an ownership identity becomes stale after transfer", async () => {
  await withStore(async (store) => {
    const opened = await store.reserve({ memberName: "review-web", ownerSessionId: "owner-a" });
    const active = await store.activate(opened, {
      paneId: "w1:p1",
      sessionPath: "/sessions/member-web.jsonl",
    });

    assert.equal(await store.isCurrent(active), true);
    await store.transfer(active, "owner-b");
    assert.equal(await store.isCurrent(active), false);
  });
});

test("only one session can transfer the same ownership generation", async () => {
  await withStore(async (store) => {
    const opened = await store.reserve({
      memberName: "review-api",
      ownerSessionId: "owner-a",
    });
    const active = await store.activate(opened, {
      paneId: "w1:p2",
      sessionPath: "/sessions/member-a.jsonl",
    });

    const attempts = await Promise.allSettled([
      store.transfer(active, "owner-b"),
      store.transfer(active, "owner-c"),
    ]);

    assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    assert.ok(rejected?.status === "rejected");
    assert.ok(rejected.reason instanceof OwnershipConflictError);

    const current = await store.get("review-api");
    assert.equal(current?.generation, 2);
    assert.ok(current?.ownerSessionId === "owner-b" || current?.ownerSessionId === "owner-c");
  });
});
