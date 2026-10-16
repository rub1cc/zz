import assert from "node:assert/strict";
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createModels, type Provider } from "@earendil-works/pi-ai/models";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { AssistantMessage, Context, SimpleStreamOptions, ThinkingContent, TextContent, ToolCall, Usage } from "@earendil-works/pi-ai";
import { InboxDoc, type ConversationId } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { Controller } from "../src/controller.js";
import { lastReply, transcriptMessages } from "../src/model.js";
import { DurableEngine } from "../src/engine.js";
import type { Project, Session } from "../src/model.js";
import { Store } from "../src/store.js";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import { InstructionCatalog } from "../src/instructions.js";
import { image, png } from "./image-fixtures.js";
import { SkillCatalog } from "../src/skills.js";
import { UndoDoc } from "../src/undo.js";
import { temporary, tick } from "./helpers.js";

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "Timed out waiting for durable state");
    await tick();
  }
}

function openEngine(...args: Parameters<typeof DurableEngine.open>) {
  args[5] ??= new SkillCatalog(async () => ({ skills: [], diagnostics: [] }));
  return DurableEngine.open(...args);
}

function session(project: Project, id: string): Session {
  return { id, projectId: project.id, title: id, status: "working", preview: "Starting", createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
}

function models(options: { pause?: boolean; finish?: (done: (failure?: string, content?: (TextContent | ThinkingContent | ToolCall)[]) => void) => void; overflow?: boolean; started?: () => void; context?: (context: Context) => void; request?: (id: string, reasoning: SimpleStreamOptions["reasoning"]) => void;
  usage?: Usage; titleUsage?: Usage; contextWindow?: number; imageInput?: boolean;
  reply?: (context: Context) => (TextContent | ThinkingContent | ToolCall)[];
  compaction?: { fail?: boolean; pause?: boolean; started?: () => void; context?: (context: Context) => void; request?: (options?: SimpleStreamOptions) => void; usage?: Usage };
  title?: { text?: string; fail?: boolean; pause?: boolean; ignoreAbort?: boolean; finish?: (done: () => void) => void; context?: (context: Context) => void } } = {}) {
  const models = createModels();
  const model = { ...getBuiltinModel("openai", "gpt-4.1"), provider: "test", id: "mock",
    ...(options.contextWindow === undefined ? {} : { contextWindow: options.contextWindow }),
    ...(options.imageInput === false ? { input: ["text" as const] } : {}) };
  const stream = (_model: unknown, context: Context, request?: SimpleStreamOptions) => {
    const isTitle = context.messages.some((m) => m.role === "system" && typeof m.content === "string" && m.content.startsWith("Generate a short session title"));
    const isCompaction = context.messages.some((m) => m.role === "system" && typeof m.content === "string" && m.content.startsWith("You are a context summarization assistant"));
    if (isTitle) options.title?.context?.(context);
    else if (isCompaction) { options.compaction?.context?.(context); options.compaction?.request?.(request); }
    else {
      options.context?.(context);
      options.request?.((_model as { id: string }).id, request?.reasoning);
    }
    const events = new AssistantMessageEventStream();
    const message: AssistantMessage = {
      role: "assistant", api: "openai-responses", provider: "test", model: "mock", content: [],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop", timestamp: Date.now(),
    };
    queueMicrotask(() => {
      if (isCompaction) options.compaction?.started?.();
      else if (!isTitle) options.started?.();
      if (isTitle ? options.title?.pause : isCompaction ? options.compaction?.pause : options.pause) {
        if (isTitle && options.title?.ignoreAbort) {
          options.title.finish?.(() => {
            message.content = [{ type: "text", text: "Late session title" }];
            events.push({ type: "done", reason: "stop", message });
          });
          return;
        }
        const abort = () => {
          message.stopReason = "aborted";
          events.push({ type: "error", reason: "aborted", error: message });
        };
        if (request?.signal?.aborted) abort(); else request?.signal?.addEventListener("abort", abort, { once: true });
        if (!isTitle && !isCompaction) options.finish?.((failure, content) => {
          message.content = content ?? [{ type: "text", text: "Recovered answer" }];
          if (failure) {
            message.stopReason = "error"; message.errorMessage = failure;
            events.push({ type: "error", reason: "error", error: message });
          } else {
            message.stopReason = message.content.some((block) => block.type === "toolCall") ? "toolUse" : "stop";
            events.push({ type: "done", reason: message.stopReason, message });
          }
        });
        return;
      }
      if (isCompaction) {
        message.content = [{ type: "text", text: "Checkpoint: preserve the implementation plan and pending tests." }];
        if (options.compaction?.usage) message.usage = structuredClone(options.compaction.usage);
        if (options.compaction?.fail) {
          message.stopReason = "error"; message.errorMessage = "Summary unavailable";
          events.push({ type: "error", reason: "error", error: message });
        } else events.push({ type: "done", reason: "stop", message });
        return;
      }
      if (isTitle ? options.titleUsage : options.usage) message.usage = structuredClone((isTitle ? options.titleUsage : options.usage)!);
      if (isTitle) {
        message.content = [{ type: "text", text: options.title?.text ?? "Short session title" }];
        if (options.title?.fail) {
          message.stopReason = "error"; message.errorMessage = "Title unavailable";
          events.push({ type: "error", reason: "error", error: message });
        } else events.push({ type: "done", reason: "stop", message });
        return;
      }
      const last = context.messages.at(-1);
      if (options.overflow) {
        options.overflow = false;
        message.stopReason = "error"; message.errorMessage = "maximum context length exceeded";
        events.push({ type: "error", reason: "error", error: message });
        return;
      }
      if (typeof last?.content === "string" && last.content === "fail") {
        message.stopReason = "error"; message.errorMessage = "Simulated provider failure";
        events.push({ type: "error", reason: "error", error: message });
        return;
      }
      const content: (TextContent | ThinkingContent | ToolCall)[] = options.reply?.(context) ?? (last?.role === "toolResult"
        ? [{ type: "text", text: `Read: ${last.content.filter((b) => b.type === "text").map((b) => b.text).join("")}` }]
        : last?.content === "long-shell"
          ? [{ type: "toolCall", id: "sleep-call", name: "bash", arguments: { command: "printf 'SHELL_STARTED\\n'; sleep 30; printf 'SHOULD_NOT_FINISH\\n'" } }]
        : last?.content === "Ask a random question"
          ? [{ type: "toolCall", id: "random-question", name: "ask_user", arguments: { question: "What is your favorite useless skill?" } }]
        : typeof last?.content === "string" && last.content.includes("ask")
          ? [{ type: "toolCall", id: `ask-${Date.now()}`, name: "ask_user", arguments: { question: "Retry or stop?" } }]
          : typeof last?.content === "string" && last.content.includes("read")
            ? [{ type: "toolCall", id: `read-${Date.now()}`, name: "read", arguments: { path: "marker.txt" } }]
            : [{ type: "text", text: "Recovered answer" }]);
      message.content = content;
      message.stopReason = content.some((b) => b.type === "toolCall") ? "toolUse" : "stop";
      events.push({ type: "done", reason: message.stopReason, message });
    });
    return events;
  };
  models.setProvider({ id: "test", name: "Test provider", getModels: () => [model, {
    ...model, id: "reasoner", reasoning: true, contextWindow: 200_000,
    thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: null },
  }],
    auth: { apiKey: { name: "Test", resolve: async () => ({ auth: { apiKey: "test" }, source: "test" }) } },
    stream, streamSimple: stream,
  } as Provider);
  return models;
}

test("durable conversations execute tools concurrently in their own cwd and retain reply history", async () => {
  const temp = temporary();
  const errors: unknown[] = [];
  const store = new Store(join(temp.root, "data"));
  const paths = [join(temp.root, "a"), join(temp.root, "b")];
  for (const [i, path] of paths.entries()) { mkdirSync(path); writeFileSync(join(path, "marker.txt"), `project-${i}`); }
  const projects = paths.map((path) => store.addProject(path));
  const sessions = projects.map((p, i) => session(p, `session-${i}`));
  store.state.sessions.push(...sessions);
  let engine = await openEngine(store, { provider: "test", modelId: "mock" }, (error) => errors.push(error), models());
  try {
    await Promise.all(sessions.map((s, i) => engine.run(s, projects[i]!, "read marker", () => {})));
    assert.equal(errors.length, 0);
    assert.match(sessions[0]!.messages.at(-1)!.text, /project-0/);
    assert.match(sessions[1]!.messages.at(-1)!.text, /project-1/);
    const tool = sessions[0]!.messages.filter((m) => m.role === "tool");
    assert.equal(tool.length, 1);
    assert.equal(tool[0]?.tool?.name, "read");
    assert.equal(tool[0]?.tool?.status, "done");
    assert.match(tool[0]!.tool!.output, /project-0/);
    assert.notEqual(sessions[0]!.conversationId, sessions[1]!.conversationId);
    for (const s of sessions) {
      assert.ok(s.work);
      assert.ok(s.work.finishedAt! >= s.work.startedAt);
    }
    const firstTiming = { ...sessions[0]!.work! };
    await engine.close();
    const restored = new Store(store.root);
    engine = await openEngine(restored, { provider: "test", modelId: "mock" }, (error) => errors.push(error), models());
    await engine.restore(() => {});
    const first = restored.state.sessions[0]!;
    assert.deepEqual(first.work, firstTiming);
    await engine.run(first, projects[0]!, "reply", () => {});
    assert.ok(first.work!.startedAt >= firstTiming.finishedAt!);
    assert.equal(first.messages.filter((m) => m.role === "user").length, 2);
    assert.equal(first.status, "completed");
    assert.equal(errors.length, 0);
  } finally { await engine.close(); temp.cleanup(); }
});

test("ask_user marks needs input and a reply resumes the same conversation", async () => {
  const temp = temporary();
  const store = new Store(temp.root); const project = store.addProject(temp.root);
  const s = session(project, "question"); store.state.sessions.push(s);
  const engine = await openEngine(store, { provider: "test", modelId: "mock" }, () => {}, models());
  try {
    await engine.run(s, project, "ask", () => {});
    assert.equal(s.status, "needs-input");
    assert.ok(s.work?.finishedAt);
    assert.equal(s.messages.at(-1)?.text, "Retry or stop?");
    await engine.run(s, project, "retry", () => {});
    assert.equal(s.status, "completed");
    assert.equal(s.messages.filter((m) => m.role === "user").length, 2);
  } finally { await engine.close(); temp.cleanup(); }
});

test("conversational questions are instructed to use ask_user and wait for a reply", async () => {
  const temp = temporary();
  const store = new Store(temp.root); const project = store.addProject(temp.root);
  const s = session(project, "random-question"); store.state.sessions.push(s);
  const contexts: Context[] = [];
  const engine = await openEngine(store, { provider: "test", modelId: "mock" }, () => {}, models({
    context: (context) => contexts.push(context),
  }));
  try {
    // The offline provider simulates the tool call; verify the actual policy sent to it too.
    await engine.run(s, project, "Ask a random question", () => {});
    const system = contexts[0]!.messages.filter((m) => m.role === "system");
    const instructions = [contexts[0]!.systemPrompt,
      ...system.flatMap((m) => [m.content, ...Object.values(m.sections ?? {})])].join("\n");
    assert.match(instructions, /Use ask_user whenever you ask the user a question and expect an answer/);
    assert.match(instructions, /including conversational or random questions/);
    assert.match(instructions, /Do not use ask_user for rhetorical questions, quoted questions, or examples/);
    const tool = [...(contexts[0]!.tools ?? []), ...system.flatMap((m) => m.toolsAdded ?? [])]
      .find((tool) => tool.name === "ask_user");
    assert.match(tool?.description ?? "", /including conversational or random questions/);
    assert.match(tool?.description ?? "", /needs-input/);
    assert.equal(s.status, "needs-input");
    assert.equal(s.messages.at(-1)?.text, "What is your favorite useless skill?");
    const conversation = s.conversationId;
    await engine.run(s, project, "Juggling", () => {});
    assert.equal(s.conversationId, conversation);
    assert.equal(s.status, "completed");
    assert.equal(s.messages.filter((m) => m.role === "user").length, 2);
  } finally { await engine.close(); temp.cleanup(); }
});

test("closing checkpoints unfinished work; reopening resumes without duplicating user input", async () => {
  const temp = temporary();
  const store = new Store(temp.root); const project = store.addProject(temp.root);
  const s = session(project, "recover"); store.state.sessions.push(s);
  let started!: () => void;
  const begin = new Promise<void>((resolve) => { started = resolve; });
  let engine = await openEngine(store, { provider: "test", modelId: "mock" }, () => {}, models({ pause: true, started }));
  let finished!: () => void;
  const completed = new Promise<void>((resolve) => { finished = resolve; });
  try {
    const running = engine.run(s, project, "hello", () => {});
    await begin; await engine.close(); await running;
    assert.ok(s.pendingInput);
    const restored = new Store(temp.root);
    engine = await openEngine(restored, { provider: "test", modelId: "mock" }, () => {}, models());
    await engine.restore(() => { if (restored.state.sessions[0]?.pendingInput === undefined) finished(); });
    await completed;
    const recovered = restored.state.sessions[0]!;
    assert.equal(recovered.status, "completed");
    assert.equal(recovered.messages.filter((m) => m.role === "user").length, 1);
    assert.equal(recovered.messages.at(-1)?.text, "Recovered answer");
  } finally { await engine.close(); temp.cleanup(); }
});

test("cancel aborts without disposing the conversation and the next reply retains its context", { timeout: 5000 }, async () => {
  const temp = temporary();
  const store = new Store(temp.root); const project = store.addProject(temp.root);
  const s = session(project, "cancel"); store.state.sessions.push(s);
  let started!: () => void;
  const begin = new Promise<void>((resolve) => { started = resolve; });
  const contexts: Context[] = [];
  const options = { pause: true, started, context: (context: Context) => contexts.push(context), title: { pause: true } };
  const engine = await openEngine(store, { provider: "test", modelId: "mock" }, () => {}, models(options));
  try {
    const running = engine.run(s, project, "original request", () => {});
    await begin;
    const id = s.conversationId;
    await Promise.all([engine.cancel(s.id), engine.cancel(s.id)]); await running;
    assert.equal(s.status, "paused"); assert.equal(s.stopped, true); assert.equal(s.pendingInput, undefined);
    assert.match(s.preview, /Stopped/); assert.equal(s.messages.filter((m) => m.role === "error").length, 0);
    options.pause = false;
    await engine.run(s, project, "continue", () => {});
    assert.equal(s.conversationId, id); assert.equal(s.status, "completed");
    assert.equal(s.stopped, undefined);
    assert.equal(s.messages.filter((m) => m.role === "user").length, 2);
    assert.match(JSON.stringify(contexts.at(-1)), /original request/);
  } finally { await engine.close(); temp.cleanup(); }
});

test("a stopped session stays stopped after reopen and can still continue the same conversation", { timeout: 5000 }, async () => {
  const temp = temporary();
  let store = new Store(temp.root); const project = store.addProject(temp.root);
  const s = session(project, "stopped"); store.state.sessions.push(s);
  let started!: () => void;
  const begin = new Promise<void>((resolve) => { started = resolve; });
  let engine = await openEngine(store, { provider: "test", modelId: "mock" }, () => {}, models({ pause: true, started }));
  try {
    const running = engine.run(s, project, "hello", () => {});
    await begin; await engine.cancel(s.id); await running;
    const id = s.conversationId;
    await engine.close(); store = new Store(temp.root);
    const contexts: Context[] = [];
    engine = await openEngine(store, undefined, () => {}, models({ context: (context) => contexts.push(context) }));
    await engine.restore(() => {}); await engine.harness.waitForIdle(BACKGROUND_CONTEXT);
    const restored = store.state.sessions[0]!;
    assert.equal(restored.status, "paused"); assert.equal(contexts.length, 0);
    assert.equal(restored.pendingInput, undefined);
    await engine.run(restored, project, "continue", () => {});
    assert.equal(restored.conversationId, id); assert.equal(restored.status, "completed");
    assert.equal(restored.messages.filter((m) => m.role === "user").length, 2);
  } finally { await engine.close(); temp.cleanup(); }
});

test("cancel before input admission prevents a model request", { timeout: 5000 }, async () => {
  const temp = temporary();
  const store = new Store(temp.root); const project = store.addProject(temp.root);
  const s = session(project, "early-stop"); store.state.sessions.push(s);
  let requests = 0;
  const engine = await openEngine(store, { provider: "test", modelId: "mock" }, () => {}, models({ request: () => requests++ }));
  try {
    const running = engine.run(s, project, "hello", () => {});
    await engine.cancel(s.id); await running;
    assert.equal(requests, 0); assert.equal(s.status, "paused"); assert.equal(s.pendingInput, undefined);
  } finally { await engine.close(); temp.cleanup(); }
});

test("persisted stop intent aborts recovered work before it can restart a model request", { timeout: 5000 }, async () => {
  const temp = temporary();
  let store = new Store(temp.root); const project = store.addProject(temp.root);
  const s = session(project, "recover-stop"); store.state.sessions.push(s);
  let started!: () => void;
  const begin = new Promise<void>((resolve) => { started = resolve; });
  let engine = await openEngine(store, { provider: "test", modelId: "mock" }, () => {}, models({ pause: true, started }));
  try {
    const running = engine.run(s, project, "hello", () => {});
    await begin;
    // Simulate shutdown after persisting the user's intent but before admitting abort.
    s.stopped = true; store.save();
    await engine.close(); await running;
    store = new Store(temp.root);
    let requests = 0;
    engine = await openEngine(store, undefined, () => {}, models({ request: () => requests++ }));
    await engine.restore(() => {}); await engine.harness.waitForIdle(BACKGROUND_CONTEXT);
    assert.equal(requests, 0); assert.equal(store.state.sessions[0]!.status, "paused");
    assert.equal(store.state.sessions[0]!.pendingInput, undefined);
  } finally { await engine.close(); temp.cleanup(); }
});

test("cancel terminates an active shell tool without discarding its session", { timeout: 5000 }, async () => {
  const temp = temporary();
  const store = new Store(temp.root); const project = store.addProject(temp.root);
  const s = session(project, "shell-stop"); store.state.sessions.push(s);
  const engine = await openEngine(store, { provider: "test", modelId: "mock" }, () => {}, models());
  let started!: () => void;
  const begin = new Promise<void>((resolve) => { started = resolve; });
  try {
    const running = engine.run(s, project, "long-shell", () => {
      if (s.messages.some((m) => m.tool?.output.includes("SHELL_STARTED"))) started();
    });
    await begin;
    const id = s.conversationId;
    await engine.cancel(s.id); await running;
    assert.equal(s.status, "paused"); assert.equal(s.conversationId, id);
    assert.equal(s.messages.find((m) => m.tool?.name === "bash")?.tool?.status, "interrupted");
    assert.ok(!s.messages.some((m) => m.tool?.output.includes("SHOULD_NOT_FINISH")));
  } finally { await engine.close(); temp.cleanup(); }
});

test("provider failures remain failed after reopening and can be retried", async () => {
  const temp = temporary();
  let store = new Store(temp.root); const project = store.addProject(temp.root);
  const s = session(project, "failed"); store.state.sessions.push(s);
  let engine = await openEngine(store, { provider: "test", modelId: "mock" }, () => {}, models());
  try {
    await engine.run(s, project, "fail", () => {});
    assert.equal(s.status, "failed");
    assert.ok(s.work?.finishedAt);
    assert.match(s.preview, /Simulated provider failure/);
    store.save(); await engine.close();
    store = new Store(temp.root);
    engine = await openEngine(store, { provider: "test", modelId: "mock" }, () => {}, models());
    await engine.restore(() => {});
    const restored = store.state.sessions[0]!;
    assert.equal(restored.status, "failed");
    await engine.run(restored, project, "retry", () => {});
    assert.equal(restored.status, "completed");
  } finally { await engine.close(); temp.cleanup(); }
});

test("model and supported thinking changes are persisted per session and reach the next request", async () => {
  const temp = temporary();
  const store = new Store(temp.root); const project = store.addProject(temp.root);
  const s = session(project, "configured"); store.state.sessions.push(s);
  const requests: { id: string; reasoning: SimpleStreamOptions["reasoning"] }[] = [];
  let engine = await openEngine(store, { provider: "test", modelId: "mock" }, () => {}, models({ request: (id, reasoning) => requests.push({ id, reasoning }) }));
  try {
    await engine.configure({ model: { provider: "test", modelId: "reasoner" }, thinkingLevel: "high" });
    await engine.run(s, project, "hello", () => {});
    assert.deepEqual(requests.at(-1), { id: "reasoner", reasoning: "high" });
    assert.equal(s.agent?.thinkingLevel, "high");
    await assert.rejects(engine.configure({ thinkingLevel: "medium" }, s), /supports thinking/);
    await engine.configure({ model: { provider: "test", modelId: "mock" } }, s);
    assert.equal(s.agent?.thinkingLevel, "off");
    const conversation = await engine.harness.conversation(s.conversationId as Parameters<typeof engine.harness.conversation>[0], BACKGROUND_CONTEXT);
    assert.equal((await conversation!.agent(BACKGROUND_CONTEXT)).thinkingLevel, "off");
    assert.equal(engine.configuration().model?.modelId, "reasoner");
    await engine.run(s, project, "again", () => {});
    assert.equal(requests.at(-1)?.id, "mock");
    await engine.close();
    const restored = new Store(temp.root);
    engine = await openEngine(restored, undefined, () => {}, models());
    await engine.restore(() => {});
    assert.equal(engine.configuration(restored.state.sessions[0]).model?.modelId, "mock");
    assert.equal(engine.configuration().thinkingLevel, "high");
  } finally { await engine.close(); temp.cleanup(); }
});

test("skills are advertised to the model and explicit loads are compact durable activity", async () => {
  const temp = temporary();
  const store = new Store(temp.root); const project = store.addProject(temp.root);
  const s = session(project, "skill"); store.state.sessions.push(s);
  const dir = join(temp.root, "fixture"); mkdirSync(dir);
  writeFileSync(join(dir, "SKILL.md"), "---\nname: fixture\ndescription: Summarize a project\n---\n\nALPHA_INSTRUCTION: Write a concise summary.\n");
  const skills = new SkillCatalog(async () => loadSkillsFromDir({ dir, source: "path" }));
  const contexts: Context[] = [];
  let engine = await openEngine(store, { provider: "test", modelId: "mock" }, () => {}, models({ context: (context) => contexts.push(context) }), "off", skills);
  try {
    await engine.run(s, project, "/skill:fixture summarize", () => {});
    assert.equal(s.status, "completed");
    assert.match(JSON.stringify(contexts[0]), /available_skills/);
    assert.match(JSON.stringify(contexts[0]), /ALPHA_INSTRUCTION/);
    assert.equal(s.messages.find((m) => m.role === "user")?.text, "/skill:fixture summarize");
    const card = s.messages.find((m) => m.tool?.name === "load_skill")!;
    assert.equal(card.tool?.arguments.name, "fixture");
    assert.match(card.tool!.output, /ALPHA_INSTRUCTION/);
    const id = card.tool!.id;
    await engine.close();
    const restored = new Store(temp.root);
    engine = await openEngine(restored, undefined, () => {}, models());
    await engine.restore(() => {});
    const restoredCard = restored.state.sessions[0]!.messages.find((m) => m.tool?.name === "load_skill");
    assert.equal(restoredCard?.tool?.id, id);
    assert.match(restoredCard!.tool!.output, /ALPHA_INSTRUCTION/);
  } finally { await engine.close(); temp.cleanup(); }
});

test("thinking changes during a model request persist without interrupting that request", async () => {
  const temp = temporary();
  const store = new Store(temp.root); const project = store.addProject(temp.root);
  const s = session(project, "thinking-live"); store.state.sessions.push(s);
  let started!: () => void;
  const begin = new Promise<void>((resolve) => { started = resolve; });
  const requests: unknown[] = [];
  const engine = await openEngine(store, { provider: "test", modelId: "reasoner" }, () => {}, models({ pause: true, started,
    request: (_id, reasoning) => requests.push(reasoning) }), "low");
  try {
    const running = engine.run(s, project, "hello", () => {});
    await begin;
    await engine.configure({ thinkingLevel: "high" }, s);
    assert.equal(s.agent?.thinkingLevel, "high");
    assert.equal(s.status, "working");
    assert.deepEqual(requests, ["low"]);
    await assert.rejects(engine.configure({ model: { provider: "test", modelId: "mock" } }, s), /finish/);
    await engine.close(); await running;
  } finally { await engine.close(); temp.cleanup(); }
});

test("an interrupted explicit skill run resumes its saved instructions without rereading the file", { timeout: 5000 }, async () => {
  const temp = temporary();
  const store = new Store(temp.root); const project = store.addProject(temp.root);
  const s = session(project, "resume-skill"); store.state.sessions.push(s);
  const dir = join(temp.root, "skill"); mkdirSync(dir);
  const file = join(dir, "SKILL.md");
  writeFileSync(file, "---\nname: fixture\ndescription: Summarize a project\n---\n\nSAVED_SKILL_BODY\n");
  const skills = new SkillCatalog(async () => loadSkillsFromDir({ dir, source: "path" }));
  let started!: () => void;
  const begin = new Promise<void>((resolve) => { started = resolve; });
  let engine = await openEngine(store, { provider: "test", modelId: "mock" }, () => {}, models({ pause: true, started }), "off", skills);
  try {
    const running = engine.run(s, project, "/skill:fixture summarize", () => {});
    await begin; await engine.close(); await running;
    assert.match(s.pendingInput!.prepared!.content, /SAVED_SKILL_BODY/);
    unlinkSync(file);
    const restored = new Store(temp.root);
    const contexts: Context[] = [];
    engine = await openEngine(restored, undefined, () => {}, models({ context: (context) => contexts.push(context) }));
    let done!: () => void;
    const completed = new Promise<void>((resolve) => { done = resolve; });
    await engine.restore(() => { if (!restored.state.sessions[0]?.pendingInput) done(); });
    await completed;
    assert.equal(restored.state.sessions[0]!.status, "completed");
    assert.equal(restored.state.sessions[0]!.messages.filter((m) => m.role === "user").length, 1);
    assert.match(JSON.stringify(contexts), /SAVED_SKILL_BODY/);
  } finally { await engine.close(); temp.cleanup(); }
});

test("new sessions receive a persisted short title without adding title prompts to the conversation", async () => {
  const temp = temporary();
  const store = new Store(temp.root); const project = store.addProject(temp.root);
  const s = session(project, "fallback"); store.state.sessions.push(s);
  const titleContexts: Context[] = [];
  let engine = await openEngine(store, { provider: "test", modelId: "mock" }, () => {}, models({
    title: { text: 'Title: "Improve session naming"', context: (context) => titleContexts.push(context) },
  }));
  try {
    await engine.run(s, project, "Generate short titles for new sessions", () => {});
    assert.equal(s.title, "Improve session naming");
    assert.equal(titleContexts.length, 1);
    assert.equal(titleContexts[0]?.messages.at(-1)?.content, "Generate short titles for new sessions");
    assert.ok(titleContexts[0]?.messages.every((m) => m.role !== "system" || !m.toolsAdded?.length));
    assert.equal(s.messages.filter((m) => m.role === "user").length, 1);
    assert.ok(!JSON.stringify(s.messages).includes("Generate a short session title"));
    await engine.run(s, project, "follow up", () => {});
    assert.equal(titleContexts.length, 1);
    assert.equal(s.title, "Improve session naming");
    await engine.close();
    const restored = new Store(temp.root);
    engine = await openEngine(restored, undefined, () => {}, models({ title: { context: () => assert.fail("Do not rename restored sessions") } }));
    await engine.restore(() => {});
    assert.equal(restored.state.sessions[0]?.title, "Improve session naming");
    await engine.run(restored.state.sessions[0]!, project, "another reply", () => {});
    assert.equal(restored.state.sessions[0]?.title, "Improve session naming");
  } finally { await engine.close(); temp.cleanup(); }
});

test("title output is bounded and title errors or empty output retain the fallback", async () => {
  for (const [text, fail, expected] of [
    ["one two three four five six seven eight", false, "one two three four five six"],
    ["a".repeat(50) + " " + "b".repeat(20), false, "a".repeat(50)],
    [" \n\t ", false, "fallback"],
    ["not a usable title", true, "fallback"],
    ["# **Fix\n session\t naming**", false, "Fix session naming"],
  ] as const) {
    const temp = temporary();
    const store = new Store(temp.root); const project = store.addProject(temp.root);
    const s = session(project, "fallback"); store.state.sessions.push(s);
    const engine = await openEngine(store, { provider: "test", modelId: "mock" }, () => {}, models({ title: { text, fail } }));
    try {
      await engine.run(s, project, "hello", () => {});
      assert.equal(s.status, "completed");
      assert.equal(s.title, expected);
    } finally { await engine.close(); temp.cleanup(); }
  }
});

test("slow titles do not block task completion and are cancelled on stop or close", { timeout: 5000 }, async () => {
  for (const action of ["stop", "close"] as const) {
    const temp = temporary();
    const store = new Store(temp.root); const project = store.addProject(temp.root);
    const s = session(project, "fallback"); store.state.sessions.push(s);
    const engine = await openEngine(store, { provider: "test", modelId: "mock" }, () => {}, models({ title: { pause: true } }));
    try {
      await engine.run(s, project, "hello", () => {});
      assert.equal(s.status, "completed");
      assert.equal(s.title, "fallback");
      if (action === "stop") await engine.stop(s.id);
      else await engine.close();
      assert.equal(s.title, "fallback");
    } finally { await engine.close(); temp.cleanup(); }
  }
});

test("shutdown closes durable work before joining a title that ignores abort and suppresses late saves", { timeout: 3000 }, async () => {
  const temp = temporary();
  const store = new Store(temp.root); const project = store.addProject(temp.root);
  const s = session(project, "shutdown"); store.state.sessions.push(s);
  let started!: () => void;
  const begin = new Promise<void>((resolve) => { started = resolve; });
  let finishTitle!: () => void;
  let changed = 0;
  const engine = await openEngine(store, { provider: "test", modelId: "mock" }, () => {}, models({ pause: true, started,
    title: { pause: true, ignoreAbort: true, finish: (done) => { finishTitle = done; } } }));
  try {
    const running = engine.run(s, project, "hello", () => { changed++; });
    await begin;
    const closed = engine.close();
    await engine.harness.closed;
    await closed; await running;
    assert.equal(s.status, "paused"); assert.ok(s.pendingInput, "unfinished input remains recoverable");
    const saved = JSON.stringify(store.state); const changes = changed;
    finishTitle(); await new Promise<void>((done) => setImmediate(done));
    assert.equal(JSON.stringify(store.state), saved);
    assert.equal(changed, changes);
  } finally { finishTitle?.(); await engine.close(); temp.cleanup(); }
});

test("usage includes tool rounds and title overhead once, survives restore, and follows model limits", async () => {
  const temp = temporary();
  let store = new Store(temp.root); const project = store.addProject(temp.root);
  writeFileSync(join(temp.root, "marker.txt"), "contents");
  const s = session(project, "usage"); store.state.sessions.push(s);
  const usage: Usage = { input: 100, output: 20, cacheRead: 300, cacheWrite: 80, totalTokens: 500,
    cost: { input: 0.001, output: 0.002, cacheRead: 0.003, cacheWrite: 0.004, total: 0.01 } };
  const titleUsage: Usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
    cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.002 } };
  const runtime = models({ usage, titleUsage });
  const errors: unknown[] = [];
  let engine = await openEngine(store, { provider: "test", modelId: "mock" }, (e) => errors.push(e), runtime);
  try {
    assert.equal(engine.stats(s).usage, undefined);
    assert.deepEqual(engine.stats(), { contextWindow: runtime.getModel("test", "mock")?.contextWindow });
    await engine.run(s, project, "read marker", () => {});
    const stats = engine.stats(s);
    assert.equal(stats.usage?.input, 210);
    assert.equal(stats.usage?.output, 45);
    assert.equal(stats.usage?.cacheRead, 600);
    assert.equal(stats.usage?.cacheWrite, 160);
    assert.equal(stats.usage?.totalTokens, 1015);
    assert.equal(stats.usage?.cost.total, 0.022);
    assert.equal(stats.titleUsage?.cost.total, 0.002);
    assert.equal(stats.context?.tokens, 500, "context uses the latest response, not cumulative spend or title usage");
    assert.equal(stats.context?.cacheHitRate, 62.5);
    assert.equal(stats.contextWindow, runtime.getModel("test", "mock")?.contextWindow);
    const conversation = await engine.harness.conversation(s.conversationId as Parameters<typeof engine.harness.conversation>[0], BACKGROUND_CONTEXT);
    // A reset drops active context, but must not drop any ledger totals.
    await conversation!.reset(undefined, BACKGROUND_CONTEXT);
    await engine.run(s, project, "again", () => {});
    assert.equal(engine.stats(s).usage?.totalTokens, 1515);
    assert.equal(engine.stats(s).context?.tokens, 500);
    const saved = engine.stats(s);
    await engine.close();
    store = new Store(temp.root);
    // Corrupt only the cached totals: restore must rebuild them from durable accounting.
    store.state.sessions[0]!.usage!.input = 9999;
    engine = await openEngine(store, undefined, (e) => errors.push(e), runtime);
    await engine.restore(() => {});
    const restored = store.state.sessions[0]!;
    assert.deepEqual(engine.stats(restored), saved);
    await engine.run(restored, project, "follow up", () => {});
    assert.equal(engine.stats(restored).usage?.totalTokens, 2015);
    await engine.configure({ model: { provider: "test", modelId: "reasoner" } }, restored);
    assert.equal(engine.stats(restored).contextWindow, 200_000);
    assert.notEqual(engine.stats(restored).contextWindow, saved.contextWindow);
    await engine.configure({ model: { provider: "test", modelId: "mock" } });
    assert.deepEqual(engine.stats(), { contextWindow: runtime.getModel("test", "mock")?.contextWindow },
      "New-task status uses defaults, never the selected session's context or spend");
    restored.agent!.model = { provider: "gone", modelId: "unknown" };
    assert.equal(engine.stats(restored).contextWindow, undefined);
    assert.equal(engine.stats(restored).usage?.totalTokens, 2015);
    assert.deepEqual(errors, []);
  } finally { await engine.close(); temp.cleanup(); }
});

test("provider failures and invalid title responses retain reported spend", async () => {
  const temp = temporary();
  const store = new Store(temp.root); const project = store.addProject(temp.root);
  const s = session(project, "failure usage"); store.state.sessions.push(s);
  const engine = await openEngine(store, { provider: "test", modelId: "mock" }, () => {}, models({ title: { fail: true } }));
  try {
    await engine.run(s, project, "fail", () => {});
    assert.equal(s.status, "failed");
    assert.equal(engine.stats(s).usage?.totalTokens, 4);
    assert.equal(engine.stats(s).titleUsage?.totalTokens, 2);
    assert.ok(engine.stats(s).context!.tokens > 0, "failed response is excluded; system and user input are estimated");
    await engine.run(s, project, "retry", () => {});
    assert.equal(engine.stats(s).usage?.totalTokens, 6);
  } finally { await engine.close(); temp.cleanup(); }
});

async function seedCompactableHistory(engine: DurableEngine, s: Session, project: Project) {
  // Enough actual text for the SDK to select a prefix while retaining ~20k recent tokens.
  for (const name of ["oldest", "middle", "recent"]) {
    await engine.run(s, project, `${name} detail `.repeat(6000), () => {});
  }
}

test("manual compaction uses the durable summarizer, retains audit history and spend, and restores the checkpoint", async () => {
  const temp = temporary(); const store = new Store(join(temp.root, "data")); const project = store.addProject(temp.root);
  const s = session(project, "compact"); store.state.sessions.push(s);
  const summaries: Context[] = []; const requests: Context[] = [];
  let engine = await openEngine(store, { provider: "test", modelId: "mock" }, (error) => assert.fail(String(error)),
    models({ context: (c) => requests.push(c), compaction: { context: (c) => summaries.push(c) } }));
  try {
    await assert.rejects(engine.compact(s, undefined, () => {}), /No conversation/);
    await seedCompactableHistory(engine, s, project);
    const id = s.conversationId!;
    const conversation = (await engine.harness.conversation(id as ConversationId, BACKGROUND_CONTEXT))!;
    const before = await conversation.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT);
    const spend = s.usage!.totalTokens;
    const tokens = JSON.stringify((await conversation.context(BACKGROUND_CONTEXT)).messages).length;
    const work = structuredClone(s.work);
    assert.equal(await engine.compact(s, "Keep pending tests and exact paths", () => {}), "compacted");
    assert.equal(s.conversationId, id);
    assert.deepEqual(s.work, work, "summarization is not a new agent run");
    assert.equal(s.status, "completed");
    assert.equal(s.compactions, undefined);
    assert.equal(s.compactionFailure, undefined);
    assert.equal(summaries.length, 1);
    assert.match(JSON.stringify(summaries[0]), /Keep pending tests and exact paths/);
    assert.equal(s.usage!.totalTokens, spend + 2);
    assert.ok(JSON.stringify((await conversation.context(BACKGROUND_CONTEXT)).messages).length < tokens);
    const card = s.messages.find((m) => m.tool?.name === "compact")!;
    assert.match(card.tool!.output, /Checkpoint:/);
    assert.equal(card.tool!.arguments.reason, "manual");
    assert.ok(!s.messages.some((m) => m.role === "user" && m.text.includes("<summary>")));
    const after = await conversation.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT);
    assert.equal(after.items.length, before.items.length + 1);
    assert.deepEqual(after.items.slice(0, before.items.length), before.items);
    await engine.run(s, project, "continue from checkpoint", () => {});
    assert.match(JSON.stringify(requests.at(-1)), /Checkpoint:/);
    assert.doesNotMatch(JSON.stringify(requests.at(-1)), /oldest detail/);
    const total = s.usage!.totalTokens;
    await engine.close();
    const restored = new Store(store.root);
    engine = await openEngine(restored, { provider: "test", modelId: "mock" }, (error) => assert.fail(String(error)), models());
    await engine.restore(() => {});
    const resumed = restored.state.sessions[0]!;
    assert.equal(resumed.usage!.totalTokens, total);
    assert.ok(resumed.messages.some((m) => m.tool?.name === "compact"));
    await engine.run(resumed, project, "continue", () => {});
    assert.equal(resumed.conversationId, id);
  } finally { await engine.close(); temp.cleanup(); }
});

test("short context compaction is a no-op without a summarization request", async () => {
  const temp = temporary(); const store = new Store(temp.root); const project = store.addProject(temp.root);
  const s = session(project, "short"); store.state.sessions.push(s);
  const engine = await openEngine(store, { provider: "test", modelId: "mock" }, (error) => assert.fail(String(error)),
    models({ compaction: { started: () => assert.fail("Nothing should be summarized") } }));
  try {
    await engine.run(s, project, "hello", () => {});
    const total = s.usage!.totalTokens;
    assert.equal(await engine.compact(s, undefined, () => {}), "unchanged");
    assert.equal(s.usage!.totalTokens, total);
    assert.equal(s.status, "completed");
  } finally { await engine.close(); temp.cleanup(); }
});

test("manual compaction deduplicates admission and can be cancelled without stopping an idle conversation", async () => {
  const temp = temporary(); const store = new Store(temp.root); const project = store.addProject(temp.root);
  const s = session(project, "cancel-compact"); store.state.sessions.push(s);
  let started!: () => void; const begin = new Promise<void>((resolve) => { started = resolve; });
  const engine = await openEngine(store, { provider: "test", modelId: "mock" }, (error) => assert.fail(String(error)),
    models({ compaction: { pause: true, started } }));
  try {
    await seedCompactableHistory(engine, s, project);
    const compacting = engine.compact(s, undefined, () => {});
    await begin;
    assert.equal(s.compactions?.[0]?.reason, "manual");
    await assert.rejects(engine.compact(s, undefined, () => {}), /already compacting/);
    await engine.cancel(s.id);
    assert.equal(await compacting, "aborted");
    assert.equal(s.compactions, undefined);
    assert.equal(s.stopped, undefined);
    assert.equal(s.status, "completed");
    await engine.run(s, project, "continue", () => {});
    assert.equal(s.status, "completed");
  } finally { await engine.close(); temp.cleanup(); }
});

test("failed manual compaction exposes its failure without corrupting context or resetting usage", async () => {
  const temp = temporary(); const store = new Store(temp.root); const project = store.addProject(temp.root);
  const s = session(project, "failed-compact"); store.state.sessions.push(s);
  const engine = await openEngine(store, { provider: "test", modelId: "mock" }, (error) => assert.fail(String(error)),
    models({ compaction: { fail: true } }));
  try {
    await seedCompactableHistory(engine, s, project);
    const messages = structuredClone(s.messages); const spend = s.usage!.totalTokens;
    await assert.rejects(engine.compact(s, undefined, () => {}), /Summary unavailable/);
    assert.deepEqual(s.messages, messages);
    assert.equal(s.status, "completed");
    assert.equal(s.usage!.totalTokens, spend + 2);
    assert.match(s.compactionFailure!.error, /Summary unavailable/);
    assert.match(s.preview, /Compaction failed/);
    await engine.run(s, project, "continue", () => {});
    assert.equal(s.status, "completed");
  } finally { await engine.close(); temp.cleanup(); }
});

for (const [input, blocking] of [[60_000, false], [90_000, true]] as const) {
  test(`automatic compaction uses the SDK's ${blocking ? "blocking" : "background"} threshold and surfaces activity`, async () => {
    const temp = temporary(); const store = new Store(temp.root); const project = store.addProject(temp.root);
    const s = session(project, `auto-${input}`); store.state.sessions.push(s);
    const usage: Usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const seen: boolean[] = []; let summaries = 0;
    const engine = await openEngine(store, { provider: "test", modelId: "mock" }, (error) => assert.fail(String(error)),
      models({ contextWindow: 100_000, usage, compaction: { started: () => {
        summaries++;
        for (const item of s.compactions ?? []) { assert.equal(item.reason, "threshold"); seen.push(item.blocking); }
      } } }));
    try {
      await seedCompactableHistory(engine, s, project);
      usage.input = input; usage.totalTokens = input + 1;
      await engine.run(s, project, "report usage", () => {});
      const spend = s.usage!.totalTokens;
      usage.input = 1; usage.totalTokens = 2;
      await engine.run(s, project, "continue", () => {});
      // Background tasks can outlive the answer; give their committed write time to land.
      for (let i = 0; i < 200 && !s.messages.some((m) => m.tool?.name === "compact"); i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(summaries, 1);
      assert.ok(seen.includes(blocking), `activity=${JSON.stringify(seen)}, expected blocking=${blocking}`);
      assert.equal(s.compactions, undefined);
      assert.equal(s.messages.find((m) => m.tool?.name === "compact")?.tool?.arguments.reason, "threshold");
      assert.equal(s.usage!.totalTokens, spend + 4);
      assert.equal(s.status, "completed");
    } finally { await engine.close(); temp.cleanup(); }
  });
}

test("closing during manual summarization checkpoints it and restore finishes it once", async () => {
  const temp = temporary(); const store = new Store(temp.root); const project = store.addProject(temp.root);
  const s = session(project, "recover-compact"); store.state.sessions.push(s);
  let started!: () => void; const begin = new Promise<void>((resolve) => { started = resolve; });
  let engine = await openEngine(store, { provider: "test", modelId: "mock" }, (error) => assert.fail(String(error)),
    models({ compaction: { pause: true, started } }));
  try {
    await seedCompactableHistory(engine, s, project);
    const spend = s.usage!.totalTokens;
    const pending = engine.compact(s, undefined, () => {});
    await begin;
    await engine.close();
    assert.equal(await pending, "aborted");
    const restored = new Store(temp.root);
    engine = await openEngine(restored, { provider: "test", modelId: "mock" }, (error) => assert.fail(String(error)), models());
    await engine.restore(() => {});
    await engine.harness.waitForIdle(BACKGROUND_CONTEXT);
    const resumed = restored.state.sessions[0]!;
    assert.equal(resumed.compactions, undefined);
    assert.equal(resumed.messages.filter((m) => m.tool?.name === "compact").length, 1);
    assert.equal(resumed.usage!.totalTokens, spend + 2);
  } finally { await engine.close(); temp.cleanup(); }
});

test("manual compaction during a run waits for summary placement without interrupting the response", async () => {
  const temp = temporary(); const store = new Store(temp.root); const project = store.addProject(temp.root);
  const s = session(project, "busy-compact"); store.state.sessions.push(s);
  let started!: () => void; const begin = new Promise<void>((resolve) => { started = resolve; });
  let finish!: () => void;
  const options = { pause: false, started: () => { if (options.pause) started(); }, finish: (done: () => void) => { finish = done; } };
  const engine = await openEngine(store, { provider: "test", modelId: "mock" }, (error) => assert.fail(String(error)), models(options));
  try {
    await seedCompactableHistory(engine, s, project);
    options.pause = true;
    const running = engine.run(s, project, "keep working", () => {});
    await begin;
    let applied = false;
    const compacting = engine.compact(s, undefined, () => {}).then((result) => { applied = true; return result; });
    // Let the summarization task finish while the response is still paused.
    let queued = false;
    for (let i = 0; i < 200; i++) {
      const inspection = await engine.harness.inspect(BACKGROUND_CONTEXT);
      if (inspection.submissions.some((item) => item.type === "write")) { queued = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(queued, "summarization should finish while the response is paused");
    assert.equal(applied, false, "a queued summary isn't applied yet");
    assert.equal(s.status, "working");
    assert.equal(s.stopped, undefined);
    finish();
    await running;
    assert.equal(await compacting, "compacted");
    assert.equal(s.status, "completed");
    assert.equal(s.messages.at(-1)?.text, "Recovered answer");
    assert.ok(s.messages.some((m) => m.tool?.name === "compact"));
  } finally { await engine.close(); temp.cleanup(); }
});

test("provider context overflow uses durable compaction and retries the response once", async () => {
  const temp = temporary(); const store = new Store(temp.root); const project = store.addProject(temp.root);
  const s = session(project, "overflow-compact"); store.state.sessions.push(s);
  const options = { overflow: false, context: (_c: Context) => { requests++; } };
  let requests = 0;
  const engine = await openEngine(store, { provider: "test", modelId: "mock" }, (error) => assert.fail(String(error)), models(options));
  try {
    await seedCompactableHistory(engine, s, project);
    const spend = s.usage!.totalTokens; const count = requests;
    options.overflow = true;
    await engine.run(s, project, "continue", () => {});
    assert.equal(requests, count + 2);
    assert.equal(s.status, "completed");
    assert.equal(s.messages.find((m) => m.tool?.name === "compact")?.tool?.arguments.reason, "overflow");
    assert.equal(s.usage!.totalTokens, spend + 6);
    assert.equal(s.messages.at(-1)?.text, "Recovered answer");
  } finally { await engine.close(); temp.cleanup(); }
});

test("failed blocking auto-compaction fails the run without sending an oversized response request", async () => {
  const temp = temporary(); const store = new Store(temp.root); const project = store.addProject(temp.root);
  const s = session(project, "auto-failure"); store.state.sessions.push(s);
  const usage: Usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  let requests = 0;
  const engine = await openEngine(store, { provider: "test", modelId: "mock" }, (error) => assert.fail(String(error)),
    models({ contextWindow: 100_000, usage, context: () => { requests++; }, compaction: { fail: true } }));
  try {
    await seedCompactableHistory(engine, s, project);
    usage.input = 90_000; usage.totalTokens = 90_001;
    await engine.run(s, project, "report usage", () => {});
    const count = requests; const spend = s.usage!.totalTokens;
    await engine.run(s, project, "continue", () => {});
    assert.equal(requests, count);
    assert.equal(s.status, "failed");
    assert.match(s.messages.at(-1)!.text, /Summary unavailable/);
    assert.equal(s.compactionFailure?.reason, "threshold");
    assert.equal(s.usage!.totalTokens, spend + 2);
  } finally { await engine.close(); temp.cleanup(); }
});

test("rapid replies use the native durable inbox and run one at a time after each answer", { timeout: 5000 }, async () => {
  const temp = temporary();
  const store = new Store(temp.root); const project = store.addProject(temp.root);
  const s = session(project, "queue"); store.state.sessions.push(s);
  const finish: (() => void)[] = [];
  const contexts: Context[] = [];
  const engine = await openEngine(store, { provider: "test", modelId: "mock" }, (error) => assert.fail(String(error)), models({
    pause: true, finish: (done) => finish.push(done), context: (context) => contexts.push(context),
  }));
  try {
    // These arrive before authentication, skill preparation or conversation creation has completed.
    const runs = ["initial", "then raise a PR", "then raise a PR"].map((prompt) => engine.run(s, project, prompt, () => {}));
    await until(() => s.queuedInputs?.length === 2 && finish.length === 1);
    const id = s.conversationId;
    const startedAt = s.work!.startedAt;
    const inbox = await engine.harness.snapshot(InboxDoc, id as ConversationId, BACKGROUND_CONTEXT);
    assert.equal(inbox?.items.length, 2, "follow-ups must be admitted while the first request is still running");
    assert.deepEqual(s.queuedInputs?.map((input) => input.text), ["then raise a PR", "then raise a PR"]);
    assert.notEqual(s.queuedInputs?.[0]?.id, s.queuedInputs?.[1]?.id);
    assert.deepEqual(s.messages.filter((m) => m.role === "user").map((m) => m.text), ["initial"]);
    assert.equal(s.work?.finishedAt, undefined);
    finish[0]!();
    await until(() => finish.length === 2 && s.queuedInputs?.length === 1);
    assert.equal(s.status, "working"); assert.equal(s.work?.finishedAt, undefined);
    assert.equal(s.work?.startedAt, startedAt);
    await assert.rejects(engine.configure({ model: { provider: "test", modelId: "reasoner" } }, s), /finish first/);
    finish[1]!();
    await until(() => finish.length === 3 && !s.queuedInputs?.length);
    assert.equal(s.status, "working"); assert.equal(s.work?.finishedAt, undefined);
    finish[2]!(); await Promise.all(runs);
    assert.equal(s.conversationId, id); assert.equal(s.status, "completed");
    assert.ok(s.work?.finishedAt); assert.equal(s.pendingInput, undefined); assert.equal(s.followUps, undefined);
    assert.deepEqual(s.messages.map((m) => m.role), ["user", "assistant", "user", "assistant", "user", "assistant"]);
    assert.equal(contexts.length, 3);
    assert.deepEqual(contexts.map((context) => context.messages.filter((m) => m.role === "user").length), [1, 2, 3]);
  } finally { await engine.close(); temp.cleanup(); }
});

test("queued replies and expanded skills survive restart without duplicate admissions", { timeout: 5000 }, async () => {
  const temp = temporary();
  const store = new Store(temp.root); const project = store.addProject(temp.root);
  const s = session(project, "queue-restart"); store.state.sessions.push(s);
  const dir = join(temp.root, "skill"); mkdirSync(dir);
  const file = join(dir, "SKILL.md");
  writeFileSync(file, "---\nname: fixture\ndescription: Summarize\n---\n\nQUEUED_SAVED_INSTRUCTIONS\n");
  const skills = new SkillCatalog(async () => loadSkillsFromDir({ dir, source: "path" }));
  let engine = await openEngine(store, { provider: "test", modelId: "mock" }, () => {}, models({ pause: true }), "off", skills);
  try {
    const runs = ["initial", "/skill:fixture summarize", "last reply"].map((prompt) => engine.run(s, project, prompt, () => {}));
    await until(() => s.queuedInputs?.length === 2);
    assert.equal(s.queuedInputs?.[0]?.text, "/skill:fixture summarize", "show the user's prompt, not the expanded skill body");
    await engine.close(); await Promise.all(runs);
    assert.ok(s.pendingInput); assert.equal(s.followUps?.length, 2);
    // Simulate an index checkpoint predating the queue's admission. Request IDs must deduplicate it.
    delete s.followUps![1]!.prepared; store.save();
    unlinkSync(file);
    const restored = new Store(temp.root);
    const contexts: Context[] = [];
    engine = await openEngine(restored, undefined, (error) => assert.fail(String(error)), models({ context: (context) => contexts.push(context) }));
    await engine.restore(() => {});
    const recovered = restored.state.sessions[0]!;
    await until(() => !recovered.pendingInput && !recovered.followUps?.length && recovered.status === "completed");
    assert.deepEqual(recovered.messages.filter((m) => m.role === "user").map((m) => m.text), ["initial", "/skill:fixture summarize", "last reply"]);
    assert.equal(recovered.queuedInputs, undefined);
    assert.match(JSON.stringify(contexts), /QUEUED_SAVED_INSTRUCTIONS/);
    assert.match(recovered.messages.find((m) => m.tool?.name === "load_skill")!.tool!.output, /QUEUED_SAVED_INSTRUCTIONS/);
  } finally { await engine.close(); temp.cleanup(); }
});

test("stopping withdraws all queued inputs and restart never runs them", { timeout: 5000 }, async () => {
  const temp = temporary();
  let store = new Store(temp.root); const project = store.addProject(temp.root);
  const s = session(project, "queue-stop"); store.state.sessions.push(s);
  let engine = await openEngine(store, { provider: "test", modelId: "mock" }, () => {}, models({ pause: true }));
  try {
    const runs = ["initial", "queued one", "queued two"].map((prompt) => engine.run(s, project, prompt, () => {}));
    await until(() => s.queuedInputs?.length === 2);
    await engine.cancel(s.id); await Promise.all(runs);
    assert.equal(s.status, "paused"); assert.equal(s.pendingInput, undefined); assert.equal(s.followUps, undefined);
    assert.equal(s.queuedInputs, undefined);
    await engine.close();
    store = new Store(temp.root);
    const contexts: Context[] = [];
    engine = await openEngine(store, undefined, () => {}, models({ context: (context) => contexts.push(context) }));
    await engine.restore(() => {}); await engine.harness.waitForIdle(BACKGROUND_CONTEXT);
    assert.equal(contexts.length, 0);
    const recovered = store.state.sessions[0]!;
    await engine.run(recovered, project, "continue", () => {});
    assert.deepEqual(recovered.messages.filter((m) => m.role === "user").map((m) => m.text), ["initial", "continue"]);
    assert.equal(recovered.status, "completed");
  } finally { await engine.close(); temp.cleanup(); }
});

test("cancelling during follow-up preparation prevents late admission", { timeout: 5000 }, async () => {
  const temp = temporary();
  const store = new Store(temp.root); const project = store.addProject(temp.root);
  const s = session(project, "queue-preparing"); store.state.sessions.push(s);
  let release!: () => void;
  const preparing = new Promise<void>((resolve) => { release = resolve; });
  const skills = new SkillCatalog(async () => ({ skills: [], diagnostics: [] }));
  const prepare = skills.prepare.bind(skills);
  skills.prepare = async (cwd, prompt) => { if (prompt === "queued") await preparing; return prepare(cwd, prompt); };
  const engine = await openEngine(store, { provider: "test", modelId: "mock" }, () => {}, models({ pause: true }), "off", skills);
  try {
    const running = engine.run(s, project, "initial", () => {});
    await until(() => s.messages.some((m) => m.role === "user"));
    const queued = engine.run(s, project, "queued", () => {});
    const stopping = engine.cancel(s.id);
    release(); await stopping; await Promise.all([running, queued]);
    assert.equal(s.status, "paused"); assert.equal(s.pendingInput, undefined); assert.equal(s.followUps, undefined);
    assert.deepEqual(s.messages.filter((m) => m.role === "user").map((m) => m.text), ["initial"]);
  } finally { release(); await engine.close(); temp.cleanup(); }
});

test("a failed run retains its native queue and the next reply resumes it oldest first", { timeout: 5000 }, async () => {
  const temp = temporary();
  const store = new Store(temp.root); const project = store.addProject(temp.root);
  const s = session(project, "queue-failure"); store.state.sessions.push(s);
  let finish!: (failure?: string) => void;
  const options = { pause: true, finish: (done: (failure?: string) => void) => { finish = done; } };
  const engine = await openEngine(store, { provider: "test", modelId: "mock" }, () => {}, models(options));
  try {
    const running = engine.run(s, project, "initial", () => {});
    const queued = engine.run(s, project, "queued reply", () => {});
    await until(() => s.queuedInputs?.length === 1 && !!finish);
    finish("Simulated provider failure"); await running;
    assert.equal(s.status, "failed"); assert.equal(s.queuedInputs?.length, 1);
    options.pause = false;
    const retry = engine.run(s, project, "resume", () => {});
    await Promise.all([queued, retry]);
    assert.equal(s.status, "completed"); assert.equal(s.pendingInput, undefined);
    assert.deepEqual(s.messages.filter((m) => m.role === "user").map((m) => m.text), ["initial", "queued reply", "resume"]);
  } finally { await engine.close(); temp.cleanup(); }
});

test("an invalid queued skill reports the error without failing or dropping the live request", { timeout: 5000 }, async () => {
  const temp = temporary();
  const store = new Store(temp.root); const project = store.addProject(temp.root);
  const s = session(project, "queue-invalid"); store.state.sessions.push(s);
  let finish!: () => void;
  const errors: unknown[] = [];
  const engine = await openEngine(store, { provider: "test", modelId: "mock" }, (error) => errors.push(error), models({ pause: true, finish: (done) => { finish = done; } }));
  try {
    const running = engine.run(s, project, "initial", () => {});
    await until(() => !!finish);
    await engine.run(s, project, "/skill:missing", () => {});
    assert.equal(s.status, "working"); assert.equal(s.followUps, undefined);
    assert.match(String(errors[0]), /Unknown skill missing/);
    finish(); await running;
    assert.equal(s.status, "completed"); assert.equal(s.pendingInput, undefined);
  } finally { await engine.close(); temp.cleanup(); }
});

test("replies checkpointed before conversation creation are admitted in order on reopen", { timeout: 5000 }, async () => {
  const temp = temporary();
  const store = new Store(temp.root); const project = store.addProject(temp.root);
  const s = session(project, "queue-before-create"); store.state.sessions.push(s);
  let engine = await openEngine(store, { provider: "test", modelId: "mock" }, () => {}, models());
  try {
    const runs = ["initial", "second", "third"].map((prompt) => engine.run(s, project, prompt, () => {}));
    // Closing synchronously seals admission before the first preparation microtask.
    await engine.close(); await Promise.all(runs);
    assert.equal(s.conversationId, undefined);
    assert.equal(s.followUps?.length, 2);
    const restored = new Store(temp.root);
    engine = await openEngine(restored, { provider: "test", modelId: "mock" }, (error) => assert.fail(String(error)), models());
    await engine.restore(() => {});
    const recovered = restored.state.sessions[0]!;
    await until(() => !recovered.pendingInput && recovered.status === "completed");
    assert.deepEqual(recovered.messages.filter((m) => m.role === "user").map((m) => m.text), ["initial", "second", "third"]);
    assert.equal(recovered.followUps, undefined); assert.equal(recovered.queuedInputs, undefined);
  } finally { await engine.close(); temp.cleanup(); }
});

test("configured steering joins the live run at a tool boundary ahead of queued follow-ups", { timeout: 5000 }, async () => {
  const temp = temporary();
  const store = new Store(temp.root); const project = store.addProject(temp.root);
  writeFileSync(join(temp.root, "marker.txt"), "marker");
  const s = session(project, "steering"); store.state.sessions.push(s);
  const contexts: Context[] = [];
  const finish: ((failure?: string, content?: (TextContent | ThinkingContent | ToolCall)[]) => void)[] = [];
  const engine = await openEngine(store, { provider: "test", modelId: "mock" }, (error) => assert.fail(String(error)), models({
    pause: true, finish: (done) => finish.push(done), context: (context) => contexts.push(context),
  }));
  try {
    let initialSettled = false;
    const running = engine.run(s, project, "initial", () => {}).then(() => { initialSettled = true; });
    await until(() => finish.length === 1);
    const followUp = engine.run(s, project, "do this later", () => {});
    await until(() => s.queuedInputs?.length === 1);
    store.state.settings = { replyBehavior: "steer" }; store.save();
    const steering = engine.run(s, project, "change course", () => {});
    await until(() => s.queuedInputs?.length === 2);
    assert.deepEqual(s.queuedInputs?.map((input) => input.mode), ["followUp", "steer"]);
    assert.equal(s.pendingInput?.whenBusy, "followUp");
    assert.deepEqual(s.followUps?.map((input) => input.whenBusy), ["followUp", "steer"]);
    // The current response requests a real tool, not a final answer.
    finish[0]!(undefined, [{ type: "toolCall", id: "steer-boundary", name: "read", arguments: { path: "marker.txt" } }]);
    await until(() => finish.length === 2);
    assert.equal(initialSettled, false, "steering must join the current run rather than waiting for its answer");
    assert.deepEqual(s.queuedInputs?.map((input) => input.text), ["do this later"]);
    assert.equal(contexts[1]?.messages.at(-1)?.content, "change course");
    assert.ok(contexts[1]?.messages.some((message) => message.role === "toolResult"));
    assert.deepEqual(s.messages.filter((message) => message.role === "user").map((message) => message.text), ["initial", "change course"]);
    finish[1]!(); await until(() => finish.length === 3);
    finish[2]!(); await Promise.all([running, followUp, steering]);
    assert.equal(s.status, "completed"); assert.equal(s.pendingInput, undefined); assert.equal(s.followUps, undefined);
    assert.deepEqual(s.messages.filter((message) => message.role === "user").map((message) => message.text), ["initial", "change course", "do this later"]);
  } finally { await engine.close(); temp.cleanup(); }
});

test("delivery mode is captured before preparation and retained across settings changes and restart", { timeout: 5000 }, async () => {
  const temp = temporary();
  let store = new Store(temp.root); const project = store.addProject(temp.root);
  const s = session(project, "saved-mode"); store.state.sessions.push(s);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const skills = new SkillCatalog(async () => ({ skills: [], diagnostics: [] }));
  const prepare = skills.prepare.bind(skills);
  skills.prepare = async (cwd, prompt) => { if (prompt === "correction") await blocked; return prepare(cwd, prompt); };
  let started = false;
  let engine = await openEngine(store, { provider: "test", modelId: "mock" }, () => {}, models({ pause: true, started: () => { started = true; } }), "off", skills);
  try {
    const running = engine.run(s, project, "initial", () => {});
    await until(() => started);
    store.state.settings = { replyBehavior: "steer" };
    const steering = engine.run(s, project, "correction", () => {});
    store.state.settings = { replyBehavior: "followUp" }; store.save();
    assert.equal(s.followUps?.[0]?.whenBusy, "steer");
    release(); await until(() => s.queuedInputs?.length === 1);
    assert.equal(s.queuedInputs?.[0]?.mode, "steer");
    await engine.close(); await Promise.all([running, steering]);
    store = new Store(temp.root);
    assert.equal(store.settings.replyBehavior, "followUp");
    started = false;
    engine = await openEngine(store, undefined, () => {}, models({ pause: true, started: () => { started = true; } }));
    await engine.restore(() => {});
    const recovered = store.state.sessions[0]!;
    await until(() => started);
    assert.equal(recovered.queuedInputs?.[0]?.mode, "steer");
    assert.equal(recovered.followUps?.[0]?.whenBusy, "steer");
    const inbox = await engine.harness.snapshot(InboxDoc, recovered.conversationId as ConversationId, BACKGROUND_CONTEXT);
    assert.equal(inbox?.items.length, 1); assert.equal(inbox?.items[0]?.mode, "steer");
    await engine.cancel(recovered.id);
  } finally { release(); await engine.close(); temp.cleanup(); }
});

function toolPrompt(...calls: ToolCall[]): string { return `tools:${JSON.stringify(calls)}`; }
function writeCall(path: string, content: string): ToolCall {
  return { type: "toolCall", id: `write-${path}`, name: "write", arguments: { path, content } };
}
function undoModels() {
  return models({ reply: (context) => {
    const last = context.messages.at(-1);
    return last?.role === "user" && typeof last.content === "string" && last.content.startsWith("tools:")
      ? JSON.parse(last.content.slice(6)) as ToolCall[] : [{ type: "text", text: "Done" }];
  } });
}
async function undoFixture(runtime = undoModels()) {
  const temp = temporary();
  const work = join(temp.root, "work"); mkdirSync(work);
  const store = new Store(join(temp.root, "data"));
  const project = store.addProject(work);
  const s = session(project, "undo-session"); store.state.sessions.push(s);
  const errors: unknown[] = [];
  const engine = await openEngine(store, { provider: "test", modelId: "mock" }, (error) => errors.push(error), runtime);
  return { ...temp, work, store, project, s, errors, engine };
}

async function undoLatest(engine: DurableEngine, s: Session) {
  const points = await engine.undoCheckpoints(s);
  return engine.undo(s, points[0]?.id ?? "missing", () => {});
}

test("undo persists file backups, rewinds conversation, preserves spend, and supports repeated undo after restart", async () => {
  const f = await undoFixture(); let engine = f.engine;
  try {
    const path = join(f.work, "existing.txt");
    writeFileSync(path, "local uncommitted work\r\n"); chmodSync(path, 0o755);
    const first = toolPrompt(writeCall("existing.txt", "first\r\n"), writeCall("created.txt", "new file"));
    await engine.run(f.s, f.project, first, () => {});
    assert.equal(readFileSync(path, "utf8"), "first\r\n");
    assert.equal(f.s.messages.find((m) => m.tool?.name === "write")?.tool?.status, "done");
    const firstId = f.s.conversationId;
    const second = toolPrompt({ type: "toolCall", id: "edit-existing", name: "edit",
      arguments: { path: "existing.txt", edits: [{ oldText: "first", newText: "second" }] } });
    await engine.run(f.s, f.project, second, () => {});
    assert.equal(readFileSync(path, "utf8"), "second\r\n");
    const spent = structuredClone(f.s.usage);
    await engine.close();
    const store = new Store(f.store.root);
    engine = await openEngine(store, { provider: "test", modelId: "mock" }, (error) => f.errors.push(error), undoModels());
    await engine.restore(() => {});
    const s = store.state.sessions[0]!;
    assert.deepEqual(await undoLatest(engine, s), { prompt: second, files: 1, shell: false });
    assert.equal(readFileSync(path, "utf8"), "first\r\n");
    assert.notEqual(s.conversationId, firstId);
    assert.deepEqual(s.messages.filter((m) => m.role === "user").map((m) => m.text), [first]);
    assert.deepEqual(s.usage, spent, "discarded turns still cost money");
    assert.equal(existsSync(join(f.work, "created.txt")), true);
    // Simulate a stale UI index saved before the fork. Durable ownership must win.
    s.conversationId = firstId; store.save();
    await engine.close();
    const restored = new Store(store.root);
    engine = await openEngine(restored, { provider: "test", modelId: "mock" }, (error) => f.errors.push(error), undoModels());
    await engine.restore(() => {});
    const again = restored.state.sessions[0]!;
    assert.notEqual(again.conversationId, firstId);
    assert.deepEqual(again.usage, spent);
    assert.deepEqual(await undoLatest(engine, again), { prompt: first, files: 2, shell: false });
    assert.equal(readFileSync(path, "utf8"), "local uncommitted work\r\n");
    assert.equal(statSync(path).mode & 0o777, 0o755);
    assert.equal(existsSync(join(f.work, "created.txt")), false);
    assert.equal(again.messages.length, 0);
    assert.deepEqual(again.usage, spent);
    await assert.rejects(undoLatest(engine, again), /No undo checkpoint/);
    await engine.run(again, f.project, "A different approach", () => {});
    assert.deepEqual(again.messages.filter((m) => m.role === "user").map((m) => m.text), ["A different approach"]);
    assert.deepEqual(f.errors, []);
  } finally { await engine.close(); f.cleanup(); }
});

test("undo preflights every file and refuses external changes without rewinding or partially restoring", async () => {
  const f = await undoFixture();
  try {
    writeFileSync(join(f.work, "a.txt"), "before a"); writeFileSync(join(f.work, "b.txt"), "before b");
    await f.engine.run(f.s, f.project, toolPrompt(writeCall("a.txt", "after a"), writeCall("b.txt", "after b")), () => {});
    const id = f.s.conversationId; const messages = structuredClone(f.s.messages);
    writeFileSync(join(f.work, "b.txt"), "manual edit");
    await assert.rejects(undoLatest(f.engine, f.s), /file changed since the agent edited it/);
    assert.equal(readFileSync(join(f.work, "a.txt"), "utf8"), "after a");
    assert.equal(readFileSync(join(f.work, "b.txt"), "utf8"), "manual edit");
    assert.equal(f.s.conversationId, id); assert.deepEqual(f.s.messages, messages);
    writeFileSync(join(f.work, "b.txt"), "after b");
    await undoLatest(f.engine, f.s);
    assert.equal(readFileSync(join(f.work, "a.txt"), "utf8"), "before a");
    assert.equal(readFileSync(join(f.work, "b.txt"), "utf8"), "before b");
  } finally { await f.engine.close(); f.cleanup(); }
});

test("undo rejects symlinks, hard links, and swapped parent directories", async () => {
  for (const kind of ["symlink", "hardlink", "parent"] as const) {
    const f = await undoFixture();
    try {
      mkdirSync(join(f.work, "dir"));
      const path = join(f.work, "dir", "a.txt"); writeFileSync(path, "before");
      await f.engine.run(f.s, f.project, toolPrompt(writeCall("dir/a.txt", "after")), () => {});
      const outside = join(f.work, "outside.txt"); writeFileSync(outside, "outside");
      if (kind === "parent") {
        renameSync(join(f.work, "dir"), join(f.work, "original-dir"));
        mkdirSync(join(f.work, "replacement")); writeFileSync(join(f.work, "replacement", "a.txt"), "after");
        symlinkSync(join(f.work, "replacement"), join(f.work, "dir"));
      } else {
        unlinkSync(path);
        if (kind === "symlink") symlinkSync(outside, path); else linkSync(outside, path);
      }
      await assert.rejects(undoLatest(f.engine, f.s), /linked or non-regular/);
      assert.equal(readFileSync(outside, "utf8"), "outside");
      assert.equal(f.s.messages.filter((m) => m.role === "user").length, 1);
    } finally { await f.engine.close(); f.cleanup(); }
  }
});

test("undo recovery finishes an interrupted file restore and conversation fork on restart", async () => {
  const f = await undoFixture(); let engine = f.engine;
  try {
    writeFileSync(join(f.work, "a.txt"), "before");
    await engine.run(f.s, f.project, toolPrompt(writeCall("a.txt", "after"), writeCall("new.txt", "new")), () => {});
    const id = f.s.conversationId as ConversationId;
    const state = await engine.harness.snapshot(UndoDoc, id, BACKGROUND_CONTEXT);
    await engine.harness.commit(async (tx) => { (await tx.doc(UndoDoc, id)).restoring = true; }, BACKGROUND_CONTEXT);
    // Simulate a crash after only one of the files has been restored.
    writeFileSync(join(f.work, "a.txt"), "before");
    assert.ok(state?.points.length);
    await engine.close();
    const store = new Store(f.store.root);
    engine = await openEngine(store, { provider: "test", modelId: "mock" }, (error) => f.errors.push(error), undoModels());
    await engine.restore(() => {});
    const s = store.state.sessions[0]!;
    assert.equal(readFileSync(join(f.work, "a.txt"), "utf8"), "before");
    assert.equal(existsSync(join(f.work, "new.txt")), false);
    assert.notEqual(s.conversationId, id);
    assert.deepEqual(s.messages, []);
    assert.deepEqual(f.errors, []);
  } finally { await engine.close(); f.cleanup(); }
});

test("queued follow-up turns get separate undo checkpoints", async () => {
  const f = await undoFixture();
  try {
    writeFileSync(join(f.work, "a.txt"), "before");
    await Promise.all([
      f.engine.run(f.s, f.project, toolPrompt(writeCall("a.txt", "first")), () => {}),
      f.engine.run(f.s, f.project, toolPrompt(writeCall("a.txt", "second")), () => {}),
    ]);
    assert.equal(readFileSync(join(f.work, "a.txt"), "utf8"), "second");
    await undoLatest(f.engine, f.s);
    assert.equal(readFileSync(join(f.work, "a.txt"), "utf8"), "first");
    assert.equal(f.s.messages.filter((m) => m.role === "user").length, 1);
    await undoLatest(f.engine, f.s);
    assert.equal(readFileSync(join(f.work, "a.txt"), "utf8"), "before");
    assert.deepEqual(f.errors, []);
  } finally { await f.engine.close(); f.cleanup(); }
});

test("undo rewinds a shell turn's conversation but reports shell effects as not restored", async () => {
  const f = await undoFixture();
  try {
    await f.engine.run(f.s, f.project, toolPrompt({ type: "toolCall", id: "shell", name: "bash",
      arguments: { command: "printf 'shell effect' > shell.txt" } }), () => {});
    const result = await undoLatest(f.engine, f.s);
    assert.equal(result.shell, true); assert.equal(result.files, 0);
    assert.deepEqual(f.s.messages, []);
    assert.equal(readFileSync(join(f.work, "shell.txt"), "utf8"), "shell effect");
  } finally { await f.engine.close(); f.cleanup(); }
});

test("steering messages share the original turn's undo checkpoint", async () => {
  const finishes: ((failure?: string, content?: (TextContent | ThinkingContent | ToolCall)[]) => void)[] = [];
  const f = await undoFixture(models({ pause: true, finish: (done) => finishes.push(done) }));
  try {
    f.store.state.settings = { replyBehavior: "steer" };
    writeFileSync(join(f.work, "a.txt"), "before");
    const first = f.engine.run(f.s, f.project, "initial prompt", () => {});
    await until(() => finishes.length === 1);
    const steer = f.engine.run(f.s, f.project, "adjust the approach", () => {});
    await until(() => !!f.s.queuedInputs?.length);
    finishes[0]!(undefined, [writeCall("a.txt", "first")]);
    await until(() => finishes.length === 2);
    finishes[1]!(undefined, [writeCall("a.txt", "second")]);
    await until(() => finishes.length === 3);
    finishes[2]!(undefined, [{ type: "text", text: "Done" }]);
    await Promise.all([first, steer]);
    assert.equal(readFileSync(join(f.work, "a.txt"), "utf8"), "second");
    const points = await f.engine.harness.snapshot(UndoDoc, f.s.conversationId as ConversationId, BACKGROUND_CONTEXT);
    assert.equal(points?.points.length, 1);
    const result = await undoLatest(f.engine, f.s);
    assert.equal(result.prompt, "initial prompt");
    assert.equal(readFileSync(join(f.work, "a.txt"), "utf8"), "before");
    assert.equal(f.s.messages.length, 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.engine.close(); f.cleanup(); }
});

test("undo refuses a running project and works after stopping the turn", async () => {
  const f = await undoFixture();
  try {
    await f.engine.run(f.s, f.project, "Earlier turn", () => {});
    const running = f.engine.run(f.s, f.project, toolPrompt({ type: "toolCall", id: "shell", name: "bash",
      arguments: { command: "printf 'UNDO_BUSY_TEST\n'; sleep 30" } }), () => {});
    await until(() => f.s.messages.some((message) => message.tool?.output.includes("UNDO_BUSY_TEST")));
    await assert.rejects(undoLatest(f.engine, f.s), /Wait for this project's sessions/);
    await f.engine.cancel(f.s.id); await running;
    const result = await undoLatest(f.engine, f.s);
    assert.equal(result.shell, true);
    assert.equal(f.s.stopped, undefined);
    assert.deepEqual(f.s.messages.filter((m) => m.role === "user").map((m) => m.text), ["Earlier turn"]);
  } finally { await f.engine.close(); f.cleanup(); }
});

test("an interrupted undo blocks new work, survives a recovery conflict, and can be retried safely", async () => {
  const f = await undoFixture(); let engine = f.engine;
  try {
    const path = join(f.work, "a.txt"); writeFileSync(path, "before");
    await engine.run(f.s, f.project, toolPrompt(writeCall("a.txt", "after")), () => {});
    const original = engine.undoHistory.restore.bind(engine.undoHistory);
    engine.undoHistory.restore = () => { throw new Error("Simulated I/O failure"); };
    await assert.rejects(undoLatest(engine, f.s), /Simulated I\/O failure/);
    await assert.rejects(engine.run(f.s, f.project, "must not run", () => {}), /interrupted \/undo/);
    engine.undoHistory.restore = original;
    writeFileSync(path, "external edit during outage");
    await engine.close();
    const store = new Store(f.store.root);
    engine = await openEngine(store, { provider: "test", modelId: "mock" }, (error) => f.errors.push(error), undoModels());
    await engine.restore(() => {});
    const s = store.state.sessions[0]!;
    assert.equal(s.status, "failed"); assert.match(s.preview, /Interrupted \/undo could not finish/);
    await assert.rejects(engine.run(s, f.project, "still must not run", () => {}), /interrupted \/undo/);
    assert.equal(readFileSync(path, "utf8"), "external edit during outage");
    writeFileSync(path, "after");
    await undoLatest(engine, s);
    assert.equal(readFileSync(path, "utf8"), "before");
    await engine.run(s, f.project, "now safe", () => {});
    assert.equal(s.messages.filter((m) => m.role === "user").length, 1);
    assert.deepEqual(f.errors, []);
  } finally { await engine.close(); f.cleanup(); }
});

test("selecting an older checkpoint restores the whole suffix, merges repeated file edits, and retains earlier turns", async () => {
  const f = await undoFixture();
  try {
    const shared = join(f.work, "shared.txt"); writeFileSync(shared, "original");
    const earlierOnly = join(f.work, "earlier.txt"); writeFileSync(earlierOnly, "keep this local work");
    const first = toolPrompt(writeCall("shared.txt", "first"));
    const middle = toolPrompt(writeCall("shared.txt", "second"), writeCall("earlier.txt", "changed"));
    const latest = toolPrompt(writeCall("shared.txt", "third"), writeCall("new.txt", "new"));
    for (const prompt of [first, middle, latest]) await f.engine.run(f.s, f.project, prompt, () => {});
    const spent = structuredClone(f.s.usage);
    const originalId = f.s.conversationId;
    const choices = await f.engine.undoCheckpoints(f.s);
    assert.deepEqual(choices.map((point) => [point.turn, point.turns, point.files, point.prompt]), [
      [3, 1, 2, latest], [2, 2, 3, middle], [1, 3, 3, first],
    ]);
    assert.ok(choices.every((point) => Number.isFinite(point.timestamp)));
    assert.equal(f.s.conversationId, originalId, "listing checkpoints must be read-only");
    assert.equal(readFileSync(shared, "utf8"), "third");
    await assert.rejects(f.engine.undo(f.s, "missing-or-stale-id", () => {}), /No undo checkpoint/);
    assert.equal(f.s.conversationId, originalId, "invalid IDs must not fall back to the latest checkpoint");
    const result = await f.engine.undo(f.s, choices[1]!.id, () => {});
    assert.deepEqual(result, { prompt: middle, files: 3, shell: false });
    assert.equal(readFileSync(shared, "utf8"), "first");
    assert.equal(readFileSync(earlierOnly, "utf8"), "keep this local work");
    assert.equal(existsSync(join(f.work, "new.txt")), false);
    assert.deepEqual(f.s.messages.filter((m) => m.role === "user").map((m) => m.text), [first]);
    assert.deepEqual(f.s.usage, spent);
    const remaining = await f.engine.undoCheckpoints(f.s);
    assert.deepEqual(remaining.map((point) => point.id), [choices[2]!.id]);
    await assert.rejects(f.engine.undo(f.s, choices[0]!.id, () => {}), /No undo checkpoint/);
    assert.equal(readFileSync(shared, "utf8"), "first");
    assert.deepEqual(f.errors, []);
  } finally { await f.engine.close(); f.cleanup(); }
});

test("an older checkpoint preflights the full suffix and refuses manual changes between turns", async () => {
  const f = await undoFixture();
  try {
    const path = join(f.work, "a.txt"); writeFileSync(path, "before");
    await f.engine.run(f.s, f.project, toolPrompt(writeCall("a.txt", "first")), () => {});
    writeFileSync(path, "manual work between turns");
    await f.engine.run(f.s, f.project, toolPrompt(writeCall("a.txt", "second"), writeCall("new.txt", "new")), () => {});
    const choices = await f.engine.undoCheckpoints(f.s);
    const id = f.s.conversationId;
    await assert.rejects(f.engine.undo(f.s, choices[1]!.id, () => {}), /file changed between checkpoints/);
    assert.equal(readFileSync(path, "utf8"), "second");
    assert.equal(readFileSync(join(f.work, "new.txt"), "utf8"), "new", "do not partially rewind newer turns");
    assert.equal(f.s.conversationId, id);
    const state = await f.engine.harness.snapshot(UndoDoc, id as ConversationId, BACKGROUND_CONTEXT);
    assert.equal(state?.restoring, undefined);
    await f.engine.undo(f.s, choices[0]!.id, () => {});
    assert.equal(readFileSync(path, "utf8"), "manual work between turns");
    assert.equal(existsSync(join(f.work, "new.txt")), false);
    await assert.rejects(f.engine.undo(f.s, choices[1]!.id, () => {}), /file changed since the agent edited it/);
    assert.equal(readFileSync(path, "utf8"), "manual work between turns");
  } finally { await f.engine.close(); f.cleanup(); }
});

test("crash recovery resumes the selected older checkpoint, not the latest, and cannot be retargeted midway", async () => {
  const f = await undoFixture(); let engine = f.engine;
  try {
    const path = join(f.work, "a.txt"); writeFileSync(path, "before");
    const first = toolPrompt(writeCall("a.txt", "first"));
    const middle = toolPrompt(writeCall("a.txt", "second"));
    const latest = toolPrompt(writeCall("a.txt", "third"), writeCall("new.txt", "new"));
    for (const prompt of [first, middle, latest]) await engine.run(f.s, f.project, prompt, () => {});
    const choices = await engine.undoCheckpoints(f.s);
    const target = choices[1]!.id;
    engine.undoHistory.restore = () => {
      // Simulate an interruption after one file reaches the selected target's contents.
      writeFileSync(path, "first");
      throw new Error("Interrupted selected restore");
    };
    await assert.rejects(engine.undo(f.s, target, () => {}), /Interrupted selected restore/);
    const state = await engine.harness.snapshot(UndoDoc, f.s.conversationId as ConversationId, BACKGROUND_CONTEXT);
    assert.equal(state?.restoreTo, target);
    const retryChoices = await engine.undoCheckpoints(f.s);
    assert.deepEqual(retryChoices.map((point) => [point.id, point.pending, point.turns]), [[target, true, 2]]);
    await assert.rejects(engine.undo(f.s, choices[0]!.id, () => {}), /previously selected checkpoint/);
    await engine.close();
    const store = new Store(f.store.root);
    engine = await openEngine(store, { provider: "test", modelId: "mock" }, (error) => f.errors.push(error), undoModels());
    await engine.restore(() => {});
    const restored = store.state.sessions[0]!;
    assert.equal(readFileSync(path, "utf8"), "first", "must restore before the selected middle turn, not before the latest");
    assert.equal(existsSync(join(f.work, "new.txt")), false);
    assert.deepEqual(restored.messages.filter((m) => m.role === "user").map((m) => m.text), [first]);
    assert.deepEqual((await engine.undoCheckpoints(restored)).map((point) => point.id), [choices[2]!.id]);
    assert.deepEqual(f.errors, []);
  } finally { await engine.close(); f.cleanup(); }
});

test("durable requests load per-project instruction files, refresh edits/removals and reload correctly after restart", async () => {
  const f = temporary(); const store = new Store(join(f.root, "data"));
  const a = join(f.root, "a"); const b = join(f.root, "b"); const agent = join(f.root, "agent");
  for (const path of [join(a, ".pi"), b, agent]) mkdirSync(path, { recursive: true });
  writeFileSync(join(agent, "AGENTS.md"), "GLOBAL_CONTEXT");
  writeFileSync(join(agent, "APPEND_SYSTEM.md"), "GLOBAL_APPEND");
  writeFileSync(join(a, "AGENTS.md"), "CONTEXT_A_FIRST");
  writeFileSync(join(b, "AGENTS.md"), "CONTEXT_B_ONLY");
  writeFileSync(join(a, ".pi", "SYSTEM.md"), "CUSTOM_A_SYSTEM");
  writeFileSync(join(a, ".pi", "APPEND_SYSTEM.md"), "CUSTOM_A_APPEND");
  const projects = [store.addProject(a), store.addProject(b)];
  const sessions = projects.map((p, i) => session(p, `instructions-${i}`)); store.state.sessions.push(...sessions);
  const requests: string[] = []; const errors: unknown[] = [];
  const makeModels = () => models({ context: (context) => requests.push(getCurrentSystemPrompt(context.messages)) });
  let engine = await openEngine(store, { provider: "test", modelId: "mock" }, (error) => errors.push(error), makeModels(), "off", undefined, new InstructionCatalog(agent));
  try {
    await engine.run(sessions[0]!, projects[0]!, "first", () => {});
    assert.match(requests[0]!, /GLOBAL_CONTEXT/); assert.match(requests[0]!, /CONTEXT_A_FIRST/);
    assert.match(requests[0]!, /CUSTOM_A_SYSTEM/); assert.match(requests[0]!, /CUSTOM_A_APPEND/);
    assert.doesNotMatch(requests[0]!, /CONTEXT_B_ONLY|GLOBAL_APPEND|Inspect before editing/);
    assert.match(requests[0]!, /Use ask_user whenever/);
    await engine.run(sessions[1]!, projects[1]!, "second", () => {});
    assert.match(requests[1]!, /CONTEXT_B_ONLY/); assert.match(requests[1]!, /GLOBAL_APPEND/);
    assert.doesNotMatch(requests[1]!, /CONTEXT_A_FIRST|CUSTOM_A_SYSTEM/);
    writeFileSync(join(a, "AGENTS.md"), "CONTEXT_A_UPDATED"); unlinkSync(join(a, ".pi", "APPEND_SYSTEM.md"));
    await engine.run(sessions[0]!, projects[0]!, "next request", () => {});
    assert.match(requests[2]!, /CONTEXT_A_UPDATED/); assert.match(requests[2]!, /GLOBAL_APPEND/);
    assert.doesNotMatch(requests[2]!, /CONTEXT_A_FIRST|CUSTOM_A_APPEND/);
    await engine.close();
    const restored = new Store(store.root);
    writeFileSync(join(a, ".pi", "SYSTEM.md"), "RESTARTED_SYSTEM");
    engine = await openEngine(restored, { provider: "test", modelId: "mock" }, (error) => errors.push(error), makeModels(), "off", undefined, new InstructionCatalog(agent));
    await engine.restore(() => {}); await engine.run(restored.state.sessions[0]!, projects[0]!, "after restart", () => {});
    assert.match(requests[3]!, /RESTARTED_SYSTEM/); assert.doesNotMatch(requests[3]!, /CUSTOM_A_SYSTEM/);
    assert.deepEqual(errors, []);
  } finally { await engine.close(); f.cleanup(); }
});

test("image attachments and explicit image references reach the model and persist alongside returned thinking", async () => {
  const f = temporary(); const store = new Store(join(f.root, "data")); const project = store.addProject(f.root);
  const s = session(project, "images-and-thinking"); store.state.sessions.push(s);
  writeFileSync(join(f.root, "photo with spaces.png"), png());
  const requests: Context[] = [];
  const engine = await openEngine(store, { provider: "test", modelId: "mock" }, () => {}, models({
    context: (context) => requests.push(context), reply: () => [{ type: "thinking", thinking: "Visible reasoning", thinkingSignature: "opaque-signature" },
      { type: "thinking", thinking: "encrypted-sensitive-payload", redacted: true, thinkingSignature: "encrypted-signature" },
      { type: "text", text: "Visible answer" }],
  }));
  try {
    await engine.run(s, project, 'Compare @"photo with spaces.png"', () => {}, [image]);
    const message = requests[0]!.messages.findLast((message) => message.role === "user")!;
    assert.ok(Array.isArray(message.content));
    assert.equal(message.content.filter((block) => block.type === "image").length, 2);
    assert.deepEqual(s.messages.find((message) => message.role === "user")?.images?.map((image) => image.name), ["sample.png", "photo with spaces.png"]);
    assert.match(s.messages.find((message) => message.role === "thinking")?.text ?? "", /Visible reasoning/);
    assert.equal(s.messages.find((message) => message.thinking?.redacted)?.text, "Thinking was redacted by the provider.");
    assert.equal(s.messages.at(-1)?.text, "Visible answer");
    store.save();
    assert.doesNotMatch(readFileSync(store.file, "utf8"), /encrypted-sensitive-payload|opaque-signature|encrypted-signature/);
    assert.deepEqual(new Store(store.root).state.sessions[0]?.messages, s.messages);
  } finally { await engine.close(); f.cleanup(); }
});

test("agent image reads use the image processor and retain viewable tool-result images", async () => {
  const f = temporary(); const store = new Store(join(f.root, "data")); const project = store.addProject(f.root);
  const s = session(project, "image-read"); store.state.sessions.push(s);
  writeFileSync(join(f.root, "photo.png"), png(4000, 2));
  const requests: Context[] = [];
  const engine = await openEngine(store, { provider: "test", modelId: "mock" }, () => {}, models({
    context: (context) => requests.push(context), reply: (context) => context.messages.at(-1)?.role === "toolResult"
      ? [{ type: "text", text: "I saw the image" }] : [{ type: "toolCall", id: "read-image", name: "read", arguments: { path: "photo.png" } }],
  }));
  try {
    await engine.run(s, project, "inspect the picture", () => {});
    assert.equal(s.messages.find((message) => message.tool?.name === "read")?.tool?.images?.length, 1);
    const result = requests[1]!.messages.findLast((message) => message.role === "toolResult")!;
    assert.ok(Array.isArray(result.content) && result.content.some((block) => block.type === "image"));
    assert.equal(s.messages.at(-1)?.text, "I saw the image");
  } finally { await engine.close(); f.cleanup(); }
});

test("queued image snapshots survive restart and source deletion without duplicate inputs", { timeout: 10_000 }, async () => {
  const f = temporary(); const store = new Store(join(f.root, "data")); const project = store.addProject(f.root);
  const s = session(project, "queued-images"); store.state.sessions.push(s);
  writeFileSync(join(f.root, "queued.png"), png());
  let started = false; const requests: Context[] = [];
  let engine = await openEngine(store, { provider: "test", modelId: "mock" }, () => {}, models({ pause: true, started: () => { started = true; } }));
  try {
    const running = engine.run(s, project, "initial", () => {}); await until(() => started);
    const queued = engine.run(s, project, "look @queued.png", () => {});
    await until(() => s.queuedInputs?.[0]?.imageCount === 1);
    assert.equal(s.followUps?.[0]?.images?.length, 1);
    unlinkSync(join(f.root, "queued.png"));
    await engine.close(); await Promise.all([running, queued]);
    const restored = new Store(store.root); const recovered = restored.state.sessions[0]!;
    assert.equal(recovered.followUps?.[0]?.images?.length, 1);
    engine = await openEngine(restored, { provider: "test", modelId: "mock" }, () => {}, models({ context: (context) => requests.push(context) }));
    await engine.restore(() => {}); await until(() => recovered.status === "completed" && !recovered.pendingInput);
    assert.deepEqual(recovered.messages.filter((message) => message.role === "user").map((message) => message.text), ["initial", "look @queued.png"]);
    assert.equal(recovered.messages.find((message) => message.role === "user" && message.images?.length)?.images?.[0]?.data, image.data);
    assert.ok(requests.some((context) => context.messages.some((message) => message.role === "user" && Array.isArray(message.content) && message.content.some((block) => block.type === "image"))));
  } finally { await engine.close(); f.cleanup(); }
});

test("text-only models reject attachments explicitly instead of silently dropping them", async () => {
  const f = temporary(); const store = new Store(join(f.root, "data")); const project = store.addProject(f.root);
  const s = session(project, "no-vision"); store.state.sessions.push(s);
  let requests = 0;
  const engine = await openEngine(store, { provider: "test", modelId: "mock" }, () => {}, models({ imageInput: false, context: () => { requests++; } }));
  try {
    await engine.run(s, project, "look", () => {}, [image]);
    assert.equal(s.status, "failed"); assert.match(s.preview, /does not accept images/);
    assert.equal(requests, 0); assert.equal(s.conversationId, undefined);
  } finally { await engine.close(); f.cleanup(); }
});

test("local shell responses survive durable projections and restart without entering model context", async () => {
  const f = temporary(); const store = new Store(join(f.root, "data")); const project = store.addProject(f.root);
  const requests: Context[] = []; const errors: unknown[] = [];
  let engine = await openEngine(store, { provider: "test", modelId: "mock" }, (error) => errors.push(error), models({ context: (context) => requests.push(context) }));
  let controller = new Controller(store, engine);
  try {
    assert.equal(controller.send("!printf 'LOCAL_SHELL_RESPONSE_9123\\n'"), true);
    await controller.shellRun!.done;
    const shellSession = controller.opened!;
    assert.equal(requests.length, 0); assert.equal(shellSession.conversationId, undefined);
    assert.equal(lastReply(shellSession), "LOCAL_SHELL_RESPONSE_9123\n");
    await engine.run(shellSession, project, "model question", () => {});
    assert.ok(requests.length > 0); assert.equal(shellSession.shellResponses?.length, 1);
    assert.equal(shellSession.messages.some((message) => message.text.includes("LOCAL_SHELL_RESPONSE_9123")), false);
    assert.equal(transcriptMessages(shellSession).filter((message) => message.role === "shell").length, 1);
    assert.doesNotMatch(JSON.stringify(requests), /LOCAL_SHELL_RESPONSE_9123/);
    await controller.close();
    const restored = new Store(store.root);
    engine = await openEngine(restored, { provider: "test", modelId: "mock" }, (error) => errors.push(error), models({ context: (context) => requests.push(context) }));
    controller = new Controller(restored, engine); await engine.restore(() => {});
    const session = restored.state.sessions[0]!;
    assert.equal(session.shellResponses?.[0]?.text, "LOCAL_SHELL_RESPONSE_9123\n");
    await engine.run(session, project, "another model question", () => {});
    assert.equal(transcriptMessages(session).filter((message) => message.role === "shell").length, 1);
    assert.doesNotMatch(JSON.stringify(requests), /LOCAL_SHELL_RESPONSE_9123/);
    assert.deepEqual(errors, []);
  } finally { await controller.close(); await engine.close(); f.cleanup(); }
});

test("saved auto-compaction policy applies live, survives engine restart and can be re-enabled", async () => {
  const temp = temporary(); let store = new Store(temp.root); const project = store.addProject(temp.root);
  let s = session(project, "configured-auto"); store.state.sessions.push(s);
  const usage: Usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  let summaries = 0;
  const fixture = models({ contextWindow: 100_000, usage, compaction: { started: () => { summaries++; } } });
  let engine = await openEngine(store, { provider: "test", modelId: "mock" }, (error) => assert.fail(String(error)), fixture);
  let c = new Controller(store, engine);
  try {
    await seedCompactableHistory(engine, s, project);
    assert.equal(c.setCompaction({ enabled: false }), true);
    usage.input = 90_000; usage.totalTokens = 90_001;
    await engine.run(s, project, "report usage", () => {});
    await engine.run(s, project, "continue without compacting", () => {});
    assert.equal(summaries, 0); assert.equal(s.status, "completed");
    await c.close();
    store = new Store(temp.root); s = store.state.sessions[0]!;
    engine = await openEngine(store, { provider: "test", modelId: "mock" }, (error) => assert.fail(String(error)), fixture);
    await engine.restore(() => {}); c = new Controller(store, engine);
    assert.equal(store.compaction.enabled, false);
    await engine.run(s, project, "still disabled after restart", () => {});
    assert.equal(summaries, 0);
    assert.equal(c.setCompaction({ enabled: true }), true);
    usage.input = 1; usage.totalTokens = 2;
    await engine.run(s, project, "now compact", () => {});
    assert.equal(summaries, 1); assert.equal(s.status, "completed");
    assert.equal(s.messages.find((m) => m.tool?.name === "compact")?.tool?.arguments.reason, "threshold");
  } finally { await c.close(); await engine.close(); temp.cleanup(); }
});

for (const [reserveTokens, backgroundTokens, below, above, blocking] of [
  [30_000, 10_000, 55_000, 65_000, false], [16_384, 0, 60_000, 90_000, true],
] as const) {
  test(`configured ${backgroundTokens ? "background lead changes the threshold" : "zero background lead keeps blocking compaction"}`, async () => {
    const temp = temporary(); const store = new Store(temp.root); const project = store.addProject(temp.root);
    const s = session(project, `custom-${backgroundTokens}`); store.state.sessions.push(s);
    const usage: Usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    let summaries = 0; const seen: boolean[] = [];
    const engine = await openEngine(store, { provider: "test", modelId: "mock" }, (error) => assert.fail(String(error)),
      models({ contextWindow: 100_000, usage, compaction: { started: () => {
        summaries++; seen.push(...(s.compactions ?? []).map((item) => item.blocking));
      } } }));
    const c = new Controller(store, engine);
    try {
      await seedCompactableHistory(engine, s, project);
      assert.equal(c.setCompaction({ reserveTokens, backgroundTokens }), true);
      usage.input = below; usage.totalTokens = below + 1;
      await engine.run(s, project, "report below threshold", () => {});
      usage.input = 1; usage.totalTokens = 2;
      await engine.run(s, project, "do not compact", () => {});
      assert.equal(summaries, 0);
      usage.input = above; usage.totalTokens = above + 1;
      await engine.run(s, project, "report above threshold", () => {});
      usage.input = 1; usage.totalTokens = 2;
      await engine.run(s, project, "compact now", () => {});
      await until(() => s.messages.some((m) => m.tool?.name === "compact"));
      assert.equal(summaries, 1); assert.ok(seen.includes(blocking), JSON.stringify(seen));
      assert.equal(s.status, "completed");
    } finally { await c.close(); temp.cleanup(); }
  });
}

test("disabled auto-compaction skips overflow recovery; enabling it restores recovery", async () => {
  const temp = temporary(); const store = new Store(temp.root); const project = store.addProject(temp.root);
  const s = session(project, "configured-overflow"); store.state.sessions.push(s);
  let requests = 0; let summaries = 0;
  const options = { overflow: false, context: () => { requests++; }, compaction: { started: () => { summaries++; } } };
  const engine = await openEngine(store, { provider: "test", modelId: "mock" }, (error) => assert.fail(String(error)), models(options));
  const c = new Controller(store, engine);
  try {
    await seedCompactableHistory(engine, s, project);
    c.setCompaction({ enabled: false });
    let count = requests; options.overflow = true;
    await engine.run(s, project, "overflow without recovery", () => {});
    assert.equal(requests, count + 1); assert.equal(summaries, 0); assert.equal(s.status, "failed");
    assert.match(s.messages.at(-1)!.text, /maximum context length exceeded/);
    c.setCompaction({ enabled: true });
    count = requests; options.overflow = true;
    await engine.run(s, project, "overflow with recovery", () => {});
    assert.equal(requests, count + 2); assert.equal(summaries, 1); assert.equal(s.status, "completed");
    assert.equal(s.messages.find((m) => m.tool?.name === "compact")?.tool?.arguments.reason, "overflow");
  } finally { await c.close(); temp.cleanup(); }
});

test("changing auto-compaction during a model request affects its next overflow check without aborting the request", async () => {
  const temp = temporary(); const store = new Store(temp.root); const project = store.addProject(temp.root);
  const s = session(project, "live-policy"); store.state.sessions.push(s);
  let finish!: (failure?: string) => void;
  const options = { pause: false, finish: (done: typeof finish) => { finish = done; },
    compaction: { started: () => assert.fail("Disabled overflow recovery must not summarize") } };
  const engine = await openEngine(store, { provider: "test", modelId: "mock" }, (error) => assert.fail(String(error)), models(options));
  const c = new Controller(store, engine);
  try {
    await seedCompactableHistory(engine, s, project);
    options.pause = true;
    const running = engine.run(s, project, "wait for provider", () => {});
    await until(() => !!finish);
    assert.equal(c.setCompaction({ enabled: false }), true);
    assert.equal(s.status, "working"); assert.equal(s.stopped, undefined);
    finish("maximum context length exceeded"); await running;
    assert.equal(s.status, "failed"); assert.equal(s.stopped, undefined);
    assert.match(s.messages.at(-1)!.text, /maximum context length exceeded/);
  } finally { await c.close(); temp.cleanup(); }
});

test("manual compaction still runs when Off and uses configured recent-context and summary budgets", async () => {
  const temp = temporary(); const store = new Store(temp.root); const project = store.addProject(temp.root);
  const s = session(project, "configured-manual"); store.state.sessions.push(s);
  const budgets: (number | undefined)[] = [];
  const engine = await openEngine(store, { provider: "test", modelId: "mock" }, (error) => assert.fail(String(error)),
    models({ compaction: { request: (request) => { budgets.push(request?.maxTokens); } } }));
  const c = new Controller(store, engine);
  try {
    c.setCompaction({ enabled: false });
    await engine.run(s, project, "first short turn", () => {});
    await engine.run(s, project, "second short turn", () => {});
    assert.equal(await engine.compact(s, undefined, () => {}), "unchanged");
    assert.equal(budgets.length, 0);
    assert.equal(c.setCompaction({ keepRecentTokens: 0, reserveTokens: 1000 }), true);
    assert.equal(await engine.compact(s, undefined, () => {}), "compacted");
    assert.deepEqual(budgets, [800]); assert.equal(store.compaction.enabled, false);
    assert.equal(s.messages.find((m) => m.tool?.name === "compact")?.tool?.arguments.reason, "manual");
    assert.equal(s.status, "completed");
  } finally { await c.close(); temp.cleanup(); }
});
