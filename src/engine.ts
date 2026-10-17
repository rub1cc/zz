import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { type JsonRepresentation } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Message as ModelMessage, type ModelThinkingLevel, type Usage } from "@earendil-works/pi-ai";
import { clampThinkingLevel, getSupportedThinkingLevels, type Models } from "@earendil-works/pi-ai/models";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  Harness, createRegistry, defineDoc, defineExtension, defineTool, section,
  type AgentState, type Conversation, type ConversationId, type ConversationView, type Cursor, type InboxState, type LiveState, type ModelRef, type Submission, type UsageState, type EntryId, type Tx,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import type { Engine } from "./controller.js";
import { compactionLabel, finishWork, isThinkingLevel, lastReply, markStopped, type ImageAttachment, type AgentSettings, type CompactResult, type Message, type ModelOption, type PendingInput, type PreparedInput, type Project, type Session, type SessionStats, type SkillOption, type UndoResult, type UndoCheckpoint } from "./model.js";
import { directory, isImages, Store } from "./store.js";
import { InstructionCatalog, INTERACTION_POLICY } from "./instructions.js";
import { getImageProcessor, prepareImageFile, referencedImages, MAX_ATTACHMENTS } from "./attachments.js";
import { SkillCatalog } from "./skills.js";
import { generateSessionTitle } from "./title.js";
import { contextEstimate, conversationUsage, sessionStats, sumUsage } from "./usage.js";
import { settleWithin } from "./shutdown.js";
import { UndoDoc, UndoHistory } from "./undo.js";
import { askQuestionParameters, askMultipleQuestionsParameters, isQuestionTool, questionnaire, questionText } from "./questions.js";
import { taskExtension, TasksDoc, type TaskState } from "./tasks.js";

const ctx = BACKGROUND_CONTEXT;
const SessionMeta = defineDoc<{ sessionId: string; priorUsage?: JsonRepresentation<Usage> }>({
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

function imagesOf(message: ModelMessage, names: string[] = []): ImageAttachment[] | undefined {
  if (typeof message.content === "string") return;
  const images = message.content.filter((block) => block.type === "image")
    .map((block, index) => ({ type: "image" as const, data: block.data, mimeType: block.mimeType, ...(names[index] ? { name: names[index] } : {}) }));
  return images.length ? images : undefined;
}

function thinkingMessages(message: ModelMessage, id: string): Message[] {
  if (message.role !== "assistant") return [];
  return message.content.flatMap((block, index) => block.type === "thinking" ? [{ role: "thinking" as const,
    text: block.redacted ? "Thinking was redacted by the provider." : block.thinking,
    timestamp: message.timestamp, thinking: { id: `thinking:${id}:${index}`, ...(block.redacted ? { redacted: true } : {}) } }] : []);
}

export function applyView(session: Session, view: ConversationView, priorUsage?: Usage): void {
  const messages: Message[] = [];
  const usage = conversationUsage(view.docs["pi.usage"] as UsageState | undefined);
  session.usage = priorUsage ? sumUsage([priorUsage, usage]) : usage;
  const inbox = view.docs["pi.inbox"] as InboxState | undefined;
  const queued = (inbox?.items ?? []).flatMap((item) => {
    if (item.mode === "write") return [];
    const skill = item.entry?.kind === "zz.skill" ? skillEntry(item.entry.data) : undefined;
    const text = skill?.prompt ?? (typeof item.content === "string" ? item.content
      : item.content.filter((block) => block.type === "text").map((block) => block.text).join("\n"));
    const imageCount = typeof item.content === "string" ? 0 : item.content.filter((block) => block.type === "image").length;
    return [{ id: item.id, text, mode: item.mode, ...(imageCount ? { imageCount } : {}) }];
  });
  session.queuedInputs = queued.length ? queued : undefined;
  const live = view.docs["pi.live"] as LiveState | undefined;
  session.compactions = live?.compactions?.length ? structuredClone(live.compactions) : undefined;
  session.compactionFailure = live?.compactionFailure && structuredClone(live.compactionFailure);
  const agent = view.docs["pi.agent"] as AgentState | undefined;
  if (agent) session.agent = { model: agent.model, thinkingLevel: agent.thinkingLevel ?? "off" };
  const calls = new Map<string, Message>();
  const previousError = session.status === "failed" && !session.pendingInput
    ? session.messages.findLast((m) => m.role === "error")?.text : undefined;
  let error: string | undefined;
  let needsInput = false;
  for (const entry of view.entries) {
    if (entry.kind === "pi.compaction") {
      const reason = entry.data && typeof entry.data === "object" && !Array.isArray(entry.data) ? entry.data.reason : undefined;
      messages.push({ role: "tool", text: "", timestamp: entry.model?.[0]?.timestamp ?? session.updatedAt, tool: {
        id: `compaction:${entry.id}`, name: "compact", arguments: { reason: reason ?? "manual" },
        output: (entry.model ?? []).map(textOf).join("\n"), status: "done",
      } });
      continue;
    }
    for (const message of entry.model ?? []) {
      if (message.role === "system") continue;
      if (message.role === "user") error = undefined;
      if (message.role === "assistant") error = message.stopReason === "error"
        ? message.errorMessage || "The model request failed." : undefined;
      const text = textOf(message);
      if (message.role === "toolResult" && isQuestionTool(message.toolName) && !message.isError) needsInput = true;
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
        tool.images = imagesOf(message, typeof tool.arguments.path === "string" ? [tool.arguments.path] : []);
        tool.output = message.content.map((block) => block.type === "text" ? block.text : `[Image: ${block.mimeType}]`).join("\n");
        tool.durationMs = message.durationMs;
        const diagnostics = entry.data && typeof entry.data === "object" && !Array.isArray(entry.data) ? entry.data.diagnostics : undefined;
        const interrupted = Array.isArray(diagnostics) && diagnostics.some((item) => item && typeof item === "object"
          && !Array.isArray(item) && ["aborted", "interrupted", "abandoned"].includes(String(item.code)));
        tool.status = message.isError ? interrupted ? "interrupted" : "error" : "done";
        tool.details = message.details !== undefined || Array.isArray(diagnostics) && diagnostics.length
          ? { result: message.details, diagnostics } : undefined;
        if (isQuestionTool(message.toolName) && !message.isError && text) messages.push({ role: "assistant", text, timestamp: message.timestamp });
        continue;
      }
      messages.push(...thinkingMessages(message, String(entry.id)));
      const data = entry.data as { imageNames?: unknown } | undefined;
      const imageNames = data && Array.isArray(data.imageNames) ? data.imageNames.filter((name): name is string => typeof name === "string") : [];
      const images = imagesOf(message, imageNames);
      const loadedSkill = message.role === "user" && entry.kind === "zz.skill" ? skillEntry(entry.data) : undefined;
      if (loadedSkill) {
        messages.push({ role: "user", text: loadedSkill.prompt, timestamp: message.timestamp, ...(images ? { images } : {}) },
          { role: "tool", text: "", timestamp: message.timestamp, tool: {
            id: `skill:${entry.id}`, name: "load_skill", arguments: { name: loadedSkill.skill.name, path: loadedSkill.skill.filePath },
            output: loadedSkill.skill.text, status: "done",
          } });
      } else if (text || images) messages.push({ role: message.role, text, timestamp: message.timestamp, ...(images ? { images } : {}) });
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
    messages.push(...thinkingMessages(partial as ModelMessage, `live:${live?.run?.taskId ?? "generation"}`));
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
  if (session.compactions?.length) session.preview = compactionLabel(session)!;
  else if (session.compactionFailure && session.status === "completed") session.preview = `Compaction failed: ${session.compactionFailure.error}`;
  session.updatedAt = messages.at(-1)?.timestamp ?? session.updatedAt;
}

export class DurableEngine implements Engine {
  private handles = new Map<string, Conversation>();
  private views = new Map<string, { dispose(): void; readonly value: ConversationView }>();
  private active = new Map<string, Set<Promise<void>>>();
  /** Serialize preparation and admission, not completion: Durable owns the actual follow-up queue. */
  private admissions = new Map<string, Promise<void>>();
  private manualCompactions = new Map<string, Promise<CompactResult>>();
  private contextUpdates = new Map<string, Promise<void>>();
  private stopping = new Set<string>();
  private cancellations = new Map<string, Promise<void>>();
  private titles = new Map<string, { abort: AbortController; done: Promise<void> }>();
  private closing = false;
  private closePromise?: Promise<void>;
  private undoing = new Map<string, Promise<UndoResult>>();
  private undoProjects = new Set<string>();
  private undoPending = new Set<string>();

  private constructor(
    readonly store: Store, readonly harness: Harness, readonly models: Models,
    readonly model: ModelRef | undefined, readonly report: (error: unknown) => void,
    readonly thinkingLevel: ModelThinkingLevel,
    readonly skills: SkillCatalog,
    readonly undoHistory: UndoHistory,
  ) {}

  static async open(store: Store, model: ModelRef | undefined, report: (error: unknown) => void, models?: Models, thinkingLevel: ModelThinkingLevel = "off", skills = new SkillCatalog(), instructions = new InstructionCatalog()): Promise<DurableEngine> {
    models ??= await ModelRuntime.create({ allowModelNetwork: false });
    const registry = createRegistry();
    registry.install(createCodingTools({ images: await getImageProcessor() }));
    const undoHistory = new UndoHistory(store.root);
    registry.install(undoHistory.extension);
    registry.install(taskExtension);
    registry.install(defineExtension({
      name: "zz",
      sections: [
        section("preamble", ({ agent }) => agent.cwd ? instructions.preamble(agent.cwd) : undefined, { tag: false }),
        section("zz_behavior", () => INTERACTION_POLICY, { tag: false }),
        section("addendum", ({ agent }) => agent.cwd ? instructions.append(agent.cwd) : undefined),
        section("project_context", ({ agent }) => agent.cwd ? instructions.context(agent.cwd) : undefined),
        section("cwd", ({ env }) => env?.cwd),
        section("skills", ({ agent }) => agent.cwd ? skills.prompt(agent.cwd) : undefined, { tag: false }),
      ],
      tools: [defineTool({
        name: "ask_question", description: "Ask a direct question in chat whenever you expect a conversational reply, including conversational or random questions, clarification, decisions, and approval requests. This is the default question tool. The normal composer stays available; no form or wizard opens. Marks the session as needs-input and pauses work until the user replies. Use ask_multiple_questions only when structured choices or related multi-step questions genuinely benefit from controls. Do not use for rhetorical questions, quoted questions, or examples that do not need an answer.",
        parameters: askQuestionParameters,
        execute: async ({ question }) => ({ output: [{ type: "text", text: question }], control: { terminate: true } }),
      }), defineTool({
        name: "ask_multiple_questions", description: "Collect structured choices or related multi-step answers in a form that replaces the composer. Use ask_question for ordinary conversational questions instead. Marks the session as needs-input and pauses work until the user submits or replies. Supply questions with unique ids and types: radio (single choice), select (single choice, same as radio), multiselect (one or more choices), or input (free text). Choice steps allow at most 5 options total, including the custom answer row. Each listed option requires a value, label, and concise description shown underneath. allowOther defaults to true, leaving room for at most 4 listed options. Options are not searchable or filterable and all descriptions remain visible. The last step reviews answers and requires explicit submission.",
        parameters: askMultipleQuestionsParameters,
        execute: async (args) => ({ output: [{ type: "text", text: questionText(questionnaire(args)) }], control: { terminate: true } }),
      })],
    }));
    const harness = await Harness.open(await openNodeSqliteStorage(join(store.root, "sessions.sqlite")), {
      models, registry, settings: { get compaction() { return store.compaction; } }, env: ({ cwd }) => {
        if (!cwd) throw new Error("Session has no project directory.");
        return new NodeExecutionEnv({ cwd: directory(cwd) });
      }, onReport: report,
    }, ctx);
    undoHistory.harness = harness;
    const engine = new DurableEngine(store, harness, models, model, report, thinkingLevel, skills, undoHistory);
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

  supportsImages(session?: Session): boolean {
    const ref = this.configuration(session).model;
    return !!(ref && this.models.getModel(ref.provider, ref.modelId)?.input.includes("image"));
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
    if (session && (this.undoProjects.has(session.projectId) || this.pendingUndo(session.projectId))) throw new Error("Wait for /undo to finish first.");
    const thinkingOnly = change.thinkingLevel !== undefined && change.model === undefined;
    if (!thinkingOnly && session && (this.active.has(session.id) || session.status === "working" || session.compactions?.length || this.manualCompactions.has(session.id))) throw new Error("Wait for this session to finish first.");
    const current = this.configuration(session);
    const next = { ...current, ...change };
    if (!next.model) throw new Error("Choose a model first with /model.");
    const model = this.models.getModel(next.model.provider, next.model.modelId);
    if (!model) throw new Error("This model is no longer in Pi's catalog.");
    if (!await this.models.checkAuth(model.provider)) throw new Error(`Use /login ${model.provider} to configure this provider.`);
    if (!thinkingOnly && session && (this.active.has(session.id) || session.compactions?.length || this.manualCompactions.has(session.id))) throw new Error("Wait for this session to finish first.");
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
    // Complete a restore interrupted between filesystem writes and the conversation fork.
    for (const session of this.store.state.sessions) {
      const conversation = this.handles.get(session.id);
      const undo = conversation && await this.harness.snapshot(UndoDoc, conversation.id, ctx);
      if (undo?.restoring) {
        this.undoPending.add(session.id);
        try {
          const checkpointId = undo.restoreTo ?? undo.points.at(-1)?.id;
          if (!checkpointId) throw new Error("The selected undo checkpoint is missing.");
          await this.undo(session, checkpointId, changed);
        }
        catch (error) {
          delete session.stopped;
          session.status = "failed";
          session.preview = `Interrupted /undo could not finish. Fix the file conflict or I/O error and retry /undo: ${error instanceof Error ? error.message : String(error)}`;
          session.messages.push({ role: "error", text: session.preview, timestamp: Date.now() });
          changed();
        }
      }
    }
    this.store.save();
    for (const session of this.store.state.sessions) {
      if (session.stopped) { await this.cancel(session.id); continue; }
      const inputs = [session.pendingInput, ...(session.followUps ?? [])].filter((input): input is PendingInput => !!input);
      const project = this.store.state.projects.find((p) => p.id === session.projectId) ?? { id: session.projectId, path: session.projectId };
      // Replay the saved request IDs, including admissions committed just before a crash.
      for (const input of inputs) void this.startInput(session, project, input, changed)
        .catch((error: unknown) => { this.report(error); });
    }
    this.harness.resume();
  }

  private failure(session: Session, error: unknown): void {
    if (session.stopped) { markStopped(session); return; }
    // A rejected follow-up (e.g. a missing skill) must not relabel an unrelated live run.
    if (!this.closing && (this.views.get(session.id)?.value.docs["pi.live"] as LiveState | undefined)?.run) {
      this.report(error);
      return;
    }
    session.status = this.closing ? "paused" : "failed";
    session.preview = this.closing ? "Paused. Work resumes when zz reopens." : error instanceof Error ? error.message : String(error);
    if (!this.closing) {
      session.messages.push({ role: "error", text: session.preview, timestamp: Date.now() });
    }
  }

  private async observe(session: Session, conversation: Conversation, changed: () => void): Promise<void> {
    if (this.views.has(session.id)) return;
    // Conversation views mount only built-in docs; observe our checklist separately.
    // Materialize an empty document for older conversations as well as new ones.
    await conversation.commit(async (tx) => { await tx.doc(TasksDoc, conversation.id); }, ctx);
    const tasks = (await this.harness.documentState(TasksDoc, conversation.id, ctx))!;
    const syncTasks = (state: Readonly<TaskState> | null): void => {
      session.tasks = state?.items.length ? structuredClone(state.items) : undefined;
    };
    syncTasks(tasks.value);
    tasks.subscribe((value) => { syncTasks(value); changed(); });
    const view = await conversation.viewState(ctx);
    const priorUsage = (await this.harness.snapshot(SessionMeta, conversation.id, ctx))?.priorUsage;
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
    applyView(session, view.value, priorUsage);
    view.subscribe((value) => {
      applyView(session, value, priorUsage);
      if (value.entries !== entries) { entries = value.entries; void refresh(); }
      changed();
    });
    this.views.set(session.id, { get value() { return view.value; }, dispose: () => { view.dispose(); tasks.dispose(); } });
    await refresh();
  }

  private startTitle(session: Session, prompt: string, changed: () => void): void {
    if (this.closing || this.stopping.has(session.id) || session.titleRenamed) return;
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
      if (!title || abort.signal.aborted || this.closing || this.stopping.has(session.id) || session.titleRenamed || session.title !== original) return;
      session.title = title;
      this.store.save();
      changed();
    }).catch((error: unknown) => { this.report(error); }).finally(() => { this.titles.delete(session.id); });
    this.titles.set(session.id, { abort, done });
  }

  async run(session: Session, project: Project, prompt: string, changed: () => void, images: ImageAttachment[] = []): Promise<void> {
    if (this.closing) throw new Error("zz is closing.");
    if (this.undoProjects.has(session.projectId)) throw new Error("This project is being restored. Wait for /undo to finish.");
    if (this.pendingUndo(session.projectId)) throw new Error("An interrupted /undo in this project must finish before sending another prompt. Retry /undo.");
    if (this.stopping.has(session.id)) throw new Error("This session is still stopping. Try again when it is idle.");
    delete session.stopped;
    if (!session.pendingInput && session.work?.finishedAt !== undefined) session.work = undefined;
    session.work ??= { startedAt: Date.now() };
    if (!isImages(images)) throw new Error("Invalid image attachments; paste an image or use an @image path.");
    const input: PendingInput = { requestId: randomUUID(), prompt, ...(images.length ? { images: structuredClone(images) } : {}), whenBusy: this.store.settings.replyBehavior };
    if (!session.pendingInput) session.pendingInput = input;
    else (session.followUps ??= []).push(input);
    this.store.save();
    return this.startInput(session, project, input, changed);
  }

  private removeInput(session: Session, input: PendingInput): void {
    if (session.pendingInput?.requestId === input.requestId) session.pendingInput = session.followUps?.shift();
    else session.followUps = session.followUps?.filter((item) => item.requestId !== input.requestId);
    if (!session.followUps?.length) delete session.followUps;
  }

  private startInput(session: Session, project: Project, input: PendingInput, changed: () => void): Promise<void> {
    const previous = this.admissions.get(session.id) ?? Promise.resolve();
    const admitted = previous.then(() => this.admit(session, project, input, changed));
    // Only admission is serialized. Waiting here would turn this into a host-side queue.
    const tail = admitted.then(() => {}, () => {});
    this.admissions.set(session.id, tail);
    void tail.then(() => { if (this.admissions.get(session.id) === tail) this.admissions.delete(session.id); });
    const runs = this.active.get(session.id) ?? new Set<Promise<void>>();
    this.active.set(session.id, runs);
    const promise = admitted.then(async (submission) => {
      if (!submission) return;
      const result = await submission.wait(ctx);
      await this.contextUpdates.get(session.id);
      this.removeInput(session, input);
      if (result.status === "unanswered") throw new Error(`${result.reason}${result.detail ? `: ${JSON.stringify(result.detail)}` : ""}`);
    }).catch((error: unknown) => {
      if (!this.closing) this.removeInput(session, input);
      this.failure(session, error);
    }).finally(() => {
      runs.delete(promise);
      if (!runs.size) {
        this.active.delete(session.id);
        if (!this.closing) finishWork(session);
      }
      this.store.save();
      changed();
    });
    runs.add(promise);
    return promise;
  }

  private async admit(session: Session, project: Project, input: PendingInput, changed: () => void): Promise<Submission | undefined> {
    if (this.closing || this.stopping.has(session.id)) return;
    if (!input.prepared) {
      const references = referencedImages(input.prompt);
      if ((input.images?.length ?? 0) + references.length > MAX_ATTACHMENTS) throw new Error(`Attach at most ${MAX_ATTACHMENTS} images per message.`);
      const images = await Promise.all(references.map((path) => prepareImageFile(path, project.path)));
      // Save bytes with the prepared input: queued work and crash recovery never reread mutable source files.
      const prepared = await this.skills.prepare(project.path, input.prompt);
      input.images = [...(input.images ?? []), ...images];
      input.prepared = prepared;
      this.store.save();
    }
    if (input.images?.length) {
      if (!this.supportsImages(session)) throw new Error("This model does not accept images. Choose an image-capable model with /model, then resend.");
    }
    let conversation = this.handles.get(session.id);
    if (!conversation) {
      const config = this.configuration(session);
      if (!config.model) throw new Error("No model configured. Use /login to sign in, then /model to select a model.");
      const model = this.models.getModel(config.model.provider, config.model.modelId);
      if (!model) throw new Error(`Unknown model ${config.model.provider}/${config.model.modelId}. Choose one with --model.`);
      if (!await this.models.checkAuth(config.model.provider)) throw new Error(`Not logged in to ${config.model.provider}. Use /login ${config.model.provider}.`);
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
    return conversation.submit({ type: "input", content: input.images?.length ? [{ type: "text", text: input.prepared.content }, ...input.images.map(({ data, mimeType }) => ({ type: "image" as const, data, mimeType }))] : input.prepared.content, requestId: input.requestId, whenBusy: input.whenBusy ?? "followUp",
      entry: input.prepared.skill || input.images?.length ? { kind: input.prepared.skill ? "zz.skill" : "zz.input", data: { prompt: input.prompt, ...(input.prepared.skill ? { skill: input.prepared.skill } : {}), ...(input.images?.length ? { imageNames: input.images.map((image) => image.name ?? "image") } : {}) } } : undefined,
    }, ctx);
  }

  compact(session: Session, instructions: string | undefined, changed: () => void): Promise<CompactResult> {
    if (this.undoProjects.has(session.projectId) || this.pendingUndo(session.projectId)) return Promise.reject(new Error("Finish /undo before compacting this session."));
    if (this.closing) return Promise.reject(new Error("zz is closing."));
    if (this.stopping.has(session.id)) return Promise.reject(new Error("This session is still stopping."));
    if (this.manualCompactions.has(session.id) || session.compactions?.length) {
      return Promise.reject(new Error("This session is already compacting."));
    }
    const conversation = this.handles.get(session.id);
    if (!conversation) return Promise.reject(new Error("No conversation to compact. Send a task first."));
    const promise = this.compactConversation(session, conversation, instructions, changed).finally(() => {
      this.manualCompactions.delete(session.id);
      this.store.save();
      changed();
    });
    this.manualCompactions.set(session.id, promise);
    return promise;
  }

  private async compactConversation(session: Session, conversation: Conversation, instructions: string | undefined, changed: () => void): Promise<CompactResult> {
    try {
      await this.observe(session, conversation, changed);
      if (this.closing || this.stopping.has(session.id)) return "aborted";
      const id = await conversation.compact(instructions?.trim() || undefined, ctx);
      const { outcome } = (await this.harness.waitForTask(id, ctx)).state;
      if (outcome.status === "aborted") return "aborted";
      if (outcome.status !== "completed") {
        throw new Error(outcome.status === "orphaned" ? outcome.reason : outcome.error.message);
      }
      const submissionId = outcome.result.submissionId;
      if (submissionId !== undefined) {
        // Completing the summary request isn't success until its write reaches a safe turn boundary.
        const submission = await this.harness.submission(submissionId, ctx);
        if (!submission) throw new Error("Compaction summary submission is missing.");
        const placed = await submission.wait(ctx);
        if (placed.status === "unanswered") {
          if (placed.reason === "stale") return "stale";
          throw new Error(`Compaction summary was not applied: ${placed.reason}`);
        }
      }
      await this.contextUpdates.get(session.id);
      return submissionId !== undefined || outcome.result.entryId !== undefined ? "compacted" : "unchanged";
    } catch (error) {
      if (this.closing) return "aborted";
      throw error;
    }
  }

  private pendingUndo(projectId: string): boolean {
    return this.store.state.sessions.some((session) => session.projectId === projectId && this.undoPending.has(session.id));
  }

  async undoCheckpoints(session: Session): Promise<UndoCheckpoint[]> {
    const conversation = this.handles.get(session.id);
    return conversation ? this.undoHistory.checkpoints(conversation.id) : [];
  }

  undo(session: Session, checkpointId: string, changed: () => void): Promise<UndoResult> {
    if (this.store.state.sessions.some((other) => other.projectId === session.projectId && other.id !== session.id && this.undoPending.has(other.id))) {
      return Promise.reject(new Error("Finish the interrupted /undo in this project's other session first."));
    }
    if (this.closing) return Promise.reject(new Error("zz is closing."));
    if (this.undoProjects.has(session.projectId)) return Promise.reject(new Error("This project is already being restored."));
    this.undoProjects.add(session.projectId);
    const promise = this.undoSession(session, checkpointId, changed).finally(() => {
      this.undoProjects.delete(session.projectId);
      this.undoing.delete(session.id);
    });
    this.undoing.set(session.id, promise);
    return promise;
  }

  private async undoSession(session: Session, checkpointId: string, changed: () => void): Promise<UndoResult> {
    const conversation = this.handles.get(session.id);
    if (!conversation) throw new Error("Nothing to undo. Send a task first.");
    for (const other of this.store.state.sessions.filter((item) => item.projectId === session.projectId)) {
      const view = this.views.get(other.id)?.value;
      const live = view?.docs["pi.live"] as LiveState | undefined;
      if (this.active.has(other.id) || this.stopping.has(other.id) || live?.run || live?.compactions?.length
        || other.pendingInput || other.followUps?.length || other.queuedInputs?.length || this.manualCompactions.has(other.id)) {
        throw new Error("Wait for this project's sessions to finish, or /stop them, before /undo.");
      }
    }
    const state = await this.harness.snapshot(UndoDoc, conversation.id, ctx);
    const index = state?.points.findIndex((point) => point.id === checkpointId) ?? -1;
    const point = state?.points[index];
    if (!point) throw new Error("No undo checkpoint with that ID in this conversation. Reopen /undo and choose a checkpoint.");
    const pendingId = state?.restoring ? state.restoreTo ?? state.points.at(-1)?.id : undefined;
    if (pendingId && pendingId !== checkpointId) throw new Error("Finish restoring the previously selected checkpoint before choosing another.");
    const points = state!.points.slice(index);
    this.undoHistory.preflight(points);
    // Persist the SELECTED target, not just the latest turn, for crash recovery.
    await conversation.commit(async (tx) => {
      const doc = await tx.doc(UndoDoc, conversation.id);
      doc.restoring = true;
      doc.restoreTo = checkpointId;
    }, ctx);
    this.undoPending.add(session.id);
    const restored = this.undoHistory.restore(points);
    const title = this.titles.get(session.id);
    title?.abort.abort();
    await title?.done;
    await this.contextUpdates.get(session.id);
    const config = await conversation.agent(ctx);
    const priorUsage = session.usage && structuredClone(session.usage);
    const options = {
      ownership: { kind: "ownerless" as const },
      agent: { cwd: config.cwd, ...this.configuration(session) },
      init: async (tx: Tx, id: ConversationId) => {
        // Atomic ownership migration lets restore() recover even if state.json wasn't saved.
        (await tx.doc(SessionMeta, conversation.id)).sessionId = "";
        const meta = await tx.doc(SessionMeta, id);
        meta.sessionId = session.id;
        if (priorUsage) meta.priorUsage = priorUsage;
        const undo = await tx.doc(UndoDoc, id);
        undo.points = structuredClone(state!.points.slice(0, index));
        delete undo.restoring;
        delete undo.restoreTo;
      },
    };
    const fork = point.at === undefined ? await this.harness.createConversation(options, ctx)
      : await conversation.fork(point.at as EntryId, options, ctx);
    this.views.get(session.id)?.dispose();
    this.views.delete(session.id);
    this.handles.set(session.id, fork);
    session.conversationId = fork.id;
    delete session.stopped;
    delete session.work;
    session.status = "completed";
    await this.observe(session, fork, changed);
    this.undoPending.delete(session.id);
    session.preview = "Undone. Edit or resend your prompt to continue.";
    session.updatedAt = Date.now();
    this.store.save();
    changed();
    return { ...restored, prompt: point.prompt };
  }

  cancel(sessionId: string): Promise<void> {
    if (this.undoing.has(sessionId)) return Promise.reject(new Error("Wait for /undo to finish first."));
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
      if (session && (running || session.pendingInput || session.followUps?.length || session.queuedInputs?.length || session.status === "working")) {
        // Persist stop intent before aborting so a restart never resubmits this input.
        session.stopped = true;
        session.preview = "Stopping...";
        this.store.save();
      }
      const title = this.titles.get(sessionId);
      title?.abort.abort();
      const conversation = this.handles.get(sessionId) ?? (session?.conversationId !== undefined
        ? await this.harness.conversation(session.conversationId as ConversationId, ctx) : undefined);
      await Promise.all([conversation?.abort(ctx, { background: true }), ...(running ?? []), title?.done, this.manualCompactions.get(sessionId)?.catch(() => {})]);
      await this.contextUpdates.get(sessionId);
      if (session?.stopped) { markStopped(session); this.store.save(); }
    } finally { this.stopping.delete(sessionId); }
  }

  async stop(sessionId: string): Promise<void> {
    await this.undoing.get(sessionId);
    await this.cancel(sessionId);
    this.views.get(sessionId)?.dispose();
    this.views.delete(sessionId);
    this.handles.delete(sessionId);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    for (const title of this.titles.values()) title.abort.abort();
    // Let an admitted filesystem restore finish its conversation commit before sealing storage.
    const durableClose = Promise.allSettled([...this.undoing.values()]).then(() => this.harness.close(ctx));
    this.closePromise = (async () => {
      try {
        await durableClose;
        await Promise.allSettled([
          ...[...this.active.values()].flatMap((runs) => [...runs]),
          ...this.manualCompactions.values(), ...this.contextUpdates.values(),
        ]);
        await settleWithin(Promise.allSettled([...this.titles.values()].map((title) => title.done)), 250);
      } finally {
        for (const view of this.views.values()) view.dispose();
        this.views.clear();
      }
    })();
    return this.closePromise;
  }
}
