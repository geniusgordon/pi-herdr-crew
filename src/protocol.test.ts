import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { markdownPreview, readDisplayMarkdown, readMarkdownDisplay, renderBrief, reserveTurn, writeIgnore } from "./protocol.ts";

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

test("builds a bounded Markdown preview", () => {
  assert.equal(
    markdownPreview("# Title\n\nFirst line\nSecond line\nThird line\nFourth line"),
    "# Title\nFirst line\nSecond line\nThird line\n... 1 more lines",
  );
});

test("reads a durable Markdown display", async () => {
  const root = await mkdtemp(join(tmpdir(), "crew-display-"));
  const path = join(root, ".pi", "crew", "audit", "result.md");
  try {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "# Result\n\nComplete answer.\n", "utf8");
    assert.deepEqual(await readMarkdownDisplay(path, root, "result"), {
      kind: "result",
      path: ".pi/crew/audit/result.md",
      preview: "# Result\nComplete answer.",
    });
    assert.equal(readDisplayMarkdown(root, ".pi/crew/audit/result.md"), "# Result\n\nComplete answer.\n");
    assert.throws(() => readDisplayMarkdown(root, "README.md"), /outside \.pi\/crew/);

    const outside = join(root, "secret.md");
    const link = join(root, ".pi", "crew", "audit", "linked.md");
    await writeFile(outside, "secret", "utf8");
    await symlink(outside, link);
    assert.throws(() => readDisplayMarkdown(root, ".pi/crew/audit/linked.md"), /not a regular file/);
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
