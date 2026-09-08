export type CleanupPolicy = "after-result" | "keep";

export type CleanupState = "closed" | "kept" | "retained-dirty" | "failed" | "deferred";

export type CleanupResult = {
  state: CleanupState;
  message: string;
};

export type TaskResultDetails = {
  final?: unknown;
  result?: { exists?: boolean };
  pending?: unknown;
  blocked?: unknown;
  resultMissing?: unknown;
};

export type CleanupDecision = {
  durable: boolean;
  deferred: boolean;
};

export type CleanupPlan =
  | { kind: "keep" }
  | { kind: "defer" }
  | { kind: "settle"; durable: boolean };

type CloseResult = {
  text: string;
  dirty?: boolean;
};

/** Classify a task result before the lifecycle module changes the panel. */
export function classifyTaskResult(details: TaskResultDetails, inline: boolean): CleanupDecision {
  return {
    durable: inline ? typeof details.final === "string" : details.result?.exists === true,
    deferred: Boolean(details.pending || details.blocked || details.resultMissing),
  };
}

/** Give the explicit keep policy precedence over every task outcome. */
export function planCleanup(policy: CleanupPolicy, decision: CleanupDecision): CleanupPlan {
  if (policy === "keep") return { kind: "keep" };
  if (decision.deferred) return { kind: "defer" };
  return { kind: "settle", durable: decision.durable };
}

/**
 * Finish one managed task without risking its durable result.
 *
 * This module owns the cleanup policy. The Pi adapter supplies live state and
 * the Herdr close operation through a small seam.
 */
export async function settleCleanup(options: {
  member: string;
  policy: CleanupPolicy;
  durable: boolean;
  getState: () => Promise<string>;
  close: () => Promise<CloseResult>;
}): Promise<CleanupResult> {
  if (options.policy === "keep") {
    return {
      state: "kept",
      message: `Panel: kept open for member ${options.member} because cleanup is "keep".`,
    };
  }

  if (!options.durable) {
    return {
      state: "deferred",
      message: `Panel: kept open for member ${options.member} because no durable result is available.`,
    };
  }

  const state = await options.getState();
  if (state !== "idle" && state !== "done") {
    return {
      state: "deferred",
      message: `Panel: kept open for member ${options.member} because its state is ${state}.`,
    };
  }

  try {
    const result = await options.close();
    if (result.dirty) {
      return {
        state: "retained-dirty",
        message: `Panel: kept open for member ${options.member} because its worktree has uncommitted work.`,
      };
    }
    return {
      state: "closed",
      message: `Panel: closed automatically for member ${options.member}.`,
    };
  } catch (error) {
    return {
      state: "failed",
      message: `Panel: automatic cleanup failed for member ${options.member}: ${(error as Error).message}`,
    };
  }
}
