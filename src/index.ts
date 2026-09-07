/**
 * pi-herdr-crew
 *
 * Turn this pi session into an orchestrator over Herdr panes. Each crew member
 * is a pi agent in its own visible tab, and the user can take one over by
 * typing in it.
 *
 * Split of duty:
 *   Herdr owns the process, the pane, and the lifecycle state.
 *   A markdown file owns the payload.
 *   The child session JSONL owns the trace and the fallback reply.
 *
 * A member answer must not enter this context whole. `herdr agent read` returns
 * the raw terminal, which carries the startup banner, the skill list, and the
 * token bar. Reading the child session file removes that noise but does not
 * bound the size. So a member writes markdown to disk and replies with one
 * summary line. Measured on a 15942 byte audit, this context took 167 bytes.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import {
  HerdrError,
  callerPane,
  callerWorkspace,
  herdr,
  herdrText,
  inHerdr,
  pickDirection,
  type Exec,
} from "./herdr.js";
import {
  findLatestResult,
  inspectResult,
  taskPaths,
  listTaskFiles,
  readSection,
  renderBrief,
  renderPrompt,
  writeBrief,
  type ResultInfo,
} from "./protocol.js";
import { CREW_ENTRY, MemberRegistry, assertMemberName, type Member } from "./registry.js";
import { formatTrace, readTranscript, type Transcript } from "./transcript.js";

const DEFAULT_ASK_TIMEOUT_MS = 600_000;
const START_TIMEOUT_MS = 60_000;
const TRANSCRIPT_SETTLE_MS = 8_000;
const SHELL_READY_TIMEOUT_MS = 15_000;
const SETTLED = new Set(["idle", "done", "blocked"]);

type ToolResult = { content: Array<{ type: "text"; text: string }>; details?: unknown };

function ok(text: string, details?: unknown): ToolResult {
  return { content: [{ type: "text", text }], details };
}

/** Make a task id safe as one directory name. */
function slugify(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (!slug) throw new Error(`Task id "${raw}" has no usable characters. Use letters, digits, and dashes.`);
  return slug;
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
  const registry = new MemberRegistry();
  const exec: Exec = (command, args, options) => pi.exec(command, args, options);

  // ---------------------------------------------------------------- lifecycle

  pi.on("session_start", async (_event, ctx) => {
    if (!inHerdr()) {
      ctx.ui.setStatus("herdr-crew", undefined);
      return;
    }
    registry.restore(ctx.sessionManager.getEntries());
    refreshStatus(ctx);
  });

  function refreshStatus(ctx: ExtensionContext): void {
    const open = registry.openMembers();
    ctx.ui.setStatus("herdr-crew", open.length ? `members: ${open.map((m) => m.name).join(" ")}` : undefined);
  }

  function persist(member: Member): void {
    registry.put(member);
    pi.appendEntry(CREW_ENTRY, member);
  }

  // ------------------------------------------------------------------ actions

  /**
   * Adopt every named Herdr agent that this registry does not know yet.
   *
   * Herdr, not this session, owns member liveness. A member outlives its parent, so
   * a new or reloaded parent must find it again. `agent list` already reports
   * the name, the pane, the cwd, and the session file, which is everything a
   * clean read needs. A half-finished open leaves the same state behind.
   */
  async function adoptMembers(signal?: AbortSignal): Promise<Member[]> {
    const live = await herdr(exec, ["agent", "list"], { signal, timeoutMs: 15_000 }).catch(() => ({ agents: [] }));
    const known = new Set(registry.openNames());
    const adopted: Member[] = [];

    for (const agent of live.agents ?? []) {
      const name = agent?.name;
      const sessionPath = agent?.agent_session?.value;
      if (typeof name !== "string" || known.has(name)) continue;

      const member: Member = {
        name,
        paneId: String(agent.pane_id),
        workspaceId: String(agent.workspace_id),
        tabId: typeof agent.tab_id === "string" ? agent.tab_id : undefined,
        sessionPath: typeof sessionPath === "string" && sessionPath.startsWith("/") ? sessionPath : "",
        cwd: String(agent.cwd ?? ""),
        kind: String(agent.agent ?? "pi"),
        openedAt: new Date().toISOString(),
        adopted: true,
      };

      // A worktree member sits in its own workspace. Match on that workspace id.
      if (member.cwd) {
        const list = await herdr(exec, ["worktree", "list", "--cwd", member.cwd], { signal, timeoutMs: 15_000 }).catch(
          () => undefined,
        );
        const match = (list?.worktrees ?? []).find(
          (wt: any) => wt?.is_linked_worktree && wt?.open_workspace_id === member.workspaceId,
        );
        if (match) {
          member.worktree = { path: String(match.path), branch: String(match.branch), workspaceId: member.workspaceId };
        }
      }

      persist(member);
      adopted.push(member);
    }

    return adopted;
  }

  /**
   * Resolve a member against live Herdr state.
   *
   * Never trust the cached pane id or session path. A pane move changes the pane
   * id, and a member that started at a dialog reports its session file only after
   * it reaches its prompt. One `agent get` call keeps both fields current.
   */
  async function resolveMember(name: string, signal?: AbortSignal): Promise<Member> {
    if (!registry.openNames().includes(name)) await adoptMembers(signal);
    const member = registry.get(name);

    const live = await herdr(exec, ["agent", "get", name], { signal, timeoutMs: 10_000 }).catch(() => undefined);
    const agent = live?.agent;
    if (!agent) return member;

    const paneId = typeof agent.pane_id === "string" ? agent.pane_id : member.paneId;
    const tabId = typeof agent.tab_id === "string" ? agent.tab_id : member.tabId;
    const reported = agent.agent_session?.value;
    const sessionPath = typeof reported === "string" && reported.startsWith("/") ? reported : member.sessionPath;

    if (paneId === member.paneId && tabId === member.tabId && sessionPath === member.sessionPath) return member;

    const refreshed: Member = { ...member, paneId, tabId, sessionPath };
    persist(refreshed);
    return refreshed;
  }

  /**
   * The workspace that owns a repository checkout.
   *
   * Herdr has no parent field. `worktree list` reports `source_workspace_id`
   * instead, which is the workspace holding the main checkout. Passing it to
   * `worktree create` groups the new workspace under that repository.
   */
  async function sourceWorkspace(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
    const list = await herdr(exec, ["worktree", "list", "--cwd", cwd], { signal, timeoutMs: 15_000 }).catch(
      () => undefined,
    );
    const source = list?.source?.source_workspace_id;
    return typeof source === "string" && source ? source : undefined;
  }

  /**
   * The workspace a member belongs in.
   *
   * Group a member by the repository it works on, not by the caller. A member whose
   * cwd is another repository belongs beside that repository. The caller
   * workspace is the fallback for a directory outside any repository.
   */
  async function targetWorkspace(cwd: string, signal?: AbortSignal): Promise<string> {
    return (await sourceWorkspace(cwd, signal)) ?? callerWorkspace();
  }

  /** Clear a name Herdr still holds after a failed open, instead of deadlocking on it. */
  async function reconcileName(name: string, signal?: AbortSignal): Promise<string | undefined> {
    const live = await herdr(exec, ["agent", "list"], { signal, timeoutMs: 15_000 }).catch(() => ({ agents: [] }));
    const held = (live.agents ?? []).find((agent: any) => agent?.name === name);
    if (!held) return undefined;

    if (registry.openNames().includes(name)) {
      throw new Error(`Member "${name}" is already open in ${held.pane_id}. Use action "ask", or pick another name.`);
    }

    await herdr(exec, ["pane", "close", held.pane_id], { signal, timeoutMs: 30_000 });
    return held.pane_id;
  }

  async function openMember(
    params: {
      member: string;
      cwd?: string;
      kind?: string;
      worktree?: boolean;
      branch?: string;
      base?: string;
      trust?: boolean;
      layout?: "tab" | "split";
    },
    ctx: ExtensionContext,
    signal?: AbortSignal,
    onUpdate?: (result: ToolResult) => void,
  ): Promise<ToolResult> {
    const name = params.member;
    assertMemberName(name);
    if (registry.openNames().includes(name)) {
      throw new Error(`Member "${name}" is already open. Use action "ask" or pick another name.`);
    }

    const reclaimed = await reconcileName(name, signal);
    if (reclaimed) onUpdate?.(ok(`Reclaimed the name ${name} from orphan pane ${reclaimed}.`));

    // The directory the parent asked for. A worktree member then runs somewhere
    // else, so memberCwd below is the value that matters for the file protocol.
    const cwd = params.cwd ? (params.cwd.startsWith("/") ? params.cwd : `${ctx.cwd}/${params.cwd}`) : ctx.cwd;
    const kind = params.kind ?? "pi";
    const layout = params.layout ?? "tab";

    let memberCwd = cwd;
    let paneId: string;
    let workspaceId: string;
    let tabId: string | undefined;
    let worktree: Member["worktree"];

    if (params.worktree) {
      // Herdr groups a worktree workspace under the source repository. Pass the
      // source workspace so the new one lands beside its parent, not at the end
      // of the workspace list.
      onUpdate?.(ok(`Creating a git worktree for member ${name}...`));
      // Prefer the source workspace, because Herdr groups the new workspace
      // under that repository. A repository with no open workspace has no such
      // id, and --cwd still works, so fall back instead of failing.
      const source = await sourceWorkspace(cwd, signal);
      const args = ["worktree", "create", "--no-focus", "--branch", params.branch ?? `crew/${name}`];
      args.push(...(source ? ["--workspace", source] : ["--cwd", cwd]));
      if (params.base) args.push("--base", params.base);

      const result = await herdr(exec, args, { signal, timeoutMs: 120_000 });
      paneId = result.root_pane.pane_id;
      workspaceId = result.workspace.workspace_id;
      tabId = result.tab?.tab_id;
      worktree = {
        path: result.worktree.path,
        branch: result.worktree.branch,
        workspaceId: result.workspace.workspace_id,
        sourceWorkspaceId: source,
      };
      // The member runs in the worktree, not in the source checkout. Every brief
      // and result must land where the member can read and write them.
      memberCwd = String(result.root_pane?.foreground_cwd ?? result.worktree.path);
    } else if (layout === "tab") {
      // A tab gives the member a full-width terminal in this workspace. A split
      // shrinks the caller, and a narrow pane truncates every agent UI.
      onUpdate?.(ok(`Creating a tab for member ${name}...`));
      const result = await herdr(
        exec,
        ["tab", "create", "--workspace", await targetWorkspace(cwd, signal), "--cwd", cwd, "--label", name, "--no-focus"],
        { signal, timeoutMs: 30_000 },
      );
      paneId = result.root_pane.pane_id;
      workspaceId = result.tab.workspace_id;
      tabId = result.tab.tab_id;
    } else {
      onUpdate?.(ok(`Splitting a pane for member ${name}...`));
      const caller = callerPane();
      const direction = await pickDirection(exec, caller);
      const result = await herdr(
        exec,
        ["pane", "split", "--pane", caller, "--direction", direction, "--cwd", cwd, "--no-focus"],
        { signal, timeoutMs: 30_000 },
      );
      paneId = result.pane.pane_id;
      workspaceId = result.pane.workspace_id;
      tabId = result.pane.tab_id;
    }

    onUpdate?.(ok(`Starting ${kind} in ${paneId}...`));

    // A member must never stop at the project trust dialog. That dialog blocks
    // startup in every new directory, and a worktree path is always new.
    // --no-approve ignores project-local files; --approve loads them.
    //
    // Use --name, not --session-id. A fresh id makes pi print "No project
    // session found with id ...; creating a new session with that id", which is
    // noise on every member start. The session path comes back from Herdr, so the
    // member never needs a predictable id. The name shows in the footer and the
    // tab title instead.
    const trustFlag = params.trust ? "--approve" : "--no-approve";
    const childArgs = kind === "pi" ? ["--", trustFlag, "--name", `member: ${name}`] : [];

    let sessionPath: string;
    let status: string;
    try {
      const started = await startAgent(name, kind, paneId, childArgs, signal);

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
      // Never leave an orphan pane. It also deadlocks the member name.
      if (params.worktree && worktree) {
        await herdr(exec, ["worktree", "remove", "--workspace", worktree.workspaceId, "--force"], {
          timeoutMs: 30_000,
        }).catch(() => {});
      } else if (layout === "tab" && tabId) {
        await herdr(exec, ["tab", "close", tabId], { timeoutMs: 15_000 }).catch(() => {});
      } else {
        await herdr(exec, ["pane", "close", paneId], { timeoutMs: 15_000 }).catch(() => {});
      }
      throw error;
    }

    const member: Member = {
      name, paneId, workspaceId, tabId, sessionPath, kind, worktree,
      cwd: memberCwd,
      layout: params.worktree ? "worktree" : layout,
      openedAt: new Date().toISOString(),
    };
    persist(member);
    refreshStatus(ctx);

    const lines = [
      `Member ${name} is open.`,
      `  pane    ${paneId}   (workspace ${workspaceId}${tabId ? `, tab ${tabId}` : ""})`,
      `  layout  ${member.layout}`,
      `  cwd     ${memberCwd}`,
      `  status  ${status}`,
    ];
    if (worktree) {
      lines.push(`  branch  ${worktree.branch}`, `  path    ${worktree.path}`);
      if (worktree.sourceWorkspaceId) lines.push(`  under   ${worktree.sourceWorkspaceId}`);
    }
    lines.push(`Next: call crew with action "ask".`);

    return ok(lines.join("\n"), { member });
  }

  async function askMember(
    params: {
      member: string;
      task?: string;
      task_id?: string;
      timeout_ms?: number;
      inline?: boolean;
      context?: string;
    },
    ctx: ExtensionContext,
    signal?: AbortSignal,
    onUpdate?: (result: ToolResult) => void,
  ): Promise<ToolResult> {
    const member = await resolveMember(params.member, signal);
    const task = params.task?.trim();
    if (!task) throw new Error(`Action "ask" needs a task. Pass the full instruction; the member cannot see this session.`);
    // An empty session path means the child never reached its prompt. A startup
    // dialog, above all project trust, is the usual cause. That dialog lives on
    // screen only, so the pane is the only place to see it.
    if (!member.sessionPath) {
      return ok(
        [
          `Member ${member.name} reports no session file, so a clean read is impossible.`,
          `The member most likely waits at a startup dialog. No task was sent.`,
          `Answer it with action "keys", or close the member and open a new one.`,
          "",
          "Pane tail:",
          await tailPane(member.paneId, 25),
        ].join("\n"),
        { blocked: true, member: member.name },
      );
    }

    const baseline = (await readTranscript(member.sessionPath).catch(() => undefined))?.turnCount ?? 0;
    const timeout = params.timeout_ms ?? DEFAULT_ASK_TIMEOUT_MS;

    // The file protocol is the default. It keeps a large answer out of this
    // context: the member writes markdown to disk and replies with one line.
    // Pass inline true for a short answer where a file costs more than it saves.
    const useFile = params.inline !== true;

    // One directory per task, not per member. A member can run several tasks, and a
    // task can outlive the member that ran it.
    const taskId = params.task_id ? slugify(params.task_id) : member.task ?? member.name;
    const turn = taskId === member.task ? (member.turns ?? 0) + 1 : 1;
    const paths = taskPaths(member.cwd, taskId, turn);
    let prompt = task;

    if (useFile) {
      await writeBrief(
        paths.brief,
        renderBrief({
          member: member.name,
          task,
          resultRelative: paths.resultRelative,
          dirRelative: paths.dirRelative,
          context: params.context,
        }),
      );
      prompt = renderPrompt(paths.briefRelative);
      onUpdate?.(ok(`Wrote ${paths.briefRelative}. ${member.name} is working...`));
    } else {
      onUpdate?.(ok(`${member.name} is working...`));
    }

    persist({ ...member, task: taskId, turns: turn, lastResult: useFile ? paths.result : undefined });

    try {
      await herdr(exec, ["agent", "prompt", member.name, prompt, "--wait", "--timeout", String(timeout)], {
        signal,
        timeoutMs: timeout + 30_000,
      });
    } catch (error) {
      if (error instanceof HerdrError && error.code === "agent_blocked") {
        const tail = await tailPane(member.paneId, 30);
        return ok(
          [
            `Member ${member.name} waits at an approval or question dialog. No input was sent.`,
            `Ask the user how to answer it, then use action "keys".`,
            "",
            "Pane tail:",
            tail,
          ].join("\n"),
          { blocked: true, member: member.name },
        );
      }
      throw error;
    }

    const transcript = await awaitNewTurn(member.sessionPath, baseline);
    const state = await memberState(member);
    const meta = [
      `member=${member.name}`,
      `state=${state}`,
      transcript.lastDurationMs !== undefined ? `${Math.round(transcript.lastDurationMs / 1000)}s` : undefined,
      transcript.toolNames.length ? `tools=${transcript.toolNames.length}` : undefined,
      transcript.inputTokens !== undefined ? `↑${transcript.inputTokens} ↓${transcript.outputTokens}` : undefined,
    ]
      .filter(Boolean)
      .join(" · ");

    refreshStatus(ctx);

    if (useFile) {
      const info = await inspectResult(paths.result, member.cwd);

      // A member that ignored the brief still answered. Fall back to its reply
      // instead of losing the work.
      if (!info.exists) {
        return ok(
          [
            `Member ${member.name} wrote no ${info.relative}.`,
            transcript.final ? `Its reply follows.\n\n${transcript.final}` : `It produced no reply either.`,
            "",
            `--- ${meta} · no-result-file`,
          ].join("\n"),
          { member: member.name, state, resultMissing: true },
        );
      }

      const files = await listTaskFiles(member.cwd, taskId);
      const extras = files.filter((file) => !/^(brief|result)(-\d+)?\.md$/.test(file.name));

      return ok(
        [
          transcript.final?.trim() || "(the member sent no summary line)",
          "",
          `Result: ${info.relative} (${info.bytes} bytes, ${info.lines} lines)`,
          info.headings.length ? `Sections:\n${info.headings.map((h) => `  ${h}`).join("\n")}` : "",
          extras.length ? `Also in ${paths.dirRelative}/: ${extras.map((f) => `${f.name} (${f.bytes}B)`).join(", ")}` : "",
          `Read one section with action "result" and a section name, or read the file directly.`,
          "",
          `--- ${meta}`,
        ]
          .filter((line) => line !== "")
          .join("\n"),
        { member: member.name, state, task: taskId, result: info },
      );
    }

    if (!transcript.final) {
      return ok(
        [
          `Member ${member.name} produced no assistant text (state: ${state}).`,
          transcript.toolNames.length ? `Tools called: ${transcript.toolNames.join(", ")}` : "No tools were called.",
          `Next: call crew with action "trace".`,
        ].join("\n"),
        { member: member.name, state },
      );
    }

    return ok(`${transcript.final}\n\n--- ${meta}`, { member: member.name, state, final: transcript.final });
  }

  /**
   * Describe or slice the member's result file.
   *
   * Without a section name this returns the shape only, never the body. That is
   * the point: the parent decides what to pull in.
   */
  async function readResult(
    params: { member: string; section?: string; max_bytes?: number; task_id?: string },
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const member = await resolveMember(params.member, signal);

    // An adopted member carries no memory of its last result. Disk holds it.
    const taskId = params.task_id ? slugify(params.task_id) : member.task ?? member.name;
    const path = member.lastResult ?? (await findLatestResult(member.cwd, taskId));
    if (!path) {
      throw new Error(
        `Member ${member.name} has no result file in ${member.cwd}/.pi/crew/${taskId}. ` +
          `Run action "ask" without inline true first.`,
      );
    }
    if (path !== member.lastResult) persist({ ...member, lastResult: path });

    const info: ResultInfo = await inspectResult(path, member.cwd);
    if (!info.exists) throw new Error(`Result file ${info.relative} does not exist.`);

    if (!params.section) {
      const files = await listTaskFiles(member.cwd, taskId);
      return ok(
        [
          `${info.relative} · ${info.bytes} bytes · ${info.lines} lines`,
          info.headings.length ? `Sections:\n${info.headings.map((h) => `  ${h}`).join("\n")}` : "(no headings)",
          files.length > 2 ? `Task directory: ${files.map((f) => `${f.name} (${f.bytes}B)`).join(", ")}` : "",
          `Pass a section name to read one section.`,
        ]
          .filter((line) => line !== "")
          .join("\n"),
        { member: member.name, task: taskId, result: info },
      );
    }

    const body = await readSection(path, { section: params.section, maxBytes: params.max_bytes });
    return ok(body, { member: member.name, section: params.section });
  }

  /**
   * Start an agent, waiting for the pane shell to come up.
   *
   * A pane from `tab create` or `worktree create` is not immediately at its
   * prompt. `agent start` then fails with agent_pane_busy or
   * agent_pane_not_available. Measured on this machine, the shell needs about
   * one second. Retry instead of failing the member.
   */
  async function startAgent(
    name: string,
    kind: string,
    paneId: string,
    childArgs: string[],
    signal?: AbortSignal,
  ): Promise<any> {
    const args = [
      "agent", "start", name,
      "--kind", kind,
      "--pane", paneId,
      "--timeout", String(START_TIMEOUT_MS),
      ...childArgs,
    ];
    const transient = new Set(["agent_pane_busy", "agent_pane_not_available"]);
    const deadline = Date.now() + SHELL_READY_TIMEOUT_MS;

    for (let attempt = 1; ; attempt += 1) {
      try {
        return await herdr(exec, args, { signal, timeoutMs: START_TIMEOUT_MS + 15_000 });
      } catch (error) {
        const retryable = error instanceof HerdrError && transient.has(error.code);
        if (!retryable || Date.now() >= deadline) throw error;
        await sleep(Math.min(250 * attempt, 1_000));
      }
    }
  }

  /** True when the member pane is the only pane in its tab, so closing the tab is right. */
  async function ownsWholeTab(member: Member, signal?: AbortSignal): Promise<boolean> {
    if (!member.tabId) return false;
    const result = await herdr(exec, ["tab", "get", member.tabId], { signal, timeoutMs: 10_000 }).catch(() => undefined);
    return Number(result?.tab?.pane_count ?? 0) === 1;
  }

  /** Live status straight from Herdr. Never cached. */
  async function memberState(member: Member): Promise<string> {
    try {
      const result = await herdr(exec, ["agent", "get", member.name], { timeoutMs: 10_000 });
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

  async function statusCrew(ctx: ExtensionContext, signal?: AbortSignal): Promise<ToolResult> {
    await adoptMembers(signal);

    const open = registry.openMembers();
    if (!open.length) return ok(`No member is open. Use action "open".`);

    const live = await herdr(exec, ["agent", "list"], { signal, timeoutMs: 15_000 }).catch(() => ({ agents: [] }));
    const byPane = new Map<string, any>((live.agents ?? []).map((a: any) => [a.pane_id, a]));

    const rows = open.map((member) => {
      const agent = byPane.get(member.paneId);
      const state = agent ? String(agent.agent_status) : "gone";
      const flag =
        state === "blocked"
          ? " <- needs input"
          : state === "gone"
            ? " <- pane lost"
            : member.adopted
              ? " <- adopted"
              : "";
      return `${member.name.padEnd(16)} ${state.padEnd(8)} ${member.paneId.padEnd(8)} ${member.worktree?.branch ?? member.cwd}${flag}`;
    });

    refreshStatus(ctx);
    return ok([`${open.length} member(s):`, ...rows].join("\n"), { members: open.map((m) => m.name) });
  }

  async function traceMember(params: { member: string; lines?: number }, signal?: AbortSignal): Promise<ToolResult> {
    const member = await resolveMember(params.member, signal);
    if (!member.sessionPath) return ok(`Member ${member.name} has no session file. Pane tail:\n${await tailPane(member.paneId, 25)}`);
    const transcript = await readTranscript(member.sessionPath);
    const state = await memberState(member);
    return ok(
      [`Member ${member.name} (state: ${state}, ${transcript.turnCount} turn(s)):`, formatTrace(transcript, params.lines ?? 40)].join("\n"),
      { member: member.name, state },
    );
  }

  async function keysMember(params: { member: string; keys?: string[] }, signal?: AbortSignal): Promise<ToolResult> {
    const member = await resolveMember(params.member, signal);
    const keys = params.keys ?? [];
    if (!keys.length) throw new Error(`Action "keys" needs at least one logical key, for example ["esc"] or ["ctrl+c"].`);

    await herdr(exec, ["agent", "send-keys", member.name, ...keys], { signal, timeoutMs: 15_000 });
    await sleep(400);
    return ok([`Sent ${keys.join(" ")} to ${member.name}. State: ${await memberState(member)}.`, "", await tailPane(member.paneId, 20)].join("\n"));
  }

  async function closeMember(
    params: { member: string; force?: boolean },
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const member = await resolveMember(params.member, signal);
    const notes: string[] = [];

    if (member.worktree) {
      const args = ["worktree", "remove", "--workspace", member.worktree.workspaceId];
      if (params.force) args.push("--force");
      try {
        await herdr(exec, args, { signal, timeoutMs: 60_000 });
        notes.push(`Removed the worktree at ${member.worktree.path}.`);
        notes.push(`Branch ${member.worktree.branch} still exists. Herdr does not delete it.`);
      } catch (error) {
        if (error instanceof HerdrError && error.code === "dirty_worktree_requires_force") {
          return ok(
            [
              `Member ${member.name} has uncommitted work in ${member.worktree.path}.`,
              `The member stays open. Commit or merge that work first.`,
              `To discard it, call action "close" again with force true.`,
            ].join("\n"),
            { dirty: true, member: member.name },
          );
        }
        throw error;
      }
    } else if (await ownsWholeTab(member, signal)) {
      // Close the tab when the member is its only pane. Decide from live state, not
      // from the stored layout, because an adopted member has no stored layout.
      const tabId = member.tabId as string;
      await herdr(exec, ["tab", "close", tabId], { signal, timeoutMs: 30_000 });
      notes.push(`Closed tab ${tabId}.`);
    } else {
      await herdr(exec, ["pane", "close", member.paneId], { signal, timeoutMs: 30_000 });
      notes.push(`Closed pane ${member.paneId}.`);
    }

    registry.markClosed(member.name);
    pi.appendEntry(CREW_ENTRY, { ...member, closed: true });
    refreshStatus(ctx);

    if (member.sessionPath) notes.push(`Transcript stays readable at ${member.sessionPath}.`);
    return ok([`Member ${member.name} is closed.`, ...notes].join("\n"));
  }

  // ---------------------------------------------------------------- tool

  pi.registerTool({
    name: "crew",
    label: "Crew",
    description:
      "Dispatch work to a pi subagent running in a visible Herdr pane. The member writes its answer to a markdown " +
      "file and replies with one summary line, so a large answer never enters this context.\n" +
      "Actions:\n" +
      "  open   - create a tab (or a git worktree) and start an agent under a member name\n" +
      "  ask    - write a brief file, send the task, wait, return the summary line and the result file shape\n" +
      "  result - list the result file sections, or return one named section\n" +
      "  status - one line per member with live Herdr state: idle, working, blocked, done\n" +
      "  trace  - the member's tool calls and messages in order, for a member that answered badly\n" +
      "  keys   - send logical keys such as esc or ctrl+c to a blocked member\n" +
      "  close  - close the pane, or remove the worktree\n" +
      "A member cannot see this conversation. Put every needed fact in the task text.",
    promptSnippet: "Run pi subagents in visible Herdr panes that answer through markdown files",
    promptGuidelines: [
      "Use crew with action open then ask when work should run in a visible pane the user can take over by typing in it.",
      "Use crew with worktree true when two or more members write files, because one directory tolerates one writer only.",
      "Pass a task_id to crew action ask when one member runs several tasks, because each task_id gets its own directory.",
      "Restate every needed fact in the crew task text, because a member starts with an empty conversation.",
      "Let crew action ask use its default file protocol for a long answer, then pull one section with action result.",
      "Use crew with inline true only for a one-line answer, where a result file costs more than it saves.",
      "Trust only idle and done from crew action status; unknown does not prove that a member finished.",
      "Use crew with action trace, not the terminal, when a member answers badly.",
    ],
    parameters: Type.Object({
      action: StringEnum(["open", "ask", "result", "status", "trace", "keys", "close"] as const, {
        description: "The member operation to run.",
      }),
      member: Type.Optional(
        Type.String({
          description: 'Member name, matching [a-z][a-z0-9_-]{0,31}, for example "review-api". Required except for status.',
        }),
      ),
      task: Type.Optional(
        Type.String({
          description: "For ask: the full self-contained instruction. The member cannot see this conversation.",
        }),
      ),
      context: Type.Optional(
        Type.String({
          description: "For ask: extra facts for the brief file, such as file paths, constraints, or prior decisions.",
        }),
      ),
      inline: Type.Optional(
        Type.Boolean({
          description:
            "For ask: skip the result file and return the member's reply directly. Use it for a one-line answer only.",
        }),
      ),
      section: Type.Optional(
        Type.String({
          description: "For result: a heading substring. Without it the action lists the sections and returns no body.",
        }),
      ),
      max_bytes: Type.Optional(
        Type.Number({ description: "For result: maximum bytes to return. Defaults to 8000." }),
      ),
      cwd: Type.Optional(Type.String({ description: "For open: working directory. Defaults to this session's cwd." })),
      layout: Type.Optional(
        StringEnum(["tab", "split"] as const, {
          description:
            'For open: "tab" gives the member a full-width tab and is the default. "split" shares the caller tab.',
        }),
      ),
      task_id: Type.Optional(
        Type.String({
          description:
            "For ask and result: task name, which becomes the directory .pi/crew/<task_id>/. Defaults to the member name.",
        }),
      ),
      kind: Type.Optional(
        Type.String({ description: 'For open: agent kind such as pi, claude, codex, or gemini. Defaults to "pi".' }),
      ),
      worktree: Type.Optional(
        Type.Boolean({
          description: "For open: create an isolated git worktree and workspace. Use this for a member that writes files.",
        }),
      ),
      trust: Type.Optional(
        Type.Boolean({
          description:
            "For open: load project-local .pi settings and extensions in the member. Defaults to false, which ignores them.",
        }),
      ),
      branch: Type.Optional(Type.String({ description: "For open with worktree: branch name. Defaults to crew/<name>." })),
      base: Type.Optional(Type.String({ description: "For open with worktree: base ref for the new branch." })),
      keys: Type.Optional(
        Type.Array(Type.String(), { description: 'For keys: logical keys in order, for example ["esc"] or ["ctrl+c"].' }),
      ),
      lines: Type.Optional(Type.Number({ description: "For trace: maximum lines to return. Defaults to 40." })),
      timeout_ms: Type.Optional(Type.Number({ description: "For ask: wait budget in milliseconds. Defaults to 600000." })),
      force: Type.Optional(Type.Boolean({ description: "For close: discard uncommitted work in a worktree member." })),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (!inHerdr()) {
        throw new Error(
          "This pi session does not run inside a Herdr pane, so member cannot control panes. Start pi inside Herdr.",
        );
      }

      const needsMember = params.action !== "status";
      if (needsMember && !params.member) throw new Error(`Action "${params.action}" needs a member name.`);
      const name = params.member as string;

      switch (params.action) {
        case "open":
          return openMember({ ...params, member: name }, ctx, signal, onUpdate);
        case "ask":
          return askMember({ ...params, member: name }, ctx, signal, onUpdate);
        case "result":
          return readResult(
            { member: name, section: params.section, max_bytes: params.max_bytes, task_id: params.task_id },
            signal,
          );
        case "status":
          return statusCrew(ctx, signal);
        case "trace":
          return traceMember({ member: name, lines: params.lines }, signal);
        case "keys":
          return keysMember({ member: name, keys: params.keys }, signal);
        case "close":
          return closeMember({ member: name, force: params.force }, ctx, signal);
        default:
          throw new Error(`Unknown action "${params.action}".`);
      }
    },

    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      let content = theme.fg("toolTitle", theme.bold("crew "));
      content += theme.fg("accent", String(args?.action ?? "?"));
      if (args?.member) content += " " + theme.fg("muted", String(args.member));
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

  pi.registerCommand("crew", {
    description: "List the open crew, or close every member with /crew close",
    handler: async (args, ctx) => {
      if (!inHerdr()) {
        ctx.ui.notify("Not running inside Herdr.", "error");
        return;
      }

      if (args.trim() === "close") {
        const open = registry.openMembers();
        if (!open.length) {
          ctx.ui.notify("No member is open.", "info");
          return;
        }
        const confirmed = await ctx.ui.confirm("Close members", `Close ${open.length} member(s)?`);
        if (!confirmed) return;
        for (const member of open) {
          await closeMember({ member: member.name }, ctx).catch((error: Error) =>
            ctx.ui.notify(`${member.name}: ${error.message}`, "error"),
          );
        }
        ctx.ui.notify("Members closed.", "info");
        return;
      }

      const result = await statusCrew(ctx);
      ctx.ui.notify(result.content[0]!.text, "info");
    },
  });
}
