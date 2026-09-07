/**
 * pi-herdr-lane
 *
 * Turn this pi session into an orchestrator over Herdr panes.
 *
 * Split of duty:
 *   Herdr owns the process, the pane, and the lifecycle state.
 *   The child session JSONL owns the data.
 *
 * `herdr agent read` returns the raw terminal, which carries the startup
 * banner, the skill list, the extension list, and the token bar. That is about
 * 2.5 KB of noise for a 0.15 KB answer. This extension never reads the
 * terminal for results. It reads the child session file that
 * `herdr agent start` reports back.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { HerdrError, callerPane, herdr, herdrText, inHerdr, pickDirection, type Exec } from "./herdr.js";
import { LANE_ENTRY, LaneRegistry, assertLaneName, type Lane } from "./registry.js";
import { formatTrace, readTranscript, type Transcript } from "./transcript.js";

const DEFAULT_ASK_TIMEOUT_MS = 600_000;
const START_TIMEOUT_MS = 60_000;
const TRANSCRIPT_SETTLE_MS = 8_000;
const SETTLED = new Set(["idle", "done", "blocked"]);

type ToolResult = { content: Array<{ type: "text"; text: string }>; details?: unknown };

function ok(text: string, details?: unknown): ToolResult {
  return { content: [{ type: "text", text }], details };
}

function runId(): string {
  return Math.random().toString(36).slice(2, 8);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The lifecycle state can settle a moment before the child flushes its JSONL.
 * Poll until a new turn lands, then stop.
 */
async function awaitNewTurn(sessionPath: string, baseline: number): Promise<Transcript> {
  const deadline = Date.now() + TRANSCRIPT_SETTLE_MS;
  let last = await readTranscript(sessionPath);

  while (last.turnCount <= baseline && Date.now() < deadline) {
    await sleep(250);
    last = await readTranscript(sessionPath);
  }
  return last;
}

export default function (pi: ExtensionAPI) {
  const registry = new LaneRegistry();
  const exec: Exec = (command, args, options) => pi.exec(command, args, options);

  // ---------------------------------------------------------------- lifecycle

  pi.on("session_start", async (_event, ctx) => {
    if (!inHerdr()) {
      ctx.ui.setStatus("herdr-lane", undefined);
      return;
    }
    registry.restore(ctx.sessionManager.getEntries());
    refreshStatus(ctx);
  });

  function refreshStatus(ctx: ExtensionContext): void {
    const open = registry.openLanes();
    ctx.ui.setStatus("herdr-lane", open.length ? `lanes: ${open.map((l) => l.name).join(" ")}` : undefined);
  }

  function persist(lane: Lane): void {
    registry.put(lane);
    pi.appendEntry(LANE_ENTRY, lane);
  }

  // ------------------------------------------------------------------ actions

  /**
   * Adopt every named Herdr agent that this registry does not know yet.
   *
   * Herdr, not this session, owns lane liveness. A lane outlives its parent, so
   * a new or reloaded parent must find it again. `agent list` already reports
   * the name, the pane, the cwd, and the session file, which is everything a
   * clean read needs. A half-finished open leaves the same state behind.
   */
  async function adoptLanes(signal?: AbortSignal): Promise<Lane[]> {
    const live = await herdr(exec, ["agent", "list"], { signal, timeoutMs: 15_000 }).catch(() => ({ agents: [] }));
    const known = new Set(registry.openNames());
    const adopted: Lane[] = [];

    for (const agent of live.agents ?? []) {
      const name = agent?.name;
      const sessionPath = agent?.agent_session?.value;
      if (typeof name !== "string" || known.has(name)) continue;

      const lane: Lane = {
        name,
        paneId: String(agent.pane_id),
        workspaceId: String(agent.workspace_id),
        sessionPath: typeof sessionPath === "string" && sessionPath.startsWith("/") ? sessionPath : "",
        cwd: String(agent.cwd ?? ""),
        kind: String(agent.agent ?? "pi"),
        openedAt: new Date().toISOString(),
        adopted: true,
      };

      // A worktree lane sits in its own workspace. Match on that workspace id.
      if (lane.cwd) {
        const list = await herdr(exec, ["worktree", "list", "--cwd", lane.cwd], { signal, timeoutMs: 15_000 }).catch(
          () => undefined,
        );
        const match = (list?.worktrees ?? []).find(
          (wt: any) => wt?.is_linked_worktree && wt?.open_workspace_id === lane.workspaceId,
        );
        if (match) {
          lane.worktree = { path: String(match.path), branch: String(match.branch), workspaceId: lane.workspaceId };
        }
      }

      persist(lane);
      adopted.push(lane);
    }

    return adopted;
  }

  /**
   * Resolve a lane against live Herdr state.
   *
   * Never trust the cached pane id or session path. A pane move changes the pane
   * id, and a lane that started at a dialog reports its session file only after
   * it reaches its prompt. One `agent get` call keeps both fields current.
   */
  async function resolveLane(name: string, signal?: AbortSignal): Promise<Lane> {
    if (!registry.openNames().includes(name)) await adoptLanes(signal);
    const lane = registry.get(name);

    const live = await herdr(exec, ["agent", "get", name], { signal, timeoutMs: 10_000 }).catch(() => undefined);
    const agent = live?.agent;
    if (!agent) return lane;

    const paneId = typeof agent.pane_id === "string" ? agent.pane_id : lane.paneId;
    const reported = agent.agent_session?.value;
    const sessionPath = typeof reported === "string" && reported.startsWith("/") ? reported : lane.sessionPath;

    if (paneId === lane.paneId && sessionPath === lane.sessionPath) return lane;

    const refreshed: Lane = { ...lane, paneId, sessionPath };
    persist(refreshed);
    return refreshed;
  }

  /** Clear a name Herdr still holds after a failed open, instead of deadlocking on it. */
  async function reconcileName(name: string, signal?: AbortSignal): Promise<string | undefined> {
    const live = await herdr(exec, ["agent", "list"], { signal, timeoutMs: 15_000 }).catch(() => ({ agents: [] }));
    const held = (live.agents ?? []).find((agent: any) => agent?.name === name);
    if (!held) return undefined;

    if (registry.openNames().includes(name)) {
      throw new Error(`Lane "${name}" is already open in ${held.pane_id}. Use action "ask", or pick another name.`);
    }

    await herdr(exec, ["pane", "close", held.pane_id], { signal, timeoutMs: 30_000 });
    return held.pane_id;
  }

  async function openLane(
    params: {
      lane: string;
      cwd?: string;
      kind?: string;
      worktree?: boolean;
      branch?: string;
      base?: string;
      trust?: boolean;
    },
    ctx: ExtensionContext,
    signal?: AbortSignal,
    onUpdate?: (result: ToolResult) => void,
  ): Promise<ToolResult> {
    const name = params.lane;
    assertLaneName(name);
    if (registry.openNames().includes(name)) {
      throw new Error(`Lane "${name}" is already open. Use action "ask" or pick another name.`);
    }

    const reclaimed = await reconcileName(name, signal);
    if (reclaimed) onUpdate?.(ok(`Reclaimed the name ${name} from orphan pane ${reclaimed}.`));

    const cwd = params.cwd ? (params.cwd.startsWith("/") ? params.cwd : `${ctx.cwd}/${params.cwd}`) : ctx.cwd;
    const kind = params.kind ?? "pi";
    const id = runId();

    let paneId: string;
    let workspaceId: string;
    let worktree: Lane["worktree"];

    if (params.worktree) {
      onUpdate?.(ok(`Creating a git worktree for lane ${name}...`));
      const args = ["worktree", "create", "--cwd", cwd, "--no-focus", "--branch", params.branch ?? `lane/${name}`];
      if (params.base) args.push("--base", params.base);

      const result = await herdr(exec, args, { signal, timeoutMs: 120_000 });
      paneId = result.root_pane.pane_id;
      workspaceId = result.workspace.workspace_id;
      worktree = {
        path: result.worktree.path,
        branch: result.worktree.branch,
        workspaceId: result.workspace.workspace_id,
      };
    } else {
      onUpdate?.(ok(`Splitting a pane for lane ${name}...`));
      const caller = callerPane();
      const direction = await pickDirection(exec, caller);
      const result = await herdr(
        exec,
        ["pane", "split", "--pane", caller, "--direction", direction, "--cwd", cwd, "--no-focus"],
        { signal, timeoutMs: 30_000 },
      );
      paneId = result.pane.pane_id;
      workspaceId = result.pane.workspace_id;
    }

    onUpdate?.(ok(`Starting ${kind} in ${paneId}...`));

    // A lane must never stop at the project trust dialog. That dialog blocks
    // startup in every new directory, and a worktree path is always new.
    // --no-approve ignores project-local files; --approve loads them.
    const trustFlag = params.trust ? "--approve" : "--no-approve";
    const childArgs = kind === "pi" ? ["--", "--session-id", `lane-${name}-${id}`, trustFlag] : [];

    let sessionPath: string;
    let status: string;
    try {
      const started = await herdr(
        exec,
        ["agent", "start", name, "--kind", kind, "--pane", paneId, "--timeout", String(START_TIMEOUT_MS), ...childArgs],
        { signal, timeoutMs: START_TIMEOUT_MS + 15_000 },
      );

      const reported = started.agent?.agent_session?.value;
      if (typeof reported !== "string" || !reported.startsWith("/")) {
        throw new Error(
          `Herdr started ${kind} in ${paneId} but reported no session file, so a clean read is impossible. ` +
            `The agent usually waits at a startup dialog. Pane tail:\n${await tailPane(paneId, 20)}`,
        );
      }
      sessionPath = reported;
      status = String(started.agent?.agent_status ?? "unknown");
    } catch (error) {
      // Never leave an orphan pane. It also deadlocks the lane name.
      if (params.worktree && worktree) {
        await herdr(exec, ["worktree", "remove", "--workspace", worktree.workspaceId, "--force"], {
          timeoutMs: 30_000,
        }).catch(() => {});
      } else {
        await herdr(exec, ["pane", "close", paneId], { timeoutMs: 15_000 }).catch(() => {});
      }
      throw error;
    }

    const lane: Lane = {
      name, paneId, workspaceId, sessionPath, cwd, kind, worktree,
      openedAt: new Date().toISOString(),
    };
    persist(lane);
    refreshStatus(ctx);

    const lines = [
      `Lane ${name} is open.`,
      `  pane    ${paneId}   (workspace ${workspaceId})`,
      `  cwd     ${cwd}`,
      `  status  ${status}`,
    ];
    if (worktree) lines.push(`  branch  ${worktree.branch}`, `  path    ${worktree.path}`);
    lines.push(`Next: call lane with action "ask".`);

    return ok(lines.join("\n"), { lane });
  }

  async function askLane(
    params: { lane: string; task?: string; timeout_ms?: number },
    ctx: ExtensionContext,
    signal?: AbortSignal,
    onUpdate?: (result: ToolResult) => void,
  ): Promise<ToolResult> {
    const lane = await resolveLane(params.lane, signal);
    const task = params.task?.trim();
    if (!task) throw new Error(`Action "ask" needs a task. Pass the full instruction; the lane cannot see this session.`);
    // An empty session path means the child never reached its prompt. A startup
    // dialog, above all project trust, is the usual cause. That dialog lives on
    // screen only, so the pane is the only place to see it.
    if (!lane.sessionPath) {
      return ok(
        [
          `Lane ${lane.name} reports no session file, so a clean read is impossible.`,
          `The lane most likely waits at a startup dialog. No task was sent.`,
          `Answer it with action "keys", or close the lane and open a new one.`,
          "",
          "Pane tail:",
          await tailPane(lane.paneId, 25),
        ].join("\n"),
        { blocked: true, lane: lane.name },
      );
    }

    const baseline = (await readTranscript(lane.sessionPath).catch(() => undefined))?.turnCount ?? 0;
    const timeout = params.timeout_ms ?? DEFAULT_ASK_TIMEOUT_MS;

    onUpdate?.(ok(`${lane.name} is working...`));

    try {
      await herdr(exec, ["agent", "prompt", lane.name, task, "--wait", "--timeout", String(timeout)], {
        signal,
        timeoutMs: timeout + 30_000,
      });
    } catch (error) {
      if (error instanceof HerdrError && error.code === "agent_blocked") {
        const tail = await tailPane(lane.paneId, 30);
        return ok(
          [
            `Lane ${lane.name} waits at an approval or question dialog. No input was sent.`,
            `Ask the user how to answer it, then use action "keys".`,
            "",
            "Pane tail:",
            tail,
          ].join("\n"),
          { blocked: true, lane: lane.name },
        );
      }
      throw error;
    }

    const transcript = await awaitNewTurn(lane.sessionPath, baseline);
    const state = await laneState(lane);

    if (!transcript.final) {
      return ok(
        [
          `Lane ${lane.name} produced no assistant text (state: ${state}).`,
          transcript.toolNames.length ? `Tools called: ${transcript.toolNames.join(", ")}` : "No tools were called.",
          `Next: call lane with action "trace".`,
        ].join("\n"),
        { lane: lane.name, state },
      );
    }

    const meta = [
      `lane=${lane.name}`,
      `state=${state}`,
      transcript.lastDurationMs !== undefined ? `${Math.round(transcript.lastDurationMs / 1000)}s` : undefined,
      transcript.toolNames.length ? `tools=${transcript.toolNames.length}` : undefined,
      transcript.inputTokens !== undefined ? `↑${transcript.inputTokens} ↓${transcript.outputTokens}` : undefined,
    ]
      .filter(Boolean)
      .join(" · ");

    refreshStatus(ctx);
    return ok(`${transcript.final}\n\n--- ${meta}`, { lane: lane.name, state, final: transcript.final });
  }

  /** Live status straight from Herdr. Never cached. */
  async function laneState(lane: Lane): Promise<string> {
    try {
      const result = await herdr(exec, ["agent", "get", lane.name], { timeoutMs: 10_000 });
      return String(result.agent?.agent_status ?? "unknown");
    } catch {
      return "gone";
    }
  }

  /**
   * The only place that reads a terminal. Use it for a blocked dialog, where the
   * dialog exists on screen and never in the JSONL.
   */
  async function tailPane(paneId: string, lines: number): Promise<string> {
    try {
      const text = await herdrText(
        exec,
        ["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", String(lines)],
        { timeoutMs: 15_000 },
      );
      const kept = text
        .split("\n")
        .map((line) => line.replace(/[\u2500-\u257f]{4,}/g, "").trimEnd())
        .filter((line) => line.trim().length > 0);
      return kept.slice(-lines).join("\n") || "(pane is empty)";
    } catch (error) {
      return `(pane read failed: ${(error as Error).message})`;
    }
  }

  async function statusLanes(ctx: ExtensionContext, signal?: AbortSignal): Promise<ToolResult> {
    await adoptLanes(signal);

    const open = registry.openLanes();
    if (!open.length) return ok(`No lane is open. Use action "open".`);

    const live = await herdr(exec, ["agent", "list"], { signal, timeoutMs: 15_000 }).catch(() => ({ agents: [] }));
    const byPane = new Map<string, any>((live.agents ?? []).map((a: any) => [a.pane_id, a]));

    const rows = open.map((lane) => {
      const agent = byPane.get(lane.paneId);
      const state = agent ? String(agent.agent_status) : "gone";
      const flag =
        state === "blocked"
          ? " <- needs input"
          : state === "gone"
            ? " <- pane lost"
            : lane.adopted
              ? " <- adopted"
              : "";
      return `${lane.name.padEnd(16)} ${state.padEnd(8)} ${lane.paneId.padEnd(8)} ${lane.worktree?.branch ?? lane.cwd}${flag}`;
    });

    refreshStatus(ctx);
    return ok([`${open.length} lane(s):`, ...rows].join("\n"), { lanes: open.map((l) => l.name) });
  }

  async function traceLane(params: { lane: string; lines?: number }, signal?: AbortSignal): Promise<ToolResult> {
    const lane = await resolveLane(params.lane, signal);
    if (!lane.sessionPath) return ok(`Lane ${lane.name} has no session file. Pane tail:\n${await tailPane(lane.paneId, 25)}`);
    const transcript = await readTranscript(lane.sessionPath);
    const state = await laneState(lane);
    return ok(
      [`Lane ${lane.name} (state: ${state}, ${transcript.turnCount} turn(s)):`, formatTrace(transcript, params.lines ?? 40)].join("\n"),
      { lane: lane.name, state },
    );
  }

  async function keysLane(params: { lane: string; keys?: string[] }, signal?: AbortSignal): Promise<ToolResult> {
    const lane = await resolveLane(params.lane, signal);
    const keys = params.keys ?? [];
    if (!keys.length) throw new Error(`Action "keys" needs at least one logical key, for example ["esc"] or ["ctrl+c"].`);

    await herdr(exec, ["agent", "send-keys", lane.name, ...keys], { signal, timeoutMs: 15_000 });
    await sleep(400);
    return ok([`Sent ${keys.join(" ")} to ${lane.name}. State: ${await laneState(lane)}.`, "", await tailPane(lane.paneId, 20)].join("\n"));
  }

  async function closeLane(
    params: { lane: string; force?: boolean },
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const lane = await resolveLane(params.lane, signal);
    const notes: string[] = [];

    if (lane.worktree) {
      const args = ["worktree", "remove", "--workspace", lane.worktree.workspaceId];
      if (params.force) args.push("--force");
      try {
        await herdr(exec, args, { signal, timeoutMs: 60_000 });
        notes.push(`Removed the worktree at ${lane.worktree.path}.`);
        notes.push(`Branch ${lane.worktree.branch} still exists. Herdr does not delete it.`);
      } catch (error) {
        if (error instanceof HerdrError && error.code === "dirty_worktree_requires_force") {
          return ok(
            [
              `Lane ${lane.name} has uncommitted work in ${lane.worktree.path}.`,
              `The lane stays open. Commit or merge that work first.`,
              `To discard it, call action "close" again with force true.`,
            ].join("\n"),
            { dirty: true, lane: lane.name },
          );
        }
        throw error;
      }
    } else {
      await herdr(exec, ["pane", "close", lane.paneId], { signal, timeoutMs: 30_000 });
      notes.push(`Closed pane ${lane.paneId}.`);
    }

    registry.markClosed(lane.name);
    pi.appendEntry(LANE_ENTRY, { ...lane, closed: true });
    refreshStatus(ctx);

    if (lane.sessionPath) notes.push(`Transcript stays readable at ${lane.sessionPath}.`);
    return ok([`Lane ${lane.name} is closed.`, ...notes].join("\n"));
  }

  // ---------------------------------------------------------------- tool

  pi.registerTool({
    name: "lane",
    label: "Lane",
    description:
      "Dispatch work to a pi subagent running in a visible Herdr pane, then read its answer from the child " +
      "session file instead of the terminal.\n" +
      "Actions:\n" +
      "  open   - split a pane (or create a git worktree) and start an agent under a lane name\n" +
      "  ask    - send a task, wait for the lane to settle, return the final answer only\n" +
      "  status - one line per lane with live Herdr state: idle, working, blocked, done\n" +
      "  trace  - the lane's tool calls and messages in order, for a lane that answered badly\n" +
      "  keys   - send logical keys such as esc or ctrl+c to a blocked lane\n" +
      "  close  - close the pane, or remove the worktree\n" +
      "A lane cannot see this conversation. Put every needed fact in the task text.",
    promptSnippet: "Run and manage pi subagents in visible Herdr panes, and read their answers cleanly",
    promptGuidelines: [
      "Use lane with action open then ask when work should run in a visible pane the user can take over by typing in it.",
      "Use lane with worktree true when two or more lanes write files, because one directory tolerates one writer only.",
      "Restate every needed fact in the lane task text, because a lane starts with an empty conversation.",
      "Trust only idle and done from lane action status; unknown does not prove that a lane finished.",
      "Use lane with action trace, not the terminal, when a lane answers badly.",
    ],
    parameters: Type.Object({
      action: StringEnum(["open", "ask", "status", "trace", "keys", "close"] as const, {
        description: "The lane operation to run.",
      }),
      lane: Type.Optional(
        Type.String({
          description: 'Lane name, matching [a-z][a-z0-9_-]{0,31}, for example "review-api". Required except for status.',
        }),
      ),
      task: Type.Optional(
        Type.String({
          description: "For ask: the full self-contained instruction. The lane cannot see this conversation.",
        }),
      ),
      cwd: Type.Optional(Type.String({ description: "For open: working directory. Defaults to this session's cwd." })),
      kind: Type.Optional(
        Type.String({ description: 'For open: agent kind such as pi, claude, codex, or gemini. Defaults to "pi".' }),
      ),
      worktree: Type.Optional(
        Type.Boolean({
          description: "For open: create an isolated git worktree and workspace. Use this for a lane that writes files.",
        }),
      ),
      trust: Type.Optional(
        Type.Boolean({
          description:
            "For open: load project-local .pi settings and extensions in the lane. Defaults to false, which ignores them.",
        }),
      ),
      branch: Type.Optional(Type.String({ description: "For open with worktree: branch name. Defaults to lane/<name>." })),
      base: Type.Optional(Type.String({ description: "For open with worktree: base ref for the new branch." })),
      keys: Type.Optional(
        Type.Array(Type.String(), { description: 'For keys: logical keys in order, for example ["esc"] or ["ctrl+c"].' }),
      ),
      lines: Type.Optional(Type.Number({ description: "For trace: maximum lines to return. Defaults to 40." })),
      timeout_ms: Type.Optional(Type.Number({ description: "For ask: wait budget in milliseconds. Defaults to 600000." })),
      force: Type.Optional(Type.Boolean({ description: "For close: discard uncommitted work in a worktree lane." })),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (!inHerdr()) {
        throw new Error(
          "This pi session does not run inside a Herdr pane, so lane cannot control panes. Start pi inside Herdr.",
        );
      }

      const needsLane = params.action !== "status";
      if (needsLane && !params.lane) throw new Error(`Action "${params.action}" needs a lane name.`);
      const name = params.lane as string;

      switch (params.action) {
        case "open":
          return openLane({ ...params, lane: name }, ctx, signal, onUpdate);
        case "ask":
          return askLane({ ...params, lane: name }, ctx, signal, onUpdate);
        case "status":
          return statusLanes(ctx, signal);
        case "trace":
          return traceLane({ lane: name, lines: params.lines }, signal);
        case "keys":
          return keysLane({ lane: name, keys: params.keys }, signal);
        case "close":
          return closeLane({ lane: name, force: params.force }, ctx, signal);
        default:
          throw new Error(`Unknown action "${params.action}".`);
      }
    },

    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      let content = theme.fg("toolTitle", theme.bold("lane "));
      content += theme.fg("accent", String(args?.action ?? "?"));
      if (args?.lane) content += " " + theme.fg("muted", String(args.lane));
      if (args?.worktree) content += " " + theme.fg("dim", "[worktree]");
      if (args?.task) {
        const task = String(args.task).replace(/\s+/g, " ");
        content += " " + theme.fg("dim", `"${task.length > 60 ? `${task.slice(0, 60)}...` : task}"`);
      }
      text.setText(content);
      return text;
    },

    renderResult(result, { expanded, isPartial }, theme) {
      const body = result.content?.map((c: any) => c.text).join("\n") ?? "";
      if (isPartial) return new Text(theme.fg("warning", body || "working..."), 0, 0);

      const details = result.details as { blocked?: boolean; dirty?: boolean } | undefined;
      if (details?.blocked || details?.dirty) return new Text(theme.fg("warning", body), 0, 0);
      if (result.isError) return new Text(theme.fg("error", body), 0, 0);

      const lines = body.split("\n");
      if (expanded || lines.length <= 8) return new Text(body, 0, 0);
      return new Text([...lines.slice(0, 8), theme.fg("dim", `... ${lines.length - 8} more lines`)].join("\n"), 0, 0);
    },
  });

  // -------------------------------------------------------------- command

  pi.registerCommand("lanes", {
    description: "List open Herdr lanes, or close them all with /lanes close",
    handler: async (args, ctx) => {
      if (!inHerdr()) {
        ctx.ui.notify("Not running inside Herdr.", "error");
        return;
      }

      if (args.trim() === "close") {
        const open = registry.openLanes();
        if (!open.length) {
          ctx.ui.notify("No lane is open.", "info");
          return;
        }
        const confirmed = await ctx.ui.confirm("Close lanes", `Close ${open.length} lane(s)?`);
        if (!confirmed) return;
        for (const lane of open) {
          await closeLane({ lane: lane.name }, ctx).catch((error: Error) =>
            ctx.ui.notify(`${lane.name}: ${error.message}`, "error"),
          );
        }
        ctx.ui.notify("Lanes closed.", "info");
        return;
      }

      const result = await statusLanes(ctx);
      ctx.ui.notify(result.content[0]!.text, "info");
    },
  });
}
