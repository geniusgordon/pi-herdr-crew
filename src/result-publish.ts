import { randomUUID } from "node:crypto";
import { link, mkdir, open, rm } from "node:fs/promises";
import { dirname } from "node:path";

export async function publishResult(resultPath: string, content: string): Promise<void> {
  await mkdir(dirname(resultPath), { recursive: true });
  const temporary = `${resultPath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, resultPath);
  } catch (error) {
    await rm(temporary, { force: true });
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("This crew result was already submitted.");
    }
    throw error;
  }
  await rm(temporary, { force: true }).catch(() => {});
}
