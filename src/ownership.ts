import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import lockfile from "proper-lockfile";
import { join } from "node:path";

export type OwnershipRecord = {
  version: 1;
  memberId: string;
  memberName: string;
  ownerSessionId: string;
  generation: number;
  state: "opening" | "active";
  paneId?: string;
  sessionPath?: string;
  updatedAt: string;
  member?: unknown;
};

export type OwnershipIdentity = Pick<OwnershipRecord, "memberId" | "memberName" | "ownerSessionId" | "generation">;

export class OwnershipConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnershipConflictError";
  }
}

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 20;
const LOCK_STALE_MS = 30_000;

function fileName(memberName: string): string {
  return `${memberName}.json`;
}

function sameGeneration(current: OwnershipRecord, expected: OwnershipIdentity): boolean {
  return current.memberId === expected.memberId && current.generation === expected.generation;
}

export class OwnershipStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  async get(memberName: string): Promise<OwnershipRecord | undefined> {
    try {
      const text = await readFile(join(this.root, fileName(memberName)), "utf8");
      const record = JSON.parse(text) as OwnershipRecord;
      return record.version === 1 && record.memberName === memberName ? record : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async runIfCurrent<T>(expected: OwnershipIdentity, operation: (current: OwnershipRecord) => Promise<T> | T): Promise<T> {
    return this.withLock(expected.memberName, async () => {
      const current = await this.get(expected.memberName);
      if (!current || current.ownerSessionId !== expected.ownerSessionId || !sameGeneration(current, expected)) {
        throw new OwnershipConflictError(`Ownership for member ${expected.memberName} changed. Refresh the crew status.`);
      }
      return operation(current);
    });
  }

  async runAndSave<T>(
    expected: OwnershipIdentity,
    operation: (current: OwnershipRecord) => Promise<{ result: T; member: unknown }> | { result: T; member: unknown },
  ): Promise<T> {
    return this.withLock(expected.memberName, async () => {
      const current = await this.get(expected.memberName);
      if (!current || current.ownerSessionId !== expected.ownerSessionId || !sameGeneration(current, expected)) {
        throw new OwnershipConflictError(`Ownership for member ${expected.memberName} changed. Refresh the crew status.`);
      }
      const completed = await operation(current);
      await this.write({ ...current, member: completed.member, updatedAt: new Date().toISOString() });
      return completed.result;
    });
  }

  async runAndRelease<T>(expected: OwnershipIdentity, operation: () => Promise<T> | T): Promise<T> {
    return this.withLock(expected.memberName, async () => {
      const current = await this.get(expected.memberName);
      if (!current || current.ownerSessionId !== expected.ownerSessionId || !sameGeneration(current, expected)) {
        throw new OwnershipConflictError(`Ownership for member ${expected.memberName} changed. Refresh the crew status.`);
      }
      const result = await operation();
      await rm(join(this.root, fileName(expected.memberName)), { force: true });
      return result;
    });
  }

  async isCurrent(expected: OwnershipIdentity): Promise<boolean> {
    const current = await this.get(expected.memberName);
    return !!current && current.ownerSessionId === expected.ownerSessionId && sameGeneration(current, expected);
  }

  async release(expected: OwnershipIdentity): Promise<void> {
    await this.withLock(expected.memberName, async () => {
      const current = await this.get(expected.memberName);
      if (!current || !sameGeneration(current, expected)) return;
      await rm(join(this.root, fileName(expected.memberName)), { force: true });
    });
  }

  async reserve(input: { memberName: string; ownerSessionId: string }): Promise<OwnershipRecord> {
    return this.withLock(input.memberName, async () => {
      const current = await this.get(input.memberName);
      if (current) {
        throw new OwnershipConflictError(`Member ${input.memberName} already has an owner.`);
      }
      return this.write({
        version: 1,
        memberId: randomUUID(),
        memberName: input.memberName,
        ownerSessionId: input.ownerSessionId,
        generation: 1,
        state: "opening",
        updatedAt: new Date().toISOString(),
      });
    });
  }

  async activate(
    expected: OwnershipIdentity,
    live: { paneId: string; sessionPath: string },
  ): Promise<OwnershipRecord> {
    return this.update(expected.memberName, expected, (current) => ({
      ...current,
      ...live,
      state: "active",
      updatedAt: new Date().toISOString(),
    }));
  }

  async saveMember(expected: OwnershipIdentity, member: unknown): Promise<OwnershipRecord> {
    return this.update(expected.memberName, expected, (current) => ({
      ...current,
      member,
      updatedAt: new Date().toISOString(),
    }));
  }

  async transfer(expected: OwnershipIdentity, ownerSessionId: string): Promise<OwnershipRecord> {
    return this.update(expected.memberName, expected, (current) => ({
      ...current,
      ownerSessionId,
      generation: current.generation + 1,
      updatedAt: new Date().toISOString(),
    }));
  }

  private async update(
    memberName: string,
    expected: OwnershipIdentity,
    change: (current: OwnershipRecord) => OwnershipRecord,
  ): Promise<OwnershipRecord> {
    return this.withLock(memberName, async () => {
      const current = await this.get(memberName);
      if (!current || !sameGeneration(current, expected)) {
        throw new OwnershipConflictError(`Ownership for member ${memberName} changed. Refresh the crew status.`);
      }
      return this.write(change(current));
    });
  }

  private async write(record: OwnershipRecord): Promise<OwnershipRecord> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const target = join(this.root, fileName(record.memberName));
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
    return record;
  }

  private async withLock<T>(memberName: string, operation: () => Promise<T>): Promise<T> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const target = join(this.root, fileName(memberName));
    const release = await lockfile.lock(target, {
      realpath: false,
      stale: LOCK_STALE_MS,
      update: LOCK_STALE_MS / 2,
      retries: {
        retries: Math.ceil(LOCK_TIMEOUT_MS / LOCK_RETRY_MS),
        factor: 1,
        minTimeout: LOCK_RETRY_MS,
        maxTimeout: LOCK_RETRY_MS,
      },
    });

    try {
      return await operation();
    } finally {
      await release();
    }
  }
}
