import assert from "node:assert/strict";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createModels, type Provider } from "@earendil-works/pi-ai/models";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { AssistantMessage, Context, SimpleStreamOptions, TextContent, ToolCall, Usage } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { DurableEngine } from "../src/engine.js";
import type { Project, Session } from "../src/model.js";
import { Store } from "../src/store.js";
import { SkillCatalog } from "../src/skills.js";
import { temporary } from "./helpers.js";

function openEngine(...args: Parameters<typeof DurableEngine.open>) {
  args[5] ??= new SkillCatalog(async () => ({ skills: [], diagnostics: [] }));
  return DurableEngine.open(...args);
}

function session(project: Project, id: string): Session {
  return { id, projectId: project.id, title: id, status: "working", preview: "Starting", createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
}

function models(options: { pause?: boolean; started?: () => void; context?: (context: Context) => void; request?: (id: string, reasoning: SimpleStreamOptions["reasoning"]) => void;
  usage?: Usage; titleUsage?: Usage;
  title?: { text?: string; fail?: boolean; pause?: boolean; ignoreAbort?: boolean; finish?: (done: () => void) => void; context?: (context: Context) => void } } = {}) {
  const models = createModels();
  const model = { ...getBuiltinModel("openai", "gpt-4.1"), provider: "test", id: "mock" };
  const stream = (_model: unknown, context: Context, request?: SimpleStreamOptions) => {
    const isTitle = context.messages.some((m) => m.role === "system" && typeof m.content === "string" && m.content.startsWith("Generate a short session title"));
    if (isTitle) options.title?.context?.(context);
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
      if (!isTitle) options.started?.();
      if (isTitle ? options.title?.pause : options.pause) {
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
      if (typeof last?.content === "string" && last.content === "fail") {
        message.stopReason = "error"; message.errorMessage = "Simulated provider failure";
        events.push({ type: "error", reason: "error", error: message });
        return;
      }
      const content: (TextContent | ToolCall)[] = last?.role === "toolResult"
        ? [{ type: "text", text: `Read: ${last.content.filter((b) => b.type === "text").map((b) => b.text).join("")}` }]
        : last?.content === "long-shell"
          ? [{ type: "toolCall", id: "sleep-call", name: "bash", arguments: { command: "printf 'SHELL_STARTED\\n'; sleep 30; printf 'SHOULD_NOT_FINISH\\n'" } }]
        : typeof last?.content === "string" && last.content.includes("ask")
          ? [{ type: "toolCall", id: `ask-${Date.now()}`, name: "ask_user", arguments: { question: "Retry or stop?" } }]
          : typeof last?.content === "string" && last.content.includes("read")
            ? [{ type: "toolCall", id: `read-${Date.now()}`, name: "read", arguments: { path: "marker.txt" } }]
            : [{ type: "text", text: "Recovered answer" }];
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
