import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import {
  assertResultToken,
  readResultCapability,
  resultCapabilityPath,
  writeResultCapability,
} from "./result-capability.ts";

test("maps one session to its current result path", async () => {
  const root = await mkdtemp(join(tmpdir(), "crew-result-capability-"));
  try {
    const session = "/tmp/member-session.jsonl";
    assert.match(basename(resultCapabilityPath(session, root)), /^[a-f0-9]{64}\.json$/);

    await writeResultCapability(session, { resultPath: "/tmp/result.md", token: "task-a" }, root);
    assert.deepEqual(await readResultCapability(session, root), {
      resultPath: "/tmp/result.md",
      token: "task-a",
    });

    await writeResultCapability(session, { resultPath: "/tmp/result-2.md", token: "task-b" }, root);
    assert.deepEqual(await readResultCapability(session, root), {
      resultPath: "/tmp/result-2.md",
      token: "task-b",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a stale task token", () => {
  const capability = { resultPath: "/tmp/result-2.md", token: "task-b" };
  assert.throws(() => assertResultToken(capability, "task-a"), /stale or invalid/);
  assert.equal(assertResultToken(capability, "task-b"), "/tmp/result-2.md");
});

test("rejects an inline task", async () => {
  const root = await mkdtemp(join(tmpdir(), "crew-result-capability-"));
  try {
    const session = "/tmp/member-session.jsonl";
    await writeResultCapability(session, { resultPath: null, token: "inline" }, root);
    const capability = await readResultCapability(session, root);
    assert.throws(() => assertResultToken(capability, "inline"), /inline result/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
