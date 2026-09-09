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
 * summary line. Measured on a 12283 byte audit, this context took 124 bytes.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import {
  assertCanDispatch,
  isLiveObservation,
  isSamePending,
  notificationState,
  releaseWatcher,
  rollbackDispatch,
  shouldCheckState,
} from "./async-lifecycle.js";
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
  CREW_ROOT,
  findLatestResult,
  inspectResult,
  listTaskFiles,
  nextTurn,
  readSection,
  renderBrief,
  renderPrompt,
  taskPaths,
  writeBrief,
  writeIgnore,
  type ResultInfo,
} from "./protocol.js";
import { CREW_ENTRY, MemberRegistry, assertMemberName, type Member, type Pending } from "./registry.js";
import { formatTrace, readTranscript, type Transcript } from "./transcript.js";

const START_TIMEOUT_MS = 60_000;
const SHELL_READY_TIMEOUT_MS = 15_000;

type ToolResult = { content: Array<{ type: "text"; text: string }>; details: unknown; isError?: boolean };

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

export default function (pi: ExtensionAPI) {
  const registry = new MemberRegistry();
  const watchers = new Map<string, AbortController>();
  const exec: Exec = (command, args, options) => pi.exec(command, args, options);

  // ---------------------------------------------------------------- lifecycle

  pi.on("session_start", async (_event, ctx) => {
    if (!inHerdr()) {
      ctx.ui.setStatus("herdr-crew", undefined);
      return;
    }
    registry.restore(ctx.sessionManager.getEntries());
    refreshStatus(ctx);
    for (const member of registry.openMembers()) {
      if (member.pending) watchPending(member.name);
    }
  });

  pi.on("session_shutdown", async () => {
    for (const controller of watchers.values()) controller.abort();
    watchers.clear();
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
      task?: string;
      task_id?: string;
      context?: string;
      inline?: boolean;
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

    // A task on open sends the first prompt in the same call. Open then ask is
    // two round trips for one intent, and the member is idle between them.
    const task = params.task?.trim();
    if (task) {
      onUpdate?.(ok(lines.join("\n")));
      const answer = await askMember(
        {
          member: name,
          task,
          task_id: params.task_id,
          context: params.context,
          inline: params.inline,
        },
        ctx,
        signal,
        onUpdate,
      );
      return {
        content: [{ type: "text", text: [...lines, "", answer.content.map((c) => c.text).join("\n")].join("\n") }],
        // Keep the ask details on top. A caller reads blocked and pending from
        // them, and the open summary is already in the text.
        details: { opened: member, ...(answer.details as Record<string, unknown> | undefined) },
        isError: answer.isError,
      };
    }

    lines.push(`Next: call crew with action "ask".`);

    return ok(lines.join("\n"), { member });
  }

  async function askMember(
    params: {
      member: string;
      task?: string;
      task_id?: string;
      inline?: boolean;
      context?: string;
    },
    ctx: ExtensionContext,
    signal?: AbortSignal,
    onUpdate?: (result: ToolResult) => void,
  ): Promise<ToolResult> {
    const member = await resolveMember(params.member, signal);
    assertCanDispatch(member);
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

    // The file protocol is the default. It keeps a large answer out of this
    // context: the member writes markdown to disk and replies with one line.
    // Pass inline true for a short answer where a file costs more than it saves.
    const useFile = params.inline !== true;

    // One directory per task, not per member. A member can run several tasks, and a
    // task can outlive the member that ran it.
    const taskId = params.task_id ? slugify(params.task_id) : member.task ?? member.name;
    // Disk owns the turn number. A member that returns to an earlier task_id would
    // restart at turn 1 from its own counter and overwrite that task's files.
    const turn = await nextTurn(ctx.cwd, taskId);
    // The orchestrator cwd owns every brief and result. A worktree member runs in
    // a directory that close removes, so a result stored there dies with it.
    const paths = taskPaths(ctx.cwd, taskId, turn);
    let prompt = task;

    if (useFile) {
      await writeIgnore(ctx.cwd);
      await writeBrief(
        paths.brief,
        renderBrief({
          member: member.name,
          task,
          result: paths.result,
          dir: paths.dir,
          memberCwd: member.cwd,
          context: params.context,
        }),
      );
      prompt = renderPrompt(paths.brief);
      onUpdate?.(ok(`Wrote ${paths.briefRelative}. ${member.name} is working...`));
    } else {
      onUpdate?.(ok(`${member.name} is working...`));
    }

    const pending: Pending = { taskId, turn, baseline, result: useFile ? paths.result : undefined, sentAt: Date.now() };
    persist({ ...member, task: taskId, turns: turn, lastResult: pending.result, pending });

    // Dispatch once. The session-scoped supervisor watches completion after this call returns.
    try {
      await herdr(exec, ["agent", "prompt", member.name, prompt], { signal, timeoutMs: 30_000 });
    } catch (error) {
      if (error instanceof HerdrError && error.code === "agent_blocked") {
        persist(rollbackDispatch(member, pending));
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
      watchPending(member.name);
      throw error;
    }

    watchPending(member.name);
    return ok(
      [
        `Member ${member.name} started task ${taskId}.`,
        useFile ? `It writes ${paths.resultRelative}.` : `It answers inline.`,
        `The main agent receives a notification when the task settles.`,
      ].join("\n"),
      { member: member.name, task: taskId, pending: true },
    );
  }

  /** Return a settled member result without waiting. */
  async function collectMember(
    params: { member: string },
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const member = await resolveMember(params.member, signal);
    const pending = member.pending;
    if (!pending) {
      throw new Error(`Member ${member.name} has no task in flight. Use action "ask" first.`);
    }

    const taskId = pending.taskId;
    const paths = taskPaths(ctx.cwd, taskId, pending.turn);
    const useFile = pending.result !== undefined;
    const outcome = await inspectTurn(member, pending.baseline);

    // A lost pane is not a slow member, so say so. The task cannot finish.
    if (outcome.kind === "pending" && outcome.state === "gone") {
      return ok(
        [
          `Member ${member.name} has no live pane, so task ${taskId} cannot finish.`,
          `Elapsed: ${Math.round((Date.now() - pending.sentAt) / 1000)}s.`,
          useFile ? `Read any partial answer with action "result" and task_id ${taskId}.` : "",
          `Close the member and open a new one.`,
        ]
          .filter((line) => line !== "")
          .join("\n"),
        { member: member.name, state: "gone", pending: true },
      );
    }

    if (outcome.kind === "pending") {
      return ok(
        [
          `Member ${member.name} is still working on task ${taskId}.`,
          `State: ${outcome.state}. Elapsed: ${Math.round((Date.now() - pending.sentAt) / 1000)}s.`,
          `Wait for the completion notification before action "collect".`,
        ].join("\n"),
        { member: member.name, pending: true },
      );
    }

    if (outcome.kind === "blocked") {
      return ok(
        [
          `Member ${member.name} waits at an approval or question dialog.`,
          `Ask the user how to answer it, then use action "keys", then action "collect" again.`,
          "",
          "Pane tail:",
          await tailPane(member.paneId, 30),
        ].join("\n"),
        { blocked: true, member: member.name, pending: true },
      );
    }

    const transcript = outcome.transcript;
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

    // The task settled, so it is no longer in flight. Clear it before returning,
    // or a later collect waits on work that already finished.
    persist({ ...member, pending: undefined });
    refreshStatus(ctx);

    if (useFile) {
      const info = await inspectResult(paths.result, ctx.cwd);

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

      const files = await listTaskFiles(ctx.cwd, taskId);
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
    params: { member?: string; section?: string; max_bytes?: number; task_id?: string },
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    // A task lives in the orchestrator cwd, so it outlives its member. Read a
    // result by task id alone when the member is already closed.
    const asked = params.task_id ? slugify(params.task_id) : undefined;
    let member: Member | undefined;

    if (params.member) {
      member = await resolveMember(params.member, signal);
    }
    const taskId = asked ?? member?.task ?? member?.name;
    if (!taskId) {
      throw new Error(`Action "result" needs a member name or a task_id.`);
    }

    // `lastResult` names the member's current task only. An explicit task_id for
    // another task must read that task's directory instead.
    const cached = taskId === (member?.task ?? member?.name) ? member?.lastResult : undefined;
    const path = cached ?? (await findLatestResult(ctx.cwd, taskId));
    if (!path) {
      throw new Error(
        `No result file in ${CREW_ROOT}/${taskId}. Run action "ask" without inline true first.`,
      );
    }
    // Cache only the member's own current task, or a foreign read poisons it.
    if (member && taskId === (member.task ?? member.name) && path !== member.lastResult) {
      persist({ ...member, lastResult: path });
    }

    const info: ResultInfo = await inspectResult(path, ctx.cwd);
    if (!info.exists) throw new Error(`Result file ${info.relative} does not exist.`);

    if (!params.section) {
      const files = await listTaskFiles(ctx.cwd, taskId);
      return ok(
        [
          `${info.relative} · ${info.bytes} bytes · ${info.lines} lines`,
          info.headings.length ? `Sections:\n${info.headings.map((h) => `  ${h}`).join("\n")}` : "(no headings)",
          files.length > 2 ? `Task directory: ${files.map((f) => `${f.name} (${f.bytes}B)`).join(", ")}` : "",
          `Pass a section name to read one section.`,
        ]
          .filter((line) => line !== "")
          .join("\n"),
        { member: member?.name, task: taskId, result: info },
      );
    }

    const body = await readSection(path, { section: params.section, maxBytes: params.max_bytes });
    return ok(body, { member: member?.name, task: taskId, section: params.section });
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

  type Outcome =
    | { kind: "done"; transcript: Transcript }
    | { kind: "blocked" }
    | { kind: "pending"; state: string };

  /** Inspect one child turn without making the caller wait. */
  async function inspectTurn(member: Member, baseline: number, checkState = true): Promise<Outcome> {
    const empty: Transcript = { turns: [], toolNames: [], turnCount: 0 };
    const transcript = await readTranscript(member.sessionPath).catch(() => empty);
    if (transcript.turnCount > baseline) return { kind: "done", transcript };
    if (!checkState) return { kind: "pending", state: "unknown" };

    const state = await memberState(member);
    if (state === "blocked") return { kind: "blocked" };
    return { kind: "pending", state };
  }

  /** Start one session-scoped watcher for a detached member task. */
  function watchPending(memberName: string): void {
    if (watchers.has(memberName)) return;

    const controller = new AbortController();
    watchers.set(memberName, controller);
    void supervisePending(memberName, controller.signal)
      .catch((error) => console.error(`Crew watcher failed for ${memberName}:`, error))
      .finally(() => releaseWatcher(watchers, memberName, controller));
  }

  /** Notify the parent once when a detached task finishes or needs attention. */
  async function supervisePending(memberName: string, signal: AbortSignal): Promise<void> {
    let tick = 0;
    while (!signal.aborted) {
      const member = registry.get(memberName);
      const pending = member.pending;
      if (!pending) return;

      const outcome = await inspectTurn(member, pending.baseline, shouldCheckState(pending, tick));
      if (signal.aborted) return;
      const state = notificationState(outcome);

      if (state) {
        if (pending.notifiedState !== state) {
          const current = registry.get(memberName);
          if (!isSamePending(current.pending, pending)) return;

          const action = state === "done"
            ? `Call crew with action "collect" and member "${member.name}".`
            : state === "blocked"
              ? `Inspect member "${member.name}", answer its dialog with action "keys", then wait for the next notification.`
              : `Call crew with action "collect" and member "${member.name}" to inspect the lost task.`;
          try {
            pi.sendMessage(
              {
                customType: "herdr-crew-event",
                content: `Crew task ${pending.taskId} is ${state}. ${action}`,
                display: true,
                details: { member: member.name, taskId: pending.taskId, turn: pending.turn, state },
              },
              { deliverAs: "followUp", triggerTurn: true },
            );
          } catch (error) {
            console.error(`Crew notification failed for ${memberName}:`, error);
            await sleep(1_000);
            continue;
          }

          const delivered = registry.get(memberName);
          if (!isSamePending(delivered.pending, pending)) return;
          const updatedPending: Pending = { ...delivered.pending, notifiedState: state };
          persist({ ...delivered, pending: updatedPending });
        }
        if (state !== "blocked") return;
      } else if (pending.notifiedState === "blocked" && isLiveObservation(outcome)) {
        const current = registry.get(memberName);
        if (!isSamePending(current.pending, pending)) return;
        const updatedPending: Pending = { ...current.pending, notifiedState: undefined };
        persist({ ...current, pending: updatedPending });
      }

      tick += 1;
      await sleep(1_000);
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
    // Key by name, not by pane id. A pane move changes the pane id, and a cached
    // id then reports a live member as gone.
    const byName = new Map<string, any>(
      (live.agents ?? []).filter((a: any) => typeof a?.name === "string").map((a: any) => [a.name as string, a]),
    );

    const rows = open.map((member) => {
      const agent = byName.get(member.name);
      const state = agent ? String(agent.agent_status) : "gone";
      const paneId = agent?.pane_id ? String(agent.pane_id) : member.paneId;
      const flag =
        state === "blocked"
          ? " <- needs input"
          : state === "gone"
            ? " <- pane lost"
            : member.pending
              ? ` <- task ${member.pending.taskId} in flight, ${Math.round((Date.now() - member.pending.sentAt) / 1000)}s`
              : member.adopted
                ? " <- adopted"
                : "";
      return `${member.name.padEnd(16)} ${state.padEnd(8)} ${paneId.padEnd(8)} ${member.worktree?.branch ?? member.cwd}${flag}`;
    });

    refreshStatus(ctx);
    return ok([`${open.length} member(s):`, ...rows].join("\n"), { members: open.map((m) => m.name) });
  }

  async function traceMember(params: { member: string; lines?: number }, signal?: AbortSignal): Promise<ToolResult> {
    const member = await resolveMember(params.member, signal);
    const transcript = member.sessionPath ? await readTranscript(member.sessionPath).catch(() => undefined) : undefined;
    const state = await memberState(member);

    // No session file means the member never took a turn. The pane is then the
    // only evidence, usually a startup dialog.
    if (!transcript) {
      return ok(
        [`Member ${member.name} has taken no turn (state: ${state}). Pane tail:`, await tailPane(member.paneId, 25)].join("\n"),
        { member: member.name, state },
      );
    }
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
    const current = registry.get(member.name);
    if (current.pending?.notifiedState === "blocked") {
      persist({ ...current, pending: { ...current.pending, notifiedState: undefined } });
    }
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

    // A member whose pane already died needs bookkeeping only. Closing its pane
    // fails, and that failure would leave the member open forever.
    if ((await memberState(member)) === "gone" && !member.worktree) {
      registry.markClosed(member.name);
      watchers.get(member.name)?.abort();
      watchers.delete(member.name);
      pi.appendEntry(CREW_ENTRY, { ...member, closed: true, pending: undefined });
      refreshStatus(ctx);
      return ok(
        [
          `Member ${member.name} is closed. Its pane was already gone.`,
          member.sessionPath ? `Transcript stays readable at ${member.sessionPath}.` : "",
        ]
          .filter((line) => line !== "")
          .join("\n"),
      );
    }

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
    watchers.get(member.name)?.abort();
    watchers.delete(member.name);
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
      "  open   - create a tab or worktree, start an agent, and dispatch an optional first task\n" +
      "  ask     - write a brief and dispatch a task to an open member\n" +
      "  collect - return a settled task summary and result shape without waiting\n" +
      "  result  - list the result file sections, or return one named section\n" +
      "  status - one line per member with live Herdr state: idle, working, blocked, done\n" +
      "  trace  - the member's tool calls and messages in order, for a member that answered badly\n" +
      "  keys   - send logical keys such as esc or ctrl+c to a blocked member\n" +
      "  close  - close the pane, or remove the worktree\n" +
      "A member cannot see this conversation. Put every needed fact in the task text.",
    promptSnippet: "Run pi subagents in visible Herdr panes that answer through markdown files",
    promptGuidelines: [
      "Use crew with action open to create a member and dispatch its first task.",
      "Use crew action ask only for a second or later task on an open member.",
      "Crew open and ask return after dispatch. Wait for the completion notification before collect.",
      "Use crew with worktree true when two or more members write files, because one directory tolerates one writer only.",
      "Pass a task_id to crew action ask when one member runs several tasks, because each task_id gets its own directory.",
      "Restate every needed fact in the crew task text, because a member starts with an empty conversation.",
      "Let crew action ask use its default file protocol for a long answer, then pull one section with action result.",
      "Use crew with inline true only for a one-line answer, where a result file costs more than it saves.",
      "Trust only idle and done from crew action status; unknown does not prove that a member finished.",
      "Use crew with action trace, not the terminal, when a member answers badly.",
      "Close a retained member after you collect and inspect its final result. Keep it open only for reuse, correction, or user takeover.",
    ],
    parameters: Type.Object({
      action: StringEnum(["open", "ask", "collect", "result", "status", "trace", "keys", "close"] as const, {
        description: "The member operation to run.",
      }),
      member: Type.Optional(
        Type.String({
          description: 'Member name, matching [a-z][a-z0-9_-]{0,31}, for example "review-api". Required except for status.',
        }),
      ),
      task: Type.Optional(
        Type.String({
          description:
            "For ask and open: the full self-contained instruction. The member cannot see this conversation. " +
            "On open it runs as the member's first task, so no separate ask call is needed.",
        }),
      ),
      context: Type.Optional(
        Type.String({
          description:
            "For ask and open with a task: extra facts for the brief file, such as file paths, constraints, or prior decisions.",
        }),
      ),
      inline: Type.Optional(
        Type.Boolean({
          description:
            "For ask and open with a task: skip the result file and return the member's reply directly. " +
            "Use it for a one-line answer only.",
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
            "For ask, result, and open with a task: task name, which becomes the directory .pi/crew/<task_id>/ in this session's cwd. " +
            "Defaults to the member name. Action result accepts it without a member, because a task outlives its member.",
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
      branch: Type.Optional(Type.String({ description: "For open with a worktree: branch name. Defaults to crew/<name>." })),
      base: Type.Optional(Type.String({ description: "For open with a worktree: base ref for the new branch." })),
      keys: Type.Optional(
        Type.Array(Type.String(), { description: 'For keys: logical keys in order, for example ["esc"] or ["ctrl+c"].' }),
      ),
      lines: Type.Optional(Type.Number({ description: "For trace: maximum lines to return. Defaults to 40." })),
      force: Type.Optional(Type.Boolean({ description: "For close: discard uncommitted work in a worktree member." })),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (!inHerdr()) {
        throw new Error(
          "This pi session does not run inside a Herdr pane, so it cannot control panes. Start pi inside Herdr.",
        );
      }

      // status needs no member. result accepts a task_id alone, because a task
      // lives in the orchestrator cwd and outlives the member that ran it.
      const optional = params.action === "status" || (params.action === "result" && !!params.task_id);
      if (!optional && !params.member) throw new Error(`Action "${params.action}" needs a member name.`);
      const name = params.member as string;

      switch (params.action) {
        case "open":
          return openMember({ ...params, member: name }, ctx, signal, onUpdate);
        case "ask":
          return askMember({ ...params, member: name }, ctx, signal, onUpdate);
        case "collect":
          return collectMember({ member: name }, ctx, signal);
        case "result":
          return readResult(
            { member: params.member, section: params.section, max_bytes: params.max_bytes, task_id: params.task_id },
            ctx,
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
      if ((result as typeof result & { isError?: boolean }).isError) return new Text(theme.fg("error", body), 0, 0);

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
