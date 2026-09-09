import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readTranscript } from "./transcript.ts";

async function readEntries(entries: unknown[]) {
  const dir = await mkdtemp(join(tmpdir(), "crew-transcript-"));
  const path = join(dir, "session.jsonl");
  await writeFile(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  try {
    return await readTranscript(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const summary = {
  type: "custom",
  customType: "zentui-turn-summary",
  timestamp: "2026-09-09T09:14:07.353Z",
  data: { durationMs: 100 },
};

function backgroundStart(id: string) {
  return {
    type: "message",
    message: {
      role: "toolResult",
      toolName: "bg_run",
      details: {
        task: {
          id,
          status: "running",
          notifyOnCompletion: true,
          triggerOnCompletion: true,
        },
      },
      content: [],
    },
  };
}

function backgroundDone(id: string) {
  return {
    type: "custom_message",
    customType: "background-task-notification",
    details: { id, status: "completed" },
  };
}

test("tracks a background task across the turn that launched it", async () => {
  const transcript = await readEntries([backgroundStart("task-1"), summary]);

  assert.equal(transcript.turnCount, 1);
  assert.equal(transcript.followUpPending, true);
});

test("waits for the follow-up turn after background completion", async () => {
  const waiting = await readEntries([backgroundStart("task-1"), summary, backgroundDone("task-1")]);
  assert.equal(waiting.followUpPending, true);

  const finished = await readEntries([
    backgroundStart("task-1"),
    summary,
    backgroundDone("task-1"),
    { ...summary, timestamp: "2026-09-09T09:14:25.967Z" },
  ]);
  assert.equal(finished.followUpPending, false);
  assert.equal(finished.turnCount, 2);
});

test("ignores notifications for tasks without an automatic follow-up", async () => {
  const noTrigger = backgroundStart("task-1") as any;
  noTrigger.message.details.task.triggerOnCompletion = false;
  const triggerTranscript = await readEntries([noTrigger, summary, backgroundDone("task-1")]);
  assert.equal(triggerTranscript.followUpPending, false);

  const noNotification = backgroundStart("task-2") as any;
  noNotification.message.details.task.notifyOnCompletion = false;
  const notificationTranscript = await readEntries([noNotification, summary, backgroundDone("task-2")]);
  assert.equal(notificationTranscript.followUpPending, false);
});

test("tracks multiple automatic follow-up tasks independently", async () => {
  const oneActive = await readEntries([
    backgroundStart("task-1"),
    backgroundStart("task-2"),
    summary,
    backgroundDone("task-1"),
    { ...summary, timestamp: "2026-09-09T09:14:25.967Z" },
  ]);
  assert.equal(oneActive.followUpPending, true);

  const allFinished = await readEntries([
    backgroundStart("task-1"),
    backgroundStart("task-2"),
    summary,
    backgroundDone("task-1"),
    { ...summary, timestamp: "2026-09-09T09:14:25.967Z" },
    backgroundDone("task-2"),
    { ...summary, timestamp: "2026-09-09T09:14:30.967Z" },
  ]);
  assert.equal(allFinished.followUpPending, false);
});
