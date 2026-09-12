import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { publishResult } from "./result-publish.ts";

test("publishes one result and rejects later submissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "crew-result-"));
  const result = join(root, "result.md");
  try {
    const submissions = await Promise.allSettled([
      publishResult(result, "first"),
      publishResult(result, "second"),
    ]);
    assert.equal(submissions.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(submissions.filter((item) => item.status === "rejected").length, 1);
    assert.match(await readFile(result, "utf8"), /^(first|second)$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
