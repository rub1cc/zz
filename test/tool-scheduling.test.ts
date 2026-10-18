import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { awaitWithContext, BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type, type AssistantMessage, type Context, type ToolCall } from "@earendil-works/pi-ai";
import { createModels, type Provider } from "@earendil-works/pi-ai/models";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import {
  createRegistry, defineExtension, Harness, hook, LiveDoc, ToolTask,
  type Registry, type ToolRegistration, type ToolSlot,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createToolSchedulingExtension, isParallelTool, toolDependencies, TOOL_CONCURRENCY } from "../src/tool-scheduling.js";
import { temporary, tick } from "./helpers.js";

const ctx = BACKGROUND_CONTEXT;
const ref = { provider: "test", modelId: "mock" };
const call = (id: string, name = "read", arguments_: ToolCall["arguments"] = {}): ToolCall =>
  ({ type: "toolCall", id, name, arguments: arguments_ });

function runtime() {
  const models = createModels();
  const model = { ...getBuiltinModel("openai", "gpt-4.1"), provider: ref.provider, id: ref.modelId };
  const stream = (_model: unknown, context: Context) => {
    const events = new AssistantMessageEventStream();
    const last = context.messages.findLast((message) => message.role !== "system");
    const content = last?.role === "user" && typeof last.content === "string"
      ? JSON.parse(last.content) as ToolCall[] : [{ type: "text" as const, text: "Done" }];
    const message: AssistantMessage = {
      role: "assistant", api: model.api, provider: ref.provider, model: ref.modelId, content,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop", timestamp: Date.now(),
    };
    queueMicrotask(() => events.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message }));
    return events;
  };
  models.setProvider({ id: ref.provider, name: "Test", getModels: () => [model], stream, streamSimple: stream,
    auth: { apiKey: { name: "Test", resolve: async () => ({ auth: { apiKey: "test" }, source: "test" }) } },
  } as Provider);
  return models;
}

async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 3000;
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, "Timed out waiting for tool execution");
    await tick();
  }
}

function controls() {
  const started: string[] = [];
  const active = new Set<string>();
  const release = new Map<string, () => void>();
  let maximum = 0;
  const tools: ToolRegistration[] = ["read", "task_list", "task_get", "write", "edit", "bash", "mystery", "ask_question"].map((name) => ({
    name, description: name, parameters: Type.Object({}), replay: name === "bash" ? "unsafe" : "safe",
    execute: async (_args, api, context) => {
      started.push(api.callId); active.add(api.callId); maximum = Math.max(maximum, active.size);
      try {
        await awaitWithContext(new Promise<void>((resolve) => release.set(api.callId, resolve)), context);
        if (api.callId.startsWith("fail")) throw new Error("Expected tool failure");
        return { output: [{ type: "text", text: api.callId }] };
      } finally { active.delete(api.callId); release.delete(api.callId); }
    },
  }));
  return { tools, started, active, release, get maximum() { return maximum; } };
}

async function fixture(limit = 2, configure?: (registry: Registry) => void, legacy = false) {
  const temp = temporary();
  const errors: unknown[] = [];
  const control = controls();
  let scheduled = !legacy;
  const open = async () => {
    const registry = createRegistry();
    registry.install(defineExtension({ name: "test-tools", tools: control.tools }));
    configure?.(registry);
    if (scheduled) registry.install(createToolSchedulingExtension(registry, () => harness, limit));
    const harness = await Harness.open(await openNodeSqliteStorage(join(temp.root, "sessions.sqlite")), {
      registry, models: runtime(), onReport: (error) => errors.push(error),
    }, ctx);
    return harness;
  };
  let harness = await open();
  const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: ref } }, ctx);
  return {
    control, errors, conversation, get harness() { return harness; },
    async restart() { await harness.close(ctx); scheduled = true; harness = await open(); harness.resume(); },
    async slots() { return (await harness.snapshot(LiveDoc, conversation.id, ctx))?.tools ?? []; },
    async submit(calls: ToolCall[]) { return conversation.submit({ type: "input", content: JSON.stringify(calls) }, ctx); },
    async close() { await harness.close(ctx); temp.cleanup(); },
  };
}

function slots(names: string[]): ToolSlot[] {
  return names.map((name, index) => ({ callId: String(index), name, status: "pending" }));
}

test("only known read-only tools qualify; fixed windows and exclusive barriers preserve call order", () => {
  assert.equal(TOOL_CONCURRENCY, 4);
  for (const name of ["read", "task_list", "task_get"]) assert.equal(isParallelTool(name), true);
  for (const name of ["bash", "powershell", "write", "edit", "task_update", "ask_question", "ask_multiple_questions", "unknown"])
    assert.equal(isParallelTool(name), false);
  const round = slots(["read", "read", "task_get", "write", "read", "read", "read", "bash", "unknown", "task_list"]);
  assert.deepEqual(round.map((_, i) => toolDependencies(round, i, 2).map((slot) => slot.callId)), [
    [], [], ["0", "1"], ["0", "1", "2"], ["0", "1", "2", "3"], ["0", "1", "2", "3"],
    ["0", "1", "2", "3", "4", "5"], ["0", "1", "2", "3", "4", "5", "6"],
    ["0", "1", "2", "3", "4", "5", "6", "7"], ["0", "1", "2", "3", "4", "5", "6", "7", "8"],
  ]);
  for (const limit of [0, -1, 1.5, NaN, Infinity])
    assert.throws(() => createToolSchedulingExtension(createRegistry(), () => { throw new Error("unused"); }, limit), /positive integer/);
});

test("parallel windows stay bounded and mutations, shell, unknown tools and questions execute exclusively", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const batches = [[call("r0"), call("r1")], [call("r2")], [call("w", "write")],
      [call("r3"), call("r4", "task_get")], [call("b", "bash")], [call("u", "mystery")],
      [call("q", "ask_question")], [call("r5", "task_list")]];
    await f.submit(batches.flat());
    const expected: string[] = [];
    for (const batch of batches) {
      expected.push(...batch.map((c) => c.id));
      await until(() => batch.every((c) => f.control.active.has(c.id)));
      assert.deepEqual([...f.control.started].sort(), [...expected].sort());
      assert.deepEqual([...f.control.active].sort(), batch.map((c) => c.id).sort());
      const live = await f.slots();
      assert.ok(live.filter((slot) => !expected.includes(slot.callId)).every((slot) => slot.status === "pending"));
      if (batch.length === 2) {
        f.control.release.get(batch[1]!.id)!();
        await until(async () => (await f.slots()).find((s) => s.callId === batch[1]!.id)?.status === "done");
        assert.deepEqual([...f.control.started].sort(), [...expected].sort(), "one finished sibling cannot release the next window");
      }
      f.control.release.get(batch[0]!.id)!();
    }
    await f.harness.waitForIdle(ctx);
    assert.equal(f.control.maximum, 2);
    const view = await f.conversation.context(ctx);
    assert.deepEqual(view.messages.filter((m) => m.role === "toolResult").map((m) => m.toolCallId).sort(), expected.sort());
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test("admission waits for committed results, not just execute returning", { timeout: 10000 }, async () => {
  let release!: () => void;
  let finishing = false;
  const f = await fixture(2, (registry) => registry.install(defineExtension({ name: "pause-result", hooks: [hook(ToolTask, {
    afterTool: async (call, _result, _api, context) => {
      if (call.id === "first") {
        finishing = true;
        await awaitWithContext(new Promise<void>((resolve) => { release = resolve; }), context);
      }
      return undefined;
    },
  })] })));
  try {
    await f.submit([call("first", "write"), call("second")]);
    await until(() => f.control.active.has("first"));
    f.control.release.get("first")!();
    await until(() => finishing);
    assert.deepEqual(f.control.started, ["first"]);
    assert.equal((await f.slots())[1]!.status, "pending");
    release();
    await until(() => f.control.active.has("second"));
    f.control.release.get("second")!();
    await f.harness.waitForIdle(ctx);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test("failed tools keep independent sibling results and do not cancel later groups", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    await f.submit([call("fail-read"), call("sibling"), call("fail-bash", "bash"), call("after")]);
    await until(() => f.control.active.size === 2);
    f.control.release.get("fail-read")!();
    await until(async () => (await f.slots())[0]?.status === "done");
    assert.ok(f.control.active.has("sibling"));
    assert.deepEqual(f.control.started.sort(), ["fail-read", "sibling"]);
    f.control.release.get("sibling")!();
    await until(() => f.control.active.has("fail-bash")); f.control.release.get("fail-bash")!();
    await until(() => f.control.active.has("after")); f.control.release.get("after")!();
    await f.harness.waitForIdle(ctx);
    const results = (await f.conversation.context(ctx)).messages.filter((m) => m.role === "toolResult");
    assert.equal(results.length, 4);
    assert.deepEqual(results.filter((m) => m.isError).map((m) => m.toolCallId).sort(), ["fail-bash", "fail-read"]);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test("invalid and unavailable calls produce results without hanging admission", { timeout: 10000 }, async () => {
  const f = await fixture(2, (registry) => registry.install(defineExtension({ name: "invalid-tool", tools: [{
    name: "needs_argument", description: "Requires path", parameters: Type.Object({ path: Type.String() }),
    execute: async () => { throw new Error("Must not execute"); },
  }] })));
  try {
    await f.submit([call("missing", "not_installed"), call("invalid", "needs_argument"), call("valid")]);
    await until(() => f.control.active.has("valid"));
    f.control.release.get("valid")!(); await f.harness.waitForIdle(ctx);
    const results = (await f.conversation.context(ctx)).messages.filter((m) => m.role === "toolResult");
    assert.equal(results.length, 3);
    assert.equal(results.filter((m) => m.isError).length, 2);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test("cancellation aborts queued calls before intent and leaves one result per call", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    await f.submit([call("running", "bash"), call("queued-write", "write"), call("queued-read")]);
    await until(() => f.control.active.has("running"));
    const live = await f.slots();
    for (const slot of live.slice(1)) {
      const task = await f.harness.getTask(slot.taskId!, ctx);
      assert.ok(task?.state.status === "running" || task?.state.status === "pending");
      assert.equal((task.state.checkpoint as { phase: string }).phase, "call");
    }
    await f.conversation.abort(ctx);
    assert.deepEqual(f.control.started, ["running"]);
    assert.equal(f.control.active.size, 0);
    const results = (await f.conversation.context(ctx)).messages.filter((m) => m.role === "toolResult");
    assert.equal(results.length, 3);
    assert.ok(results.every((m) => m.isError));
    await f.restart(); await f.harness.waitForIdle(ctx);
    assert.deepEqual(f.control.started, ["running"]);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test("restart keeps queued unsafe calls unstarted and replays only unfinished safe work", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    await f.submit([call("finished"), call("interrupted"), call("write-once", "bash"), call("last")]);
    await until(() => f.control.active.size === 2);
    f.control.release.get("finished")!();
    await until(async () => (await f.slots())[0]?.status === "done");
    await f.restart();
    await until(() => f.control.active.has("interrupted"));
    assert.equal(f.control.started.filter((id) => id === "finished").length, 1);
    assert.equal(f.control.started.filter((id) => id === "interrupted").length, 2);
    assert.equal(f.control.active.size, 1);
    assert.ok(!f.control.started.includes("write-once"));
    f.control.release.get("interrupted")!();
    await until(() => f.control.active.has("write-once")); f.control.release.get("write-once")!();
    await until(() => f.control.active.has("last")); f.control.release.get("last")!();
    await f.harness.waitForIdle(ctx);
    assert.equal(f.control.started.filter((id) => id === "write-once").length, 1);
    const conversation = (await f.harness.conversation(f.conversation.id, ctx))!;
    const results = (await conversation.context(ctx)).messages.filter((m) => m.role === "toolResult");
    assert.equal(results.length, 4);
    assert.equal(new Set(results.map((m) => m.toolCallId)).size, 4);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test("unsafe execution is not replayed after restart and queued calls continue", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    await f.submit([call("unsafe", "bash"), call("queued")]);
    await until(() => f.control.active.has("unsafe"));
    await f.restart();
    await until(() => f.control.active.has("queued"));
    assert.equal(f.control.started.filter((id) => id === "unsafe").length, 1);
    f.control.release.get("queued")!(); await f.harness.waitForIdle(ctx);
    const conversation = (await f.harness.conversation(f.conversation.id, ctx))!;
    const results = (await conversation.context(ctx)).messages.filter((m) => m.role === "toolResult");
    assert.equal(results.length, 2);
    assert.match(results.find((m) => m.toolCallId === "unsafe")!.content.map((b) => b.type === "text" ? b.text : "").join(""), /interrupted/);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test("nested tool calls retain their exclusive parent's reservation without deadlocking", { timeout: 10000 }, async () => {
  const f = await fixture(2, (registry) => registry.install(defineExtension({ name: "nested", tools: [{
    name: "parent", description: "Calls a nested tool", parameters: Type.Object({}),
    execute: async (_args, api, context) => {
      const result = await api.executeTool("read", {}, context);
      return { output: [{ type: "text", text: String(result.structuredOutput) }] };
    },
  }] })));
  try {
    await f.submit([call("parent", "parent"), call("after")]);
    await until(() => f.control.active.has("parent/1"));
    assert.deepEqual(f.control.started, ["parent/1"]);
    f.control.release.get("parent/1")!();
    await until(() => f.control.active.has("after")); f.control.release.get("after")!();
    await f.harness.waitForIdle(ctx);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test("recovery gates legacy replay-safe intents that originally ran without any concurrency limit", { timeout: 10000 }, async () => {
  const f = await fixture(2, undefined, true);
  try {
    const batches = [[call("r0"), call("r1")], [call("r2"), call("r3")], [call("r4")],
      [call("mutation", "write")], [call("last")]];
    await f.submit(batches.flat());
    await until(() => f.control.active.size === 7);
    await f.restart();
    for (const batch of batches) {
      await until(() => batch.every((c) => f.control.active.has(c.id)));
      assert.deepEqual([...f.control.active].sort(), batch.map((c) => c.id).sort());
      for (const c of batch) f.control.release.get(c.id)!();
    }
    await f.harness.waitForIdle(ctx);
    for (const c of batches.flat()) assert.equal(f.control.started.filter((id) => id === c.id).length, 2);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test("a delayed earlier hook cannot let a later window overtake the original call order", { timeout: 10000 }, async () => {
  let releaseHook!: () => void;
  const f = await fixture(2, (registry) => registry.install(defineExtension({ name: "delay-first", hooks: [hook(ToolTask, {
    beforeTool: async (call, _api, context) => {
      if (call.id === "first") await awaitWithContext(new Promise<void>((resolve) => { releaseHook = resolve; }), context);
      return undefined;
    },
  })] })));
  try {
    await f.submit([call("first"), call("second"), call("third")]);
    await until(() => f.control.active.has("second"));
    f.control.release.get("second")!();
    await until(async () => (await f.slots())[1]?.status === "done");
    assert.deepEqual(f.control.started, ["second"]);
    releaseHook();
    await until(() => f.control.active.has("first"));
    assert.deepEqual(f.control.started, ["second", "first"]);
    f.control.release.get("first")!();
    await until(() => f.control.active.has("third")); f.control.release.get("third")!();
    await f.harness.waitForIdle(ctx);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test("exclusive operations in separate conversations remain independent", { timeout: 10000 }, async () => {
  const f = await fixture(1);
  try {
    const other = await f.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: ref } }, ctx);
    await f.submit([call("first-session", "bash")]);
    await until(() => f.control.active.has("first-session"));
    await other.submit({ type: "input", content: JSON.stringify([call("second-session", "bash")]) }, ctx);
    await until(() => f.control.active.has("second-session"));
    assert.equal(f.control.active.size, 2);
    f.control.release.get("second-session")!(); await other.waitForIdle(ctx);
    assert.ok(f.control.active.has("first-session"));
    f.control.release.get("first-session")!(); await f.harness.waitForIdle(ctx);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
