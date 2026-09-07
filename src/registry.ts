/**
 * Lane bookkeeping.
 *
 * Herdr owns liveness: `herdr agent list` is the truth for pane and status.
 * This registry stores only what Herdr does not give back later, above all the
 * child session JSONL path used for clean reads.
 */

export type Lane = {
  name: string;
  paneId: string;
  workspaceId: string;
  /** Set for a tab lane and a worktree lane. Closing a tab lane closes this tab. */
  tabId?: string;
  sessionPath: string;
  cwd: string;
  kind: string;
  /** How the lane got its terminal. It decides what close must remove. */
  layout?: "tab" | "split" | "worktree";
  /** Set when the lane owns a Herdr git worktree. */
  worktree?: {
    path: string;
    branch: string;
    workspaceId: string;
    /** Workspace holding the main checkout, so the lane groups under its repository. */
    sourceWorkspaceId?: string;
  };
  openedAt: string;
  closed?: boolean;
  /** True when this session found the lane through `herdr agent list`, not through open. */
  adopted?: boolean;
  /** Current task id. It names the directory under .pi/lanes. */
  task?: string;
  /** Completed ask calls for the current task. It numbers the brief and result files. */
  turns?: number;
  /** Absolute path of the newest result file, for action "result". */
  lastResult?: string;
};

export const LANE_ENTRY = "herdr-lane";

const NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

export function assertLaneName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(`Lane name "${name}" is invalid. Use [a-z][a-z0-9_-]{0,31}, for example "review-api".`);
  }
}

export class LaneRegistry {
  private lanes = new Map<string, Lane>();

  put(lane: Lane): void {
    this.lanes.set(lane.name, lane);
  }

  get(name: string): Lane {
    const lane = this.lanes.get(name);
    if (!lane) {
      const open = this.openNames();
      const hint = open.length ? ` Open lanes: ${open.join(", ")}.` : " No lane is open.";
      throw new Error(`Unknown lane "${name}".${hint}`);
    }
    if (lane.closed) throw new Error(`Lane "${name}" is closed. Open a new lane instead.`);
    return lane;
  }

  markClosed(name: string): void {
    const lane = this.lanes.get(name);
    if (lane) lane.closed = true;
  }

  openLanes(): Lane[] {
    return [...this.lanes.values()].filter((lane) => !lane.closed);
  }

  openNames(): string[] {
    return this.openLanes().map((lane) => lane.name);
  }

  /** Rebuild from persisted session entries after a reload or a resume. */
  restore(entries: Iterable<any>): void {
    this.lanes.clear();
    for (const entry of entries) {
      if (entry?.type !== "custom" || entry.customType !== LANE_ENTRY) continue;
      const lane = entry.data as Lane | undefined;
      if (lane?.name) this.lanes.set(lane.name, lane);
    }
  }
}
