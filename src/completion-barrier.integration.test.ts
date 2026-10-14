import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";
import { OwnershipStore } from "./ownership.ts";

// Compile the real extension into an isolated directory with normal package resolution.
async function harness() {
  const root = await mkdtemp(join(process.cwd(), ".crew-test-"));
  const compiled = join(root, "compiled");
  await mkdir(compiled);
  for (const name of await readdir(join(process.cwd(), "src"))) {
    if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
    const source = await readFile(join(process.cwd(), "src", name), "utf8");
    await writeFile(join(compiled, name.replace(/\.ts$/, ".js")), ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText);
  }
  const { default: extension } = await import(pathToFileURL(join(compiled, "index.js")).href);
  const ownership = new OwnershipStore(join(root, "ownership"));
  const entries: any[] = [];
  const messages: any[] = [];
  const handlers = new Map<string, Function>();
  const agents = new Map<string, any>();
  let tool: any;
  let nextPane = 0;
  let promptFailure: string | undefined;
  let startupGate: Promise<void> | undefined;
  let getFailure = false;
  let getHook: (() => Promise<void>) | undefined;
  const oldEnv = { HERDR_ENV: process.env.HERDR_ENV, HERDR_PANE_ID: process.env.HERDR_PANE_ID, HERDR_WORKSPACE_ID: process.env.HERDR_WORKSPACE_ID };
  Object.assign(process.env, { HERDR_ENV: "1", HERDR_PANE_ID: "parent", HERDR_WORKSPACE_ID: "workspace" });
  const ctx: any = { cwd: root, ui: { setStatus() {}, confirm: async () => true },
    sessionManager: { getSessionId: () => "parent", getEntries: () => entries, getBranch: () => entries } };
  const pi: any = {
    on: (name: string, handler: Function) => handlers.set(name, handler),
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data: structuredClone(data) }),
    sendMessage: (message: unknown, options: unknown) => messages.push({ message, options }),
    registerTool: (definition: unknown) => { tool = definition; }, registerCommand() {},
    exec: async (_command: string, args: string[]) => {
      let result: any = {};
      const command = args.slice(0, 2).join(" ");
      if (command === "agent list") result = { agents: [...agents.values()] };
      else if (command === "agent get") {
        if (getFailure) {
          getFailure = false;
          return { code: 1, stdout: JSON.stringify({ error: { code: "timeout", message: "temporary timeout" } }), stderr: "" };
        }
        const hook = getHook;
        getHook = undefined;
        await hook?.();
        result = { agent: agents.get(args[2]!) };
      }
      else if (command === "worktree list") result = { worktrees: [] };
      else if (command === "tab create") {
        const pane = `pane-${++nextPane}`;
        result = { root_pane: { pane_id: pane }, tab: { tab_id: `tab-${nextPane}`, workspace_id: "workspace" } };
      } else if (command === "agent start") {
        await startupGate;
        const name = args[2]!;
        const sessionPath = join(root, `${name}.jsonl`);
        await writeFile(sessionPath, "");
        const agent = { name, pane_id: args[args.indexOf("--pane") + 1], workspace_id: "workspace", cwd: root,
          agent_status: "idle", agent_session: { value: sessionPath } };
        agents.set(name, agent);
        result = { agent };
      } else if (command === "agent prompt") {
        if (promptFailure) return { code: 1, stdout: JSON.stringify({ error: { code: promptFailure, message: "prompt failed" } }), stderr: "" };
        agents.get(args[2]!)!.agent_status = "working";
      } else if (command === "pane read") return { code: 0, stdout: "approval", stderr: "" };
      else if (command === "tab get") result = { tab: { pane_count: 1 } };
      else if (command === "tab close") {
        for (const [name, agent] of agents) if (`tab-${agent.pane_id.split("-")[1]}` === args[2]) agents.delete(name);
      }
      return { code: 0, stdout: JSON.stringify({ result }), stderr: "" };
    },
  };
  extension(pi, join(root, "ownership"));
  await handlers.get("session_start")!({}, ctx);
  const call = (args: any) => tool.execute("test", args, undefined, undefined, ctx);
  const finish = async (name: string) => {
    const record = await ownership.get(name);
    const pending = (record!.member as any).pending;
    await writeFile(pending.result, `# Result\n${name} verified\n`);
    await writeFile(agents.get(name)!.agent_session.value, JSON.stringify({ type: "custom", customType: "zentui-turn-summary", data: {} }) + "\n");
    agents.get(name)!.agent_status = "idle";
  };
  return { call, finish, entries, messages, handlers, agents, ctx, ownership,
    failNextGet: () => { getFailure = true; },
    onNextGet: (hook: () => Promise<void>) => { getHook = hook; },
    pauseStartup: (gate: Promise<void>) => { startupGate = gate; },
    failPrompt: (code: string) => { promptFailure = code; },
    cleanup: async () => {
      await handlers.get("session_shutdown")!({}, ctx);
      for (const [key, value] of Object.entries(oldEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 6_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "notification did not arrive");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("real extension routes grouped completion once and preserves ordinary notifications", async () => {
  const h = await harness();
  try {
    const { batchId } = (await h.call({ action: "batch", expected_members: ["api", "tests"] })).details;
    await Promise.all(["api", "tests"].map((member) => h.call({ action: "open", member, batch_id: batchId, task: "audit" })));
    await h.finish("api");
    await h.call({ action: "collect", member: "api" });
    assert.equal(h.messages.length, 0);
    await h.finish("tests");
    await waitFor(() => h.messages.some((item) => item.message.customType === "herdr-crew-batch"));
    assert.equal(h.messages.length, 1);
    assert.equal(h.messages[0].message.details.allDone, true);
    assert.deepEqual(h.messages[0].options, { deliverAs: "followUp", triggerTurn: true });
    await h.call({ action: "open", member: "ordinary", task: "audit" });
    await h.finish("ordinary");
    await waitFor(() => h.messages.length === 2);
    assert.equal(h.messages[1].message.customType, "herdr-crew-event");
  } finally { await h.cleanup(); }
});

test("cancellation releases silently completed members without closing children", async () => {
  const h = await harness();
  try {
    const { batchId } = (await h.call({ action: "batch", expected_members: ["api", "later"] })).details;
    await h.call({ action: "open", member: "api", batch_id: batchId, task: "audit" });
    await h.finish("api");
    await h.call({ action: "status", batch_id: batchId });
    assert.equal(h.messages.length, 0);
    await h.call({ action: "batch_cancel", batch_id: batchId });
    await waitFor(() => h.messages.length === 1);
    assert.equal(h.messages[0].message.customType, "herdr-crew-event");
    assert.equal(h.agents.has("api"), true);
  } finally { await h.cleanup(); }
});

test("confirmed dispatch failure settles the batch as unsuccessful", async () => {
  const h = await harness();
  try {
    const { batchId } = (await h.call({ action: "batch", expected_members: ["api"] })).details;
    h.failPrompt("agent_blocked");
    await h.call({ action: "open", member: "api", batch_id: batchId, task: "audit" });
    assert.equal(h.messages.length, 1);
    assert.equal(h.messages[0].message.details.allDone, false);
    assert.equal(h.messages[0].message.details.slots.api.state, "dispatch-failed");
  } finally { await h.cleanup(); }
});

test("blocker attention remains immediate and deduplicated before aggregate completion", async () => {
  const h = await harness();
  try {
    const { batchId } = (await h.call({ action: "batch", expected_members: ["api"] })).details;
    await h.call({ action: "open", member: "api", batch_id: batchId, task: "audit" });
    h.agents.get("api")!.agent_status = "blocked";
    await waitFor(() => h.messages.length === 1);
    assert.equal(h.messages[0].message.details.state, "blocked");
    await h.call({ action: "status", batch_id: batchId });
    assert.equal(h.messages.length, 1);
    await h.finish("api");
    await waitFor(() => h.messages.length === 2);
    assert.equal(h.messages[1].message.customType, "herdr-crew-batch");
  } finally { await h.cleanup(); }
});

test("ambiguous dispatch remains tracked and concurrent dispatch cannot overwrite it", async () => {
  const h = await harness();
  try {
    const { batchId } = (await h.call({ action: "batch", expected_members: ["api"] })).details;
    h.failPrompt("timeout");
    const dispatches = await Promise.allSettled([
      h.call({ action: "open", member: "api", batch_id: batchId, task: "audit" }),
      h.call({ action: "open", member: "api", task: "duplicate" }),
    ]);
    assert.equal(dispatches[0].status, "rejected");
    assert.equal(dispatches[1].status, "rejected");
    const status = await h.call({ action: "status", batch_id: batchId });
    assert.equal(status.details.batch.slots.api.state, "dispatch-uncertain");
    assert.equal(h.messages.length, 0);
    await h.finish("api");
    await h.call({ action: "collect", member: "api" });
    assert.equal(h.messages.length, 1);
    assert.equal(h.messages[0].message.details.allDone, true);
  } finally { await h.cleanup(); }
});

test("reload restores collected outcomes and successful close settles an unresolved slot", async () => {
  const h = await harness();
  try {
    const { batchId } = (await h.call({ action: "batch", expected_members: ["api", "tests"] })).details;
    await h.call({ action: "open", member: "api", batch_id: batchId, task: "audit" });
    await h.call({ action: "open", member: "tests", batch_id: batchId, task: "audit" });
    await h.finish("api");
    await h.call({ action: "collect", member: "api" });
    await h.handlers.get("session_shutdown")!({}, h.ctx);
    await h.handlers.get("session_start")!({}, h.ctx);
    await h.call({ action: "close", member: "tests" });
    assert.equal(h.messages.length, 1);
    assert.equal(h.messages[0].message.details.allDone, false);
    assert.equal(h.messages[0].message.details.slots.api.state, "done");
    assert.equal(h.messages[0].message.details.slots.tests.state, "closed");
  } finally { await h.cleanup(); }
});

test("cancellation during startup releases the forthcoming task to ordinary notification", async () => {
  const h = await harness();
  let resume!: () => void;
  try {
    const { batchId } = (await h.call({ action: "batch", expected_members: ["api"] })).details;
    h.pauseStartup(new Promise<void>((resolve) => { resume = resolve; }));
    const dispatch = h.call({ action: "open", member: "api", batch_id: batchId, task: "audit" });
    await waitFor(() => h.entries.some((entry) => entry.data?.slots?.api?.state === "preparing"));
    await h.call({ action: "batch_cancel", batch_id: batchId });
    resume();
    await dispatch;
    await h.finish("api");
    await waitFor(() => h.messages.length === 1);
    assert.equal(h.messages[0].message.customType, "herdr-crew-event");
  } finally { resume?.(); await h.cleanup(); }
});

test("ownership transfer terminates the old batch rather than following the child", async () => {
  const h = await harness();
  try {
    const { batchId } = (await h.call({ action: "batch", expected_members: ["api"] })).details;
    await h.call({ action: "open", member: "api", batch_id: batchId, task: "audit" });
    const record = await h.ownership.get("api");
    await h.ownership.transfer(record!, "foreign");
    await waitFor(() => h.messages.some((item) => item.message.customType === "herdr-crew-batch"));
    const aggregate = h.messages.find((item) => item.message.customType === "herdr-crew-batch");
    assert.equal(aggregate.message.details.slots.api.state, "ownership-lost");
    assert.equal(aggregate.message.details.allDone, false);
  } finally { await h.cleanup(); }
});

test("ordinary status records ownership loss and immediate attention before removal", async () => {
  const h = await harness();
  try {
    const { batchId } = (await h.call({ action: "batch", expected_members: ["api", "later"] })).details;
    await h.call({ action: "open", member: "api", batch_id: batchId, task: "audit" });
    await h.ownership.transfer((await h.ownership.get("api"))!, "foreign");
    await h.call({ action: "status" });
    assert.equal(h.messages.length, 1);
    assert.equal(h.messages[0].message.details.state, "ownership-lost");
    await h.call({ action: "status", batch_id: batchId });
    assert.equal(h.messages.length, 1);
  } finally { await h.cleanup(); }
});

test("confirmed CLI rejection clears pending and reports dispatch failure", async () => {
  const h = await harness();
  try {
    const { batchId } = (await h.call({ action: "batch", expected_members: ["api"] })).details;
    h.failPrompt("cli_usage");
    await assert.rejects(h.call({ action: "open", member: "api", batch_id: batchId, task: "audit" }), /prompt failed/);
    assert.equal((h.messages[0].message.details.slots.api).state, "dispatch-failed");
    assert.equal((await h.ownership.get("api"))!.member && ( (await h.ownership.get("api"))!.member as any).pending, undefined);
  } finally { await h.cleanup(); }
});

test("temporary child-state query failure preserves the batch until completion", async () => {
  const h = await harness();
  try {
    const { batchId } = (await h.call({ action: "batch", expected_members: ["api"] })).details;
    await h.call({ action: "open", member: "api", batch_id: batchId, task: "audit" });
    h.failNextGet();
    const status = await h.call({ action: "status", batch_id: batchId });
    assert.equal(status.details.batch.slots.api.state, "running");
    assert.equal(h.messages.length, 0);
    await h.finish("api");
    await h.call({ action: "collect", member: "api" });
    assert.equal(h.messages[0].message.details.allDone, true);
  } finally { await h.cleanup(); }
});

test("transfer between observation and completion lock records ownership loss", async () => {
  const h = await harness();
  try {
    const { batchId } = (await h.call({ action: "batch", expected_members: ["api"] })).details;
    await h.call({ action: "open", member: "api", batch_id: batchId, task: "audit" });
    await h.finish("api");
    h.onNextGet(async () => { await h.ownership.transfer((await h.ownership.get("api"))!, "foreign"); });
    await waitFor(() => h.messages.some((item) => item.message.customType === "herdr-crew-batch"));
    assert.equal(h.messages.find((item) => item.message.customType === "herdr-crew-batch").message.details.slots.api.state, "ownership-lost");
  } finally { await h.cleanup(); }
});

test("branch change during startup does not dispatch an abandoned batch task", async () => {
  const h = await harness();
  let resume!: () => void;
  try {
    const { batchId } = (await h.call({ action: "batch", expected_members: ["api"] })).details;
    h.pauseStartup(new Promise<void>((resolve) => { resume = resolve; }));
    const dispatch = h.call({ action: "open", member: "api", batch_id: batchId, task: "audit" });
    const rejected = assert.rejects(dispatch, /no longer on the active branch/);
    await waitFor(() => h.entries.some((entry) => entry.data?.slots?.api?.state === "preparing"));
    h.entries.length = 0;
    await h.handlers.get("session_tree")!({}, h.ctx);
    resume();
    await rejected;
    assert.equal(h.agents.get("api")!.agent_status, "idle");
    assert.equal(h.messages.length, 0);
  } finally { resume?.(); await h.cleanup(); }
});

test("tree navigation never turns abandoned batch children into individual notifications", async () => {
  const h = await harness();
  try {
    const { batchId } = (await h.call({ action: "batch", expected_members: ["api"] })).details;
    await h.call({ action: "open", member: "api", batch_id: batchId, task: "audit" });
    h.entries.length = 0;
    await h.handlers.get("session_tree")!({}, h.ctx);
    await h.finish("api");
    await h.call({ action: "status" });
    assert.equal(h.messages.length, 0);
  } finally { await h.cleanup(); }
});
