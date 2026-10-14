import { randomUUID } from "node:crypto";

export const BATCH_ENTRY = "herdr-crew-batch-state";
export type TaskBinding = {
  memberName: string; memberId: string; ownerSessionId: string; generation: number; taskId: string; turn: number;
};
export type SlotState = "awaiting-dispatch" | "preparing" | "running" | "dispatch-uncertain" |
  "done" | "dispatch-failed" | "gone" | "closed" | "ownership-lost" | "cancelled";
export type BatchSlot = { state: SlotState; binding?: TaskBinding; attentionSubmitted?: boolean };
export type Batch = {
  version: 1; id: string; eventId: string; ownerSessionId: string; cwd: string;
  slots: Record<string, BatchSlot>; cancelled: boolean; allDone: boolean; submitted: boolean;
};
const terminal = new Set<SlotState>(["done", "dispatch-failed", "gone", "closed", "ownership-lost", "cancelled"]);

export function sameBinding(a: TaskBinding, b: TaskBinding): boolean {
  return a.memberName === b.memberName && a.memberId === b.memberId && a.generation === b.generation &&
    a.ownerSessionId === b.ownerSessionId && a.taskId === b.taskId && a.turn === b.turn;
}

/** Synchronous transitions serialize watcher observations within one parent runtime. */
export class CompletionBarriers {
  private batches = new Map<string, Batch>();
  private delivered = new Set<string>();
  private submitted = new Set<string>();
  private hooks: { persist: (batch: Batch) => void; notify: (batch: Batch) => void; attention?: (batch: Batch, name: string) => void };

  constructor(hooks: { persist: (batch: Batch) => void; notify: (batch: Batch) => void; attention?: (batch: Batch, name: string) => void }) { this.hooks = hooks; }

  create(names: string[], ownerSessionId: string, cwd: string): Batch {
    if (!names.length) throw new Error("A batch needs a nonempty expected_members list.");
    if (new Set(names).size !== names.length) throw new Error("A batch cannot contain duplicate members.");
    if (names.some((name) => !/^[a-z][a-z0-9_-]{0,31}$/.test(name))) throw new Error("A batch has an invalid member name.");
    const batch: Batch = { version: 1, id: randomUUID(), eventId: randomUUID(), ownerSessionId, cwd,
      slots: Object.fromEntries(names.map((name) => [name, { state: "awaiting-dispatch" }])),
      cancelled: false, allDone: false, submitted: false };
    this.save(batch);
    return batch;
  }

  get(id: string, ownerSessionId: string): Batch {
    const batch = this.batches.get(id);
    if (!batch) throw new Error(`Unknown batch ${id}.`);
    if (batch.ownerSessionId !== ownerSessionId) throw new Error(`Batch ${id} belongs to another session.`);
    return batch;
  }

  list(): Batch[] { return [...this.batches.values()]; }
  has(id: string): boolean { return this.batches.has(id); }
  active(id: string): boolean { return this.batches.has(id) && !this.batches.get(id)!.cancelled; }

  claim(id: string, name: string, owner: string): void {
    const batch = this.get(id, owner);
    if (batch.cancelled || batch.submitted) throw new Error(`Batch ${id} is already settled or cancelled.`);
    const slot = Object.hasOwn(batch.slots, name) ? batch.slots[name] : undefined;
    if (!slot) throw new Error(`Member ${name} is not expected in batch ${id}.`);
    if (slot.state !== "awaiting-dispatch") throw new Error(`Member ${name} already claimed its batch slot.`);
    this.save({ ...batch, slots: { ...batch.slots, [name]: { state: "preparing" } } });
  }

  bind(id: string, binding: TaskBinding): void {
    const batch = this.get(id, binding.ownerSessionId);
    if (batch.cancelled || batch.slots[binding.memberName]?.state !== "preparing") {
      throw new Error(`Batch ${id} has no preparing slot for ${binding.memberName}.`);
    }
    this.save({ ...batch, slots: { ...batch.slots, [binding.memberName]: { state: "running", binding } } });
  }

  observe(id: string, binding: TaskBinding, state: SlotState): boolean {
    if (!this.active(id)) return false;
    const batch = this.get(id, binding.ownerSessionId);
    const slot = batch.slots[binding.memberName];
    if (!slot?.binding || !sameBinding(slot.binding, binding)) return false;
    if (!terminal.has(slot.state)) {
      this.save({ ...batch, slots: { ...batch.slots, [binding.memberName]: { ...slot, state } } });
    }
    this.attend(id, binding.memberName);
    this.release(id);
    return true;
  }

  failDispatch(id: string, name: string): void {
    const batch = this.batches.get(id);
    if (!batch || batch.cancelled || batch.slots[name]?.state !== "preparing") return;
    this.save({ ...batch, slots: { ...batch.slots, [name]: { state: "dispatch-failed" } } });
    this.release(id);
  }

  cancel(id: string, owner: string): void {
    const batch = this.get(id, owner);
    this.save({ ...batch, cancelled: true, slots: Object.fromEntries(Object.entries(batch.slots).map(([name, slot]) =>
      [name, terminal.has(slot.state) ? slot : { ...slot, state: "cancelled" }])) });
  }

  restore(entries: Iterable<any>, owner: string, freshRuntime = false): void {
    this.batches.clear();
    this.delivered.clear();
    if (freshRuntime) this.submitted.clear();
    for (const entry of entries) {
      if (entry?.type === "custom" && entry.customType === BATCH_ENTRY && entry.data?.version === 1 &&
          entry.data.ownerSessionId === owner) this.batches.set(entry.data.id, structuredClone(entry.data));
      if (entry?.type === "custom_message" && entry.customType === "herdr-crew-batch" && entry.details?.eventId) {
        this.delivered.add(entry.details.eventId);
      }
    }
    for (const batch of this.batches.values()) batch.submitted = this.delivered.has(batch.eventId) || this.submitted.has(batch.eventId);
  }

  resumeNotifications(): void {
    for (const batch of this.batches.values()) {
      for (const name of Object.keys(batch.slots)) this.attend(batch.id, name);
      this.release(batch.id);
    }
  }

  private attend(id: string, name: string): void {
    const batch = this.batches.get(id)!;
    const slot = batch.slots[name]!;
    if (batch.cancelled || slot.attentionSubmitted || !["gone", "ownership-lost"].includes(slot.state)) return;
    this.save({ ...batch, slots: { ...batch.slots, [name]: { ...slot, attentionSubmitted: true } } });
    this.hooks.attention?.(this.batches.get(id)!, name);
  }

  private save(batch: Batch): void {
    this.hooks.persist(batch);
    this.batches.set(batch.id, batch);
  }

  private release(id: string): void {
    const batch = this.batches.get(id)!;
    if (batch.cancelled || batch.submitted || !Object.values(batch.slots).every((slot) => terminal.has(slot.state))) return;
    const ready = { ...batch, allDone: Object.values(batch.slots).every((slot) => slot.state === "done"), submitted: false };
    this.save(ready);
    this.hooks.notify(ready);
    this.submitted.add(ready.eventId);
    this.save({ ...ready, submitted: true });
  }
}
