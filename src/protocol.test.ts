import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { renderBrief, reserveTurn, writeIgnore } from "./protocol.ts";

const base = {
  member: "reviewer",
  task: "Review the change.",
  result: "/repo/.pi/crew/review/result.md",
  dir: "/repo/.pi/crew/review",
  memberCwd: "/repo",
};

test("preserves project roles in the crew ignore file", async () => {
  const root = await mkdtemp(join(tmpdir(), "crew-ignore-"));
  try {
    await writeIgnore(root);
    assert.equal(
      await readFile(join(root, ".pi", "crew", ".gitignore"), "utf8"),
      "# Crew orchestration scratch data. Never shared work.\n*\n!roles/\n!roles/**\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("updates the legacy crew ignore file", async () => {
  const root = await mkdtemp(join(tmpdir(), "crew-ignore-"));
  const directory = join(root, ".pi", "crew");
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, ".gitignore"), "# Crew orchestration scratch data. Never shared work.\n*\n");
    await writeIgnore(root);
    assert.equal(
      await readFile(join(directory, ".gitignore"), "utf8"),
      "# Crew orchestration scratch data. Never shared work.\n*\n!roles/\n!roles/**\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects the reserved roles task id", async () => {
  const root = await mkdtemp(join(tmpdir(), "crew-turn-"));
  try {
    await assert.rejects(reserveTurn(root, "roles"), /reserved for crew role presets/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reserves distinct turns concurrently", async () => {
  const root = await mkdtemp(join(tmpdir(), "crew-turn-"));
  try {
    const turns = await Promise.all([reserveTurn(root, "audit"), reserveTurn(root, "audit")]);
    assert.deepEqual(turns.sort(), [1, 2]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("renders a token-only result contract for Pi members", () => {
  const brief = renderBrief({ ...base, resultToken: "task-token" });
  assert.match(brief, /crew_submit_result/);
  assert.match(brief, /task-token/);
  assert.doesNotMatch(brief, /Write your complete answer to this exact absolute path/);
});

test("renders the file contract for non-Pi members", () => {
  const brief = renderBrief(base);
  assert.match(brief, /Write your complete answer to this exact absolute path/);
  assert.match(brief, /\/repo\/\.pi\/crew\/review\/result\.md/);
  assert.doesNotMatch(brief, /Call `crew_submit_result`/);
});
