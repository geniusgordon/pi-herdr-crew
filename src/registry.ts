/**
 * Member bookkeeping.
 *
 * Herdr owns liveness: `herdr agent list` is the truth for pane and status.
 * This registry stores only what Herdr does not give back later, above all the
 * child session JSONL path used for clean reads.
 */

export type Member = {
  name: string;
  paneId: string;
  workspaceId: string;
  /** Set for a tab member and a worktree member. Closing a tab member closes this tab. */
  tabId?: string;
  sessionPath: string;
  cwd: string;
  kind: string;
  /** How the member got its terminal. It decides what close must remove. */
  layout?: "tab" | "split" | "worktree";
  /** Set when the member owns a Herdr git worktree. */
  worktree?: {
    path: string;
    branch: string;
    workspaceId: string;
    /** Workspace holding the main checkout, so the member groups under its repository. */
    sourceWorkspaceId?: string;
  };
  openedAt: string;
  closed?: boolean;
  /** True when this session found the member through `herdr agent list`, not through open. */
  adopted?: boolean;
  /** Current task id. It names the directory under .pi/crew. */
  task?: string;
  /** Turn number of the newest ask, for display. Disk, not this field, numbers the files. */
  turns?: number;
  /** Absolute path of the newest result file, for action "result". */
  lastResult?: string;
  /** A task that was sent and not collected yet. */
  pending?: Pending;
};

/**
 * A task in flight.
 *
 * It lets ask return at once and lets collect resume the wait. Without it a
 * single blocking call can exceed the parent tool-call budget, and the answer is
 * lost while the member keeps working.
 */
export type Pending = {
  taskId: string;
  turn: number;
  /** Transcript turn count before the task was sent, so collect finds the new turn. */
  baseline: number;
  /** Absolute result path, or undefined for an inline task. */
  result?: string;
  sentAt: number;
  /** Start time for an inline task's current settled-state stability window. */
  settledAt?: number;
  /** The latest state sent to the parent. This suppresses duplicate notifications. */
  notifiedState?: "done" | "blocked" | "gone";
};

export const CREW_ENTRY = "herdr-crew";

const NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

export function assertMemberName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(`Member name "${name}" is invalid. Use [a-z][a-z0-9_-]{0,31}, for example "review-api".`);
  }
}

export class MemberRegistry {
  private members = new Map<string, Member>();

  put(member: Member): void {
    this.members.set(member.name, member);
  }

  get(name: string): Member {
    const member = this.members.get(name);
    if (!member) {
      const open = this.openNames();
      const hint = open.length ? ` Open members: ${open.join(", ")}.` : " No member is open.";
      throw new Error(`Unknown member "${name}".${hint}`);
    }
    if (member.closed) throw new Error(`Member "${name}" is closed. Open a new member instead.`);
    return member;
  }

  markClosed(name: string): void {
    const member = this.members.get(name);
    if (member) member.closed = true;
  }

  openMembers(): Member[] {
    return [...this.members.values()].filter((member) => !member.closed);
  }

  openNames(): string[] {
    return this.openMembers().map((member) => member.name);
  }

  /** Rebuild from persisted session entries after a reload or a resume. */
  restore(entries: Iterable<any>): void {
    this.members.clear();
    for (const entry of entries) {
      if (entry?.type !== "custom" || entry.customType !== CREW_ENTRY) continue;
      const member = entry.data as Member | undefined;
      if (member?.name) this.members.set(member.name, member);
    }
  }
}
