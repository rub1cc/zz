import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type, type Message as ModelMessage, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { clampThinkingLevel, getSupportedThinkingLevels, type Models } from "@earendil-works/pi-ai/models";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  Harness, createRegistry, defineDoc, defineExtension, defineTool, section,
  type AgentState, type Conversation, type ConversationId, type ConversationView, type Cursor, type LiveState, type ModelRef, type UsageState,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { Engine } from "./controller.js";
import { finishWork, isThinkingLevel, lastReply, markStopped, type AgentSettings, type Message, type ModelOption, type PreparedInput, type Project, type Session, type SessionStats, type SkillOption } from "./model.js";
import { directory, Store } from "./store.js";
import { SkillCatalog } from "./skills.js";
import { generateSessionTitle } from "./title.js";
import { contextEstimate, conversationUsage, sessionStats } from "./usage.js";
import { settleWithin } from "./shutdown.js";

const ctx = BACKGROUND_CONTEXT;
const SessionMeta = defineDoc<{ sessionId: string }>({
  kind: "zz.session", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ sessionId: "" }),
});

function textOf(message: ModelMessage): string {
  return typeof message.content === "string" ? message.content
    : message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

function skillEntry(data: unknown): { prompt: string; skill: NonNullable<PreparedInput["skill"]> } | undefined {
  if (!data || typeof data !== "object") return;
  const value = data as { prompt?: unknown; skill?: PreparedInput["skill"] };
  if (typeof value.prompt === "string" && value.skill && typeof value.skill.name === "string"
    && typeof value.skill.filePath === "string" && typeof value.skill.text === "string") return { prompt: value.prompt, skill: value.skill };
}

export function applyView(session: Session, view: ConversationView): void {
  const messages: Message[] = [];
  session.usage = conversationUsage(view.docs["pi.usage"] as UsageState | undefined);
  const live = view.docs["pi.live"] as LiveState | undefined;
  const agent = view.docs["pi.agent"] as AgentState | undefined;
  if (agent) session.agent = { model: agent.model, thinkingLevel: agent.thinkingLevel ?? "off" };
  const calls = new Map<string, Message>();
  const previousError = session.status === "failed" && !session.pendingInput
    ? session.messages.findLast((m) => m.role === "error")?.text : undefined;
  let error: string | undefined;
  let needsInput = false;
  for (const entry of view.entries) {
    for (const message of entry.model ?? []) {
      if (message.role === "system") continue;
      if (message.role === "user") error = undefined;
      if (message.role === "assistant") error = message.stopReason === "error"
        ? message.errorMessage || "The model request failed." : undefined;
      const text = textOf(message);
      if (message.role === "toolResult" && message.toolName === "ask_user" && !message.isError) needsInput = true;
      else if (message.role === "assistant" || message.role === "user") needsInput = false;
      if (message.role === "toolResult") {
        let call = calls.get(message.toolCallId);
        if (!call) {
          call = { role: "tool", text: "", timestamp: message.timestamp, tool: {
            id: `${entry.id}:${message.toolCallId}`, name: message.toolName, arguments: {}, output: "", status: "done",
          } };
          messages.push(call);
        }
        const tool = call.tool!;
        tool.output = message.content.map((block) => block.type === "text" ? block.text : `[Image: ${block.mimeType}]`).join("\n");
        tool.durationMs = message.durationMs;
        const diagnostics = entry.data && typeof entry.data === "object" && !Array.isArray(entry.data) ? entry.data.diagnostics : undefined;
        const interrupted = Array.isArray(diagnostics) && diagnostics.some((item) => item && typeof item === "object"
          && !Array.isArray(item) && ["aborted", "interrupted", "abandoned"].includes(String(item.code)));
        tool.status = message.isError ? interrupted ? "interrupted" : "error" : "done";
        tool.details = message.details !== undefined || Array.isArray(diagnostics) && diagnostics.length
          ? { result: message.details, diagnostics } : undefined;
        if (message.toolName === "ask_user" && text) messages.push({ role: "assistant", text, timestamp: message.timestamp });
        continue;
      }
      const loadedSkill = message.role === "user" && entry.kind === "zz.skill" ? skillEntry(entry.data) : undefined;
      if (loadedSkill) {
        messages.push({ role: "user", text: loadedSkill.prompt, timestamp: message.timestamp },
          { role: "tool", text: "", timestamp: message.timestamp, tool: {
            id: `skill:${entry.id}`, name: "load_skill", arguments: { name: loadedSkill.skill.name, path: loadedSkill.skill.filePath },
            output: loadedSkill.skill.text, status: "done",
          } });
      } else if (text) messages.push({ role: message.role, text, timestamp: message.timestamp });
      if (message.role === "assistant") {
        for (const call of message.content.filter((block) => block.type === "toolCall")) {
          const card: Message = { role: "tool", text: "", timestamp: message.timestamp, tool: {
            id: `${entry.id}:${call.id}`, name: call.name, arguments: call.arguments, output: "",
            status: live?.run ? "pending" : "interrupted",
          } };
          calls.set(call.id, card);
          messages.push(card);
        }
      }
    }
  }
  for (const slot of live?.tools ?? []) {
    const tool = calls.get(slot.callId)?.tool;
    if (tool && (tool.status === "pending" || tool.status === "running")) {
      tool.status = slot.status === "done" ? "done" : slot.status;
      tool.output = slot.output ?? tool.output;
      tool.details = slot.details !== undefined || slot.diagnostics?.length
        ? { details: slot.details, diagnostics: slot.diagnostics } : undefined;
    }
  }
  const partial = live?.generation?.message;
  if (partial) {
    const text = partial.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    if (text) messages.push({ role: "assistant", text, timestamp: partial.timestamp });
  }
  session.messages = messages;
  const tool = live?.tools?.find((t) => t.status !== "done");
  if (live?.run) {
    session.status = "working";
    session.preview = session.stopped ? "Stopping..." : tool ? `Running ${tool.name}` : live.generation?.retry ? `Retrying: ${live.generation.retry.error}`
      : partial ? textOf(partial as ModelMessage).slice(-250) || "Thinking..." : "Thinking...";
  } else if (session.stopped) {
    session.status = "paused";
    session.preview = "Stopped. Reply to continue.";
  } else {
    const failure = error ?? previousError;
    session.status = failure ? "failed" : needsInput ? "needs-input" : "completed";
    if (failure) session.messages.push({ role: "error", text: failure, timestamp: session.updatedAt });
    session.preview = failure ?? lastReply(session).replace(/\s+/g, " ").slice(0, 250);
  }
  session.updatedAt = messages.at(-1)?.timestamp ?? session.updatedAt;
}

export class DurableEngine implements Engine {
  private handles = new Map<string, Conversation>();
  private views = new Map<string, { dispose(): void }>();
  private active = new Map<string, Promise<void>>();
  private contextUpdates = new Map<string, Promise<void>>();
  private stopping = new Set<string>();
  private cancellations = new Map<string, Promise<void>>();
  private titles = new Map<string, { abort: AbortController; done: Promise<void> }>();
  private closing = false;
  private closePromise?: Promise<void>;

  private constructor(
    readonly store: Store, readonly harness: Harness, readonly models: Models,
    readonly model: ModelRef | undefined, readonly report: (error: unknown) => void,
    readonly thinkingLevel: ModelThinkingLevel,
    readonly skills: SkillCatalog,
  ) {}

  static async open(store: Store, model: ModelRef | undefined, report: (error: unknown) => void, models?: Models, thinkingLevel: ModelThinkingLevel = "off", skills = new SkillCatalog()): Promise<DurableEngine> {
    models ??= await ModelRuntime.create({ allowModelNetwork: false });
    const registry = createRegistry();
    registry.install(CodingTools);
    registry.install(defineExtension({
      name: "zz",
      sections: [
        section("preamble", () => "You are a coding assistant working in a project directory. Inspect before editing, preserve existing changes, and verify your work. Use ask_user when you need the user's decision before continuing. Otherwise finish with a concise report.", { tag: false }),
        section("cwd", ({ env }) => env?.cwd),
        section("skills", ({ agent }) => agent.cwd ? skills.prompt(agent.cwd) : undefined, { tag: false }),
      ],
      tools: [defineTool({
        name: "ask_user", description: "Ask for a decision needed to proceed. This pauses work until the user replies.",
        parameters: Type.Object({ question: Type.String() }),
        execute: async ({ question }) => ({ output: [{ type: "text", text: question }], control: { terminate: true } }),
      })],
    }));
    const harness = await Harness.open(await openNodeSqliteStorage(join(store.root, "sessions.sqlite")), {
      models, registry, env: ({ cwd }) => {
        if (!cwd) throw new Error("Session has no project directory.");
        return new NodeExecutionEnv({ cwd: directory(cwd) });
      }, onReport: report,
    }, ctx);
    const engine = new DurableEngine(store, harness, models, model, report, thinkingLevel, skills);
    void harness.closed.then((end) => { if (end.reason === "failed") report(end.error); });
    return engine;
  }

  configuration(session?: Session): AgentSettings {
    const current = session?.agent ?? this.store.state.defaults ?? { model: this.model, thinkingLevel: this.thinkingLevel };
    return { ...current, model: current.model && { ...current.model } };
  }

  stats(session?: Session): SessionStats {
    const ref = this.configuration(session).model;
    const model = ref && this.models.getModel(ref.provider, ref.modelId);
    return session ? sessionStats(session, model?.contextWindow) : { contextWindow: model?.contextWindow };
  }

  async listModels(): Promise<ModelOption[]> {
    return (await this.models.getAvailable()).map((model) => ({
      provider: model.provider, modelId: model.id, name: model.name, thinkingLevels: getSupportedThinkingLevels(model),
    })).sort((a, b) => `${a.provider}/${a.modelId}`.localeCompare(`${b.provider}/${b.modelId}`));
  }

  async listSkills(project: Project): Promise<SkillOption[]> {
    return this.skills.list(directory(project.path));
  }

  async configure(change: Partial<AgentSettings>, session?: Session): Promise<void> {
    if (this.closing) throw new Error("zz is closing.");
    const thinkingOnly = change.thinkingLevel !== undefined && change.model === undefined;
    if (!thinkingOnly && session && (this.active.has(session.id) || session.status === "working")) throw new Error("Wait for this session to finish first.");
    const current = this.configuration(session);
    const next = { ...current, ...change };
    if (!next.model) throw new Error("Choose a model first with /model.");
    const model = this.models.getModel(next.model.provider, next.model.modelId);
    if (!model) throw new Error("This model is no longer in Pi's catalog.");
    if (!await this.models.checkAuth(model.provider)) throw new Error(`Run pi and /login for ${model.provider}, then restart zz.`);
    if (!thinkingOnly && session && this.active.has(session.id)) throw new Error("Wait for this session to finish first.");
    if (!isThinkingLevel(next.thinkingLevel)) throw new Error("Invalid thinking level.");
    if (change.thinkingLevel && !getSupportedThinkingLevels(model).includes(change.thinkingLevel)) {
      throw new Error(`This model supports thinking: ${getSupportedThinkingLevels(model).join(", ")}.`);
    }
    next.thinkingLevel = clampThinkingLevel(model, next.thinkingLevel);
    const conversation = session && this.handles.get(session.id);
    if (conversation) await conversation.configure(next, ctx);
    if (session) session.agent = next;
    else this.store.state.defaults = next;
    this.store.save();
  }

  async restore(changed: () => void): Promise<void> {
    // Reconnect a conversation if a crash happened between its commit and saving the UI index.
    let cursor: Cursor | undefined;
    do {
      const page = await this.harness.commit((tx) => tx.scanConversations({}, 100, cursor), ctx);
      for (const record of page.items) {
        const meta = await this.harness.snapshot(SessionMeta, record.id, ctx);
        const session = this.store.state.sessions.find((s) => s.id === meta?.sessionId);
        if (session) session.conversationId = record.id;
      }
      cursor = page.next;
    } while (cursor);
    for (const session of this.store.state.sessions) {
      if (session.conversationId !== undefined) {
        const conversation = await this.harness.conversation(session.conversationId as ConversationId, ctx);
        if (!conversation) continue;
        this.handles.set(session.id, conversation);
        await this.observe(session, conversation, changed);
      }
    }
    this.store.save();
    for (const session of this.store.state.sessions) {
      if (session.stopped) { await this.cancel(session.id); continue; }
      const pending = session.pendingInput;
      if (!pending) continue;
      const project = this.store.state.projects.find((p) => p.id === session.projectId) ?? { id: session.projectId, path: session.projectId };
      void this.run(session, project, pending.prompt, changed).catch((error: unknown) => { this.failure(session, error); changed(); });
    }
    this.harness.resume();
  }

  private failure(session: Session, error: unknown): void {
    if (session.stopped) { markStopped(session); return; }
    session.status = this.closing ? "paused" : "failed";
    session.preview = this.closing ? "Paused. Work resumes when zz reopens." : error instanceof Error ? error.message : String(error);
    if (!this.closing) {
      delete session.pendingInput;
      session.messages.push({ role: "error", text: session.preview, timestamp: Date.now() });
    }
  }

  private async observe(session: Session, conversation: Conversation, changed: () => void): Promise<void> {
    if (this.views.has(session.id)) return;
    const view = await conversation.viewState(ctx);
    let entries = view.value.entries;
    let revision = 0;
    // Coalesce committed entry updates. Streaming/live-doc changes never rescan context.
    const refresh = (): Promise<void> => {
      if (this.closing) return Promise.resolve();
      revision++;
      delete session.context;
      const pending = this.contextUpdates.get(session.id);
      if (pending) return pending;
      const update = (async () => {
        let current: number;
        do {
          current = revision;
          const context = await conversation.context(ctx);
          if (current === revision && !this.closing) {
            session.context = contextEstimate(context);
            changed();
          }
        } while (current !== revision && !this.closing);
      })().catch((error: unknown) => { if (!this.closing && !this.stopping.has(session.id)) this.report(error); })
        .finally(() => { this.contextUpdates.delete(session.id); });
      this.contextUpdates.set(session.id, update);
      return update;
    };
    applyView(session, view.value);
    view.subscribe((value) => {
      applyView(session, value);
      if (value.entries !== entries) { entries = value.entries; void refresh(); }
      changed();
    });
    this.views.set(session.id, view);
    await refresh();
  }

  private startTitle(session: Session, prompt: string, changed: () => void): void {
    if (this.closing || this.stopping.has(session.id)) return;
    const ref = this.configuration(session).model;
    const model = ref && this.models.getModel(ref.provider, ref.modelId);
    if (!model) return;
    const abort = new AbortController();
    const original = session.title;
    const done = generateSessionTitle(this.models, model, prompt, abort.signal, (usage) => {
      if (this.closing) return;
      session.titleUsage = structuredClone(usage);
      this.store.save();
      changed();
    }).then((title) => {
      if (!title || abort.signal.aborted || this.closing || this.stopping.has(session.id) || session.title !== original) return;
      session.title = title;
      this.store.save();
      changed();
    }).catch((error: unknown) => { this.report(error); }).finally(() => { this.titles.delete(session.id); });
    this.titles.set(session.id, { abort, done });
  }

  async run(session: Session, project: Project, prompt: string, changed: () => void): Promise<void> {
    if (this.stopping.has(session.id)) throw new Error("This session is still stopping. Try again when it is idle.");
    const existing = this.active.get(session.id);
    if (existing) return existing;
    delete session.stopped;
    if (!session.pendingInput && session.work?.finishedAt !== undefined) session.work = undefined;
    session.work ??= { startedAt: Date.now() };
    session.pendingInput ??= { requestId: randomUUID(), prompt };
    this.store.save();
    const promise = this.execute(session, project, changed).catch((error: unknown) => {
      this.failure(session, error);
    }).finally(() => {
      if (!this.closing) finishWork(session);
      this.active.delete(session.id);
      this.store.save();
      changed();
    });
    this.active.set(session.id, promise);
    return promise;
  }

  private async execute(session: Session, project: Project, changed: () => void): Promise<void> {
    if (this.closing || this.stopping.has(session.id)) return;
    const input = session.pendingInput;
    if (!input) return;
    if (!input.prepared) {
      input.prepared = await this.skills.prepare(project.path, input.prompt);
      this.store.save();
    }
    let conversation = this.handles.get(session.id);
    if (!conversation) {
      const config = this.configuration(session);
      if (!config.model) throw new Error("No Pi login found. Run pi, use /login, select a model with /model, then restart zz.");
      const model = this.models.getModel(config.model.provider, config.model.modelId);
      if (!model) throw new Error(`Unknown model ${config.model.provider}/${config.model.modelId}. Choose one with --model.`);
      if (!await this.models.checkAuth(config.model.provider)) throw new Error(`Not logged in to ${config.model.provider} in Pi. Run pi and /login, then restart zz.`);
      config.thinkingLevel = clampThinkingLevel(model, this.configuration(session).thinkingLevel);
      if (this.closing || this.stopping.has(session.id)) return;
      conversation = await this.harness.createConversation({
        ownership: { kind: "ownerless" }, agent: { cwd: directory(project.path), ...config },
        init: async (tx, id) => { (await tx.doc(SessionMeta, id)).sessionId = session.id; },
      }, ctx);
      session.conversationId = conversation.id;
      this.handles.set(session.id, conversation);
      const latestThinking = clampThinkingLevel(model, this.configuration(session).thinkingLevel);
      if (latestThinking !== config.thinkingLevel) await conversation.configure({ thinkingLevel: latestThinking }, ctx);
      this.store.save();
      this.startTitle(session, input.prompt, changed);
    }
    if (this.closing || this.stopping.has(session.id)) return;
    await this.observe(session, conversation, changed);
    if (this.closing || this.stopping.has(session.id)) return;
    const submission = await conversation.submit({ type: "input", content: input.prepared.content, requestId: input.requestId,
      entry: input.prepared.skill ? { kind: "zz.skill", data: { prompt: input.prompt, skill: input.prepared.skill } } : undefined,
    }, ctx);
    const result = await submission.wait(ctx);
    await this.contextUpdates.get(session.id);
    delete session.pendingInput;
    if (result.status === "unanswered") throw new Error(`${result.reason}${result.detail ? `: ${JSON.stringify(result.detail)}` : ""}`);
    this.store.save();
  }

  cancel(sessionId: string): Promise<void> {
    const existing = this.cancellations.get(sessionId);
    if (existing) return existing;
    const promise = this.cancelSession(sessionId).finally(() => { this.cancellations.delete(sessionId); });
    this.cancellations.set(sessionId, promise);
    return promise;
  }

  private async cancelSession(sessionId: string): Promise<void> {
    this.stopping.add(sessionId);
    try {
      const session = this.store.state.sessions.find((s) => s.id === sessionId);
      const running = this.active.get(sessionId);
      if (session && (running || session.pendingInput || session.status === "working")) {
        // Persist stop intent before aborting so a restart never resubmits this input.
        session.stopped = true;
        session.preview = "Stopping...";
        this.store.save();
      }
      const title = this.titles.get(sessionId);
      title?.abort.abort();
      const conversation = this.handles.get(sessionId) ?? (session?.conversationId !== undefined
        ? await this.harness.conversation(session.conversationId as ConversationId, ctx) : undefined);
      await Promise.all([conversation?.abort(ctx, { background: true }), running, title?.done]);
      await this.contextUpdates.get(sessionId);
      if (session?.stopped) { markStopped(session); this.store.save(); }
    } finally { this.stopping.delete(sessionId); }
  }

  async stop(sessionId: string): Promise<void> {
    await this.cancel(sessionId);
    this.views.get(sessionId)?.dispose();
    this.views.delete(sessionId);
    this.handles.delete(sessionId);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    for (const title of this.titles.values()) title.abort.abort();
    // Seal admission and cancel durable invocations before joining any host-side work.
    const durableClose = this.harness.close(ctx);
    this.closePromise = (async () => {
      try {
        await durableClose;
        await Promise.allSettled([...this.active.values(), ...this.contextUpdates.values()]);
        await settleWithin(Promise.allSettled([...this.titles.values()].map((title) => title.done)), 250);
      } finally {
        for (const view of this.views.values()) view.dispose();
        this.views.clear();
      }
    })();
    return this.closePromise;
  }
}
