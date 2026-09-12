import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const RESULT_CAPABILITY_ROOT = join(homedir(), ".pi", "agent", "crew", "results");

export type ResultCapability = {
  resultPath: string | null;
  token: string;
};

export function assertResultToken(capability: ResultCapability, token: string): string {
  if (token !== capability.token) throw new Error("The crew result token is stale or invalid.");
  if (capability.resultPath === null) throw new Error("This crew task uses an inline result.");
  return capability.resultPath;
}

export function resultCapabilityPath(sessionPath: string, root = RESULT_CAPABILITY_ROOT): string {
  const key = createHash("sha256").update(sessionPath).digest("hex");
  return join(root, `${key}.json`);
}

export async function writeResultCapability(
  sessionPath: string,
  capability: ResultCapability,
  root = RESULT_CAPABILITY_ROOT,
): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const target = resultCapabilityPath(sessionPath, root);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(capability)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
}

export async function readResultCapability(
  sessionPath: string,
  root = RESULT_CAPABILITY_ROOT,
): Promise<ResultCapability> {
  const body = await readFile(resultCapabilityPath(sessionPath, root), "utf8");
  const parsed = JSON.parse(body) as { resultPath?: unknown; token?: unknown };
  if (typeof parsed.token !== "string" || !parsed.token) {
    throw new Error("The crew result capability is invalid.");
  }
  if (parsed.resultPath !== null && (typeof parsed.resultPath !== "string" || !parsed.resultPath.startsWith("/"))) {
    throw new Error("The crew result capability is invalid.");
  }
  return { resultPath: parsed.resultPath, token: parsed.token };
}
