import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildPiRoleArgs, buildRoleTaskPrompts, discoverRoles, parseRole } from "./roles.ts";

test("parses a role prompt and defaults", () => {
  assert.deepEqual(
    parseRole(
      `---\nname: reviewer\ndescription: Review code\nkind: pi\ntools: read, grep, find, ls\n---\n\nReview the assigned change.\n`,
      "/tmp/reviewer.md",
      "global",
    ),
    {
      name: "reviewer",
      description: "Review code",
      kind: "pi",
      tools: ["read", "grep", "find", "ls"],
      prompt: "Review the assigned change.",
      path: "/tmp/reviewer.md",
      source: "global",
    },
  );
});

test("parses one role skill", () => {
  const role = parseRole(
    "---\nname: worker\nskills: implement\n---\nImplement the task.",
    "/tmp/worker.md",
    "global",
  );
  assert.deepEqual(role.skills, ["implement"]);
});

test("preserves multiple role skills in declaration order", () => {
  const role = parseRole(
    "---\nname: worker\nskills: implement, tdd\n---\nImplement the task.",
    "/tmp/worker.md",
    "global",
  );
  assert.deepEqual(role.skills, ["implement", "tdd"]);
});

test("rejects an empty skill list", () => {
  for (const declaration of ["skills:", "skills:   ", 'skills: ""']) {
    assert.throws(
      () => parseRole(`---\nname: worker\n${declaration}\n---\nImplement.`, "/tmp/worker.md", "global"),
      /skills must contain at least one/,
    );
  }
});

test("rejects invalid skill names", () => {
  for (const skills of ["tdd, Bad_Skill", "tdd,", "-tdd", "tdd--fast"]) {
    assert.throws(
      () => parseRole(`---\nname: worker\nskills: ${skills}\n---\nImplement.`, "/tmp/worker.md", "global"),
      /skills must be comma-separated names/,
    );
  }
});

test("omits skills when no skill list is declared", () => {
  const role = parseRole("---\nname: worker\n---\nImplement.", "/tmp/worker.md", "global");
  assert.equal(role.skills, undefined);
});

test("builds ordered skill commands before the task prompt", () => {
  const role = parseRole(
    "---\nname: worker\nskills: implement,tdd\n---\nImplement.",
    "/tmp/worker.md",
    "global",
  );
  assert.deepEqual(buildRoleTaskPrompts(role, "Read /tmp/brief.md and follow it exactly."), [
    "/skill:implement",
    "/skill:tdd",
    "Read /tmp/brief.md and follow it exactly.",
  ]);
  assert.deepEqual(buildRoleTaskPrompts(undefined, "Do the task."), ["Do the task."]);
});

test("builds Pi arguments from role capabilities", () => {
  const role = parseRole(
    "---\nname: reviewer\ntools: read, grep\n---\nReview the assigned change.",
    "/tmp/reviewer.md",
    "global",
  );
  const directory = mkdtempSync(join(tmpdir(), "crew-role-prompt-"));
  const args = buildPiRoleArgs(role, directory);
  assert.deepEqual(args.slice(0, 3), [
    "--tools",
    "read,grep,crew_submit_result",
    "--append-system-prompt",
  ]);
  assert.match(args[3]!, /\/reviewer-[a-f0-9]{16}\.md$/);
  rmSync(directory, { recursive: true, force: true });
});

test("accepts quoted names and a BOM", () => {
  const role = parseRole(
    "\uFEFF---\r\nname: \"reviewer\"\r\n---\r\nReview.\r\n",
    "/tmp/reviewer.md",
    "global",
  );
  assert.equal(role.name, "reviewer");
  assert.equal(role.prompt, "Review.");
});

test("rejects an empty tool allowlist", () => {
  assert.throws(
    () => parseRole("---\nname: reviewer\ntools:\n---\nReview.", "/tmp/reviewer.md", "global"),
    /tools must contain at least one/,
  );
});

test("rejects non-Pi role kinds", () => {
  assert.throws(
    () => parseRole("---\nname: reviewer\nkind: claude\n---\nReview.", "/tmp/reviewer.md", "global"),
    /roles currently support pi only/,
  );
});

test("rejects malformed role capabilities", () => {
  assert.throws(
    () => parseRole("---\nname: reviewer\ntools: read, ../write\n---\nReview.", "/tmp/reviewer.md", "global"),
    /tools must be comma-separated names/,
  );
});

test("project roles override global roles when trusted", () => {
  const root = mkdtempSync(join(tmpdir(), "crew-roles-"));
  const originalHome = process.env.HOME;
  process.env.HOME = root;
  try {
    mkdirSync(join(root, ".pi", "agent", "agents"), { recursive: true });
    mkdirSync(join(root, "repo", ".pi", "agents"), { recursive: true });
    writeFileSync(join(root, ".pi", "agent", "agents", "reviewer.md"), "---\nname: reviewer\n---\nGlobal prompt.\n");
    writeFileSync(join(root, "repo", ".pi", "agents", "reviewer.md"), "---\nname: reviewer\n---\nProject prompt.\n");

    assert.equal(discoverRoles(join(root, "repo"), false).roles[0]?.prompt, "Global prompt.");
    assert.equal(discoverRoles(join(root, "repo"), true).roles[0]?.prompt, "Project prompt.");
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(root, { recursive: true, force: true });
  }
});
