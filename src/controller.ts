import { randomUUID } from "node:crypto";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import { finishWork, isReplyBehavior, markStopped, rowId, rows, transcriptMessages, type ShellResponse, type ImageAttachment, type ReplyBehavior, type SettingsSelection, type AgentSettings, type CompactResult, type ModelOption, type Project, type Row, type Session, type SessionStats, type SkillOption, type UndoResult, type UndoCheckpoint } from "./model.js";
import { directory, isImages, Store } from "./store.js";
import { ShellRun } from "./shell.js";
import { AuthFlow, type AuthAccess, type AuthAction } from "./auth.js";
import type { CompactionPolicy } from "@earendil-works/pi-durable";
import { compactionPolicy, compactionSettingsError } from "./compaction-settings.js";
import { answerError, answerText, pendingQuestion, type QuestionForm, type QuestionAnswers } from "./questions.js";

export interface Engine {
  run(session: Session, project: Project, prompt: string, changed: () => void, images?: ImageAttachment[]): Promise<void>;
  compact(session: Session, instructions: string | undefined, changed: () => void): Promise<CompactResult>;
  undoCheckpoints(session: Session): Promise<UndoCheckpoint[]>;
  undo(session: Session, checkpointId: string, changed: () => void): Promise<UndoResult>;
  stop(sessionId: string): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  close(): Promise<void>;
  configuration(session?: Session): AgentSettings;
  stats(session?: Session): SessionStats;
  supportsImages?(session?: Session): boolean;
  listModels(): Promise<ModelOption[]>;
  configure(change: Partial<AgentSettings>, session?: Session): Promise<void>;
  listSkills(project: Project): Promise<SkillOption[]>;
}

export type Mode = "sessions" | "projects" | "session";
export type Dialog =
  | { kind: "auth"; flow: AuthFlow }
  | { kind: "peek"; sessionId: string }
  | { kind: "add-project" }
  | { kind: "rename-session"; sessionId: string }
  | { kind: "settings"; sessionId?: string; selected: SettingsSelection }
  | { kind: "model" | "thinking"; sessionId?: string; choices: ModelOption[]; returnToSettings?: boolean }
  | { kind: "skills"; sessionId?: string; skills: SkillOption[] }
  | { kind: "usage" | "tasks"; sessionId: string }
  | { kind: "undo"; sessionId: string; checkpoints: UndoCheckpoint[] }
  | { kind: "help" };

export class Controller {
  mode: Mode = "sessions";
  selection?: string;
  openedSessionId?: string;
  dialog?: Dialog;
  questionForm?: QuestionForm;
  pendingDelete?: string;
  private deleting = false;
  private deletingProjectId?: string;
  notice = "";
  onChange: () => void = () => {};
  private closing = false;
  private closePromise?: Promise<void>;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private pending = new Map<string, number>();
  private deletingSessions = new Set<string>();
  private cancelling = new Set<string>();
  private compacting = new Set<string>();
  private undoing = new Set<string>();
  private configuring = false;
  private clipboardQueue = Promise.resolve();
  private activeShell?: { projectId: string; sessionId: string; run: ShellRun };
  get shellRun(): ShellRun | undefined { return this.activeShell?.run; }

  constructor(readonly store: Store, readonly engine: Engine, readonly auth?: AuthAccess,
    private readonly writeClipboard: (text: string) => Promise<void> = copyToClipboard) {
    for (const session of store.state.sessions) {
      for (const response of session.shellResponses ?? []) {
        if (response.status === "running" || response.status === "stopping") {
          response.status = "interrupted";
          response.error = "Interrupted. This shell command was not restarted.";
          response.updatedAt = Math.max(response.updatedAt, Date.now());
        }
      }
      if (session.status === "working") {
        session.status = "paused";
        session.preview = "Interrupted. Open and reply to continue.";
      }
    }
    this.selection = this.currentRows.find((row) => row.project.id === store.state.selectedProjectId)
      ? `project:${store.state.selectedProjectId}` : this.currentRows[0] && rowId(this.currentRows[0]);
    store.save();
  }

  get currentRows(): Row[] { return rows(this.store.state, this.mode === "projects"); }
  get selected(): Row | undefined { return this.currentRows.find((row) => rowId(row) === this.selection); }
  get project(): Project | undefined {
    if (this.mode === "session") return this.store.state.projects.find((p) => p.id === this.opened?.projectId);
    return this.selected?.project;
  }
  get opened(): Session | undefined { return this.store.state.sessions.find((s) => s.id === this.openedSessionId); }
  session(id: string): Session | undefined { return this.store.state.sessions.find((s) => s.id === id); }
  get configuration(): AgentSettings { return this.engine.configuration(this.mode === "session" ? this.opened : undefined); }

  showAuth(action: AuthAction, provider?: string): void {
    if (this.closing) return;
    if (!this.auth) { this.fail("Authentication is unavailable in this runtime."); return; }
    if (this.dialog?.kind === "auth") this.dialog.flow.dispose();
    const flow = new AuthFlow(action, this.auth, () => this.changed(), async (providerId, operation) => {
      this.auth?.codexQuota?.invalidate(providerId);
      if (this.closing || flow.disposed || operation !== "login" || this.engine.configuration().model) return;
      const model = (await this.engine.listModels()).find((model) => model.provider === providerId);
      if (this.closing || flow.disposed || this.engine.configuration().model) return;
      if (!model) return "No models available yet for this provider; use /model after checking its configuration.";
      await this.engine.configure({ model: { provider: model.provider, modelId: model.modelId } });
      this.changed(true);
      return `New tasks use ${model.provider}/${model.modelId}.`;
    });
    this.dialog = { kind: "auth", flow };
    this.notice = "";
    this.changed();
    void flow.start(provider);
  }

  closeAuth(): void {
    if (this.dialog?.kind !== "auth") return;
    this.dialog.flow.dispose();
    this.dialog = undefined;
    this.changed();
  }

  showQuestions(sessionId?: string): void {
    const session = sessionId ? this.session(sessionId) : this.mode === "session" ? this.opened : this.selected?.kind === "session" ? this.selected.session : undefined;
    const request = pendingQuestion(session);
    if (!session || !request) { this.fail("No pending question form. Reply directly in the composer for a chat question."); return; }
    this.dialog = undefined;
    this.mode = "session";
    this.openedSessionId = session.id;
    this.selection = `session:${session.id}`;
    this.questionForm = { sessionId: session.id, request };
    this.notice = "";
    this.changed();
  }

  answerQuestions(sessionId: string, requestId: string, answers: QuestionAnswers): boolean {
    const request = pendingQuestion(this.session(sessionId));
    if (!request || request.id !== requestId) { this.fail("This question is no longer waiting for an answer."); return false; }
    const error = answerError(request, answers);
    if (error) { this.fail(error); return false; }
    return this.send(answerText(request, answers), sessionId);
  }

  showTasks(sessionId?: string): void {
    const session = sessionId ? this.session(sessionId) : this.mode === "session" ? this.opened : this.selected?.kind === "session" ? this.selected.session : undefined;
    if (!session) { this.fail("Open or select a session first to view /tasks."); return; }
    this.dialog = { kind: "tasks", sessionId: session.id };
    this.notice = "";
    this.changed();
  }

  showUsage(): void {
    const session = this.mode === "session" ? this.opened : this.selected?.kind === "session" ? this.selected.session : undefined;
    if (!session) { this.fail("Open or select a session first to view /session usage."); return; }
    this.dialog = { kind: "usage", sessionId: session.id };
    this.notice = "";
    this.changed();
  }

  copyResponse(argument = ""): Promise<void> {
    if (this.closing) return Promise.resolve();
    const value = argument.trim() || "1";
    const index = Number(value);
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(index)) {
      this.fail("Usage: /copy [N] — N must be a positive integer (1 = latest response).");
      return Promise.resolve();
    }
    const session = this.mode === "session" ? this.opened : this.selected?.kind === "session" ? this.selected.session : undefined;
    if (!session) { this.fail("Open or select a session first to copy a response."); return Promise.resolve(); }
    const responses = transcriptMessages(session).filter((message) => (message.role === "assistant" || message.role === "shell") && message.text.trim());
    const label = responses.every((message) => message.role === "assistant") ? "assistant response" : "response";
    const response = responses[responses.length - index];
    if (!response) {
      this.fail(responses.length ? `Only ${responses.length} ${label}${responses.length === 1 ? " is" : "s are"} available; cannot copy response ${index}.`
        : session.shellResponses?.length ? "No nonempty responses to copy yet." : "No assistant responses to copy yet.");
      return Promise.resolve();
    }
    // Snapshot before awaiting: streaming and navigation must not change what this invocation copies.
    const text = response.text;
    const mode = this.mode;
    const stillSelected = () => this.mode === mode && (mode === "session" ? this.openedSessionId === session.id
      : this.selected?.kind === "session" && this.selected.session.id === session.id);
    // Clipboard writes are serialized so rapid commands leave the last requested response on the clipboard.
    this.clipboardQueue = this.clipboardQueue.then(async () => {
      if (this.closing) return;
      try {
        await this.writeClipboard(text);
        if (!this.closing && stillSelected()) { this.notice = `Copied ${response.role === "shell" ? "shell" : "assistant"} response ${index} to clipboard.`; this.changed(); }
      } catch (error) {
        if (!this.closing && stillSelected()) this.fail(`Could not copy response: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    return this.clipboardQueue;
  }

  runShell(command: string, replyTo?: string): boolean {
    if (this.closing) return false;
    if (!command.trim()) { this.fail("Usage: !command (for example, !pwd)."); return false; }
    if (this.activeShell) { this.fail("A direct shell command is already running. Open its session and use /stop, or wait for it to finish."); return false; }
    let session = replyTo ? this.session(replyTo) : this.mode === "session" ? this.opened : this.selected?.kind === "session" ? this.selected.session : undefined;
    const project = session ? this.store.state.projects.find((project) => project.id === session!.projectId) : !replyTo ? this.project : undefined;
    if (!project) { this.fail("Select a project or open a session before running a shell command."); return false; }
    if (this.undoing.has(project.id)) { this.fail("Wait for this project's /undo to finish before running a shell command."); return false; }
    if (project.id === this.deletingProjectId || session && this.deletingSessions.has(session.id)) {
      this.fail("This session is being deleted. Wait before running a shell command."); return false;
    }
    let cwd: string;
    try { cwd = directory(project.path); }
    catch (error) { this.fail(error); return false; }
    const created = !session;
    const now = Date.now();
    if (!session) {
      session = { id: randomUUID(), projectId: project.id, title: `!${command.trim().replace(/\s+/g, " ")}`.slice(0, 80),
        status: "completed", preview: "Running shell command...", createdAt: now, updatedAt: now, messages: [], agent: this.engine.configuration() };
      this.store.state.sessions.push(session);
    }
    const timestamp = Math.max(now, session.messages.at(-1)?.timestamp ?? 0, session.shellResponses?.at(-1)?.timestamp ?? 0);
    const response: ShellResponse = { id: randomUUID(), command, cwd, text: "", timestamp, updatedAt: timestamp,
      status: "running", droppedBytes: 0, droppedLines: 0 };
    const previous = session.shellResponses;
    session.shellResponses = [...(previous ?? []), response];
    try { this.store.save(); }
    catch (error) {
      session.shellResponses = previous;
      if (created) this.store.state.sessions = this.store.state.sessions.filter((other) => other !== session);
      this.fail(error); return false;
    }
    const publish = () => {
      const output = run.output;
      response.text = output.text;
      response.status = run.phase;
      response.exitCode = run.exitCode;
      response.error = run.error;
      response.droppedBytes = output.droppedBytes;
      response.droppedLines = output.droppedLines;
      response.updatedAt = Math.max(response.updatedAt, Date.now());
      this.changed(true);
    };
    const run = new ShellRun(cwd, command, publish);
    this.activeShell = { projectId: project.id, sessionId: session.id, run };
    this.notice = "";
    if (this.dialog?.kind !== "peek") {
      this.dialog = undefined;
      this.mode = "session";
      this.openedSessionId = session.id;
      this.selection = `session:${session.id}`;
    }
    this.changed();
    void run.start().finally(() => {
      if (this.activeShell?.run === run) this.activeShell = undefined;
      try { this.store.save(); } catch (error) { this.fail(error); }
      this.changed();
    });
    return true;
  }

  showSettings(selected: SettingsSelection = "replyBehavior"): void {
    if (this.closing) return;
    this.dialog = { kind: "settings", sessionId: this.mode === "session" ? this.openedSessionId : undefined, selected };
    this.notice = "";
    this.changed();
  }

  toggleThinking(): void {
    if (this.closing) return;
    const previous = this.store.state.settings;
    this.store.state.settings = { ...this.store.settings, showThinking: this.store.settings.showThinking === false };
    try { this.store.save(); }
    catch (error) { this.store.state.settings = previous; this.fail(error); return; }
    this.notice = this.store.settings.showThinking ? "Thinking blocks shown (when the provider returns them)." : "Thinking blocks hidden.";
    this.changed();
  }

  setCompaction(change: Partial<CompactionPolicy>): boolean {
    if (this.closing) return false;
    const error = compactionSettingsError(change);
    if (error) { this.fail(error); return false; }
    const next = compactionPolicy({ ...this.store.compaction, ...change });
    const combinedError = compactionSettingsError(next);
    if (combinedError) { this.fail(combinedError); return false; }
    const previous = this.store.state.settings;
    this.store.state.settings = { ...this.store.settings, compaction: next };
    try { this.store.save(); }
    catch (error) { this.store.state.settings = previous; this.fail(error); return false; }
    this.notice = "";
    this.changed();
    return true;
  }

  setReplyBehavior(value: ReplyBehavior): boolean {
    if (this.closing) return false;
    if (!isReplyBehavior(value)) { this.fail("Choose follow-up or steer."); return false; }
    const previous = this.store.state.settings;
    this.store.state.settings = { ...this.store.settings, replyBehavior: value };
    try { this.store.save(); }
    catch (error) { this.store.state.settings = previous; this.fail(error); return false; }
    this.notice = "";
    this.changed();
    return true;
  }

  async settings(kind: "model" | "thinking"): Promise<void> {
    const sessionId = this.mode === "session" ? this.openedSessionId : undefined;
    const mode = this.mode;
    const previousDialog = this.dialog;
    const choices = await this.engine.listModels();
    if (this.closing || this.dialog !== previousDialog || this.mode !== mode || (mode === "session" && this.openedSessionId !== sessionId)) return;
    this.dialog = { kind, sessionId, choices, returnToSettings: previousDialog?.kind === "settings" || undefined };
    this.notice = "";
    this.changed();
  }

  async skills(): Promise<void> {
    const project = this.project;
    const mode = this.mode;
    const sessionId = mode === "session" ? this.openedSessionId : undefined;
    if (!project) { this.fail("Select a project first."); return; }
    const skills = await this.engine.listSkills(project);
    if (this.closing || this.mode !== mode || this.project?.id !== project.id || (mode === "session" && this.openedSessionId !== sessionId)) return;
    this.dialog = { kind: "skills", sessionId, skills };
    this.notice = "";
    this.changed();
  }

  async configure(change: Partial<AgentSettings>, sessionId?: string): Promise<boolean> {
    const session = sessionId ? this.session(sessionId) : undefined;
    if (this.closing || this.configuring) return false;
    if (sessionId && !session) { this.fail("Session no longer exists."); return false; }
    const thinkingOnly = change.thinkingLevel !== undefined && change.model === undefined;
    if (!thinkingOnly && session && (this.hasPendingRun(session)
      || session.compactions?.length || this.compacting.has(session.id))) {
      this.fail("Wait for this session to finish before changing its model or thinking."); return false;
    }
    this.configuring = true;
    const picker = this.dialog;
    try {
      await this.engine.configure(change, session);
      this.dialog = picker && (picker.kind === "model" || picker.kind === "thinking") && picker.returnToSettings
        ? { kind: "settings", sessionId: picker.sessionId, selected: picker.kind } : undefined;
      this.notice = "";
      this.changed(true);
      return true;
    } catch (error) { this.fail(error); return false; }
    finally { this.configuring = false; }
  }

  changed(persist = false): void {
    if (this.closing) return;
    if (persist && !this.saveTimer) this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      try { this.store.save(); } catch (error) { this.fail(error); }
    }, 200);
    this.onChange();
  }

  fail(error: unknown): void {
    this.notice = error instanceof Error ? error.message : String(error);
    this.changed();
  }

  select(id: string): void {
    this.pendingDelete = undefined;
    this.selection = id;
    const row = this.selected;
    if (row) this.store.state.selectedProjectId = row.project.id;
    this.notice = "";
    this.changed(true);
  }

  move(delta: number): void {
    const all = this.currentRows;
    const index = all.findIndex((row) => rowId(row) === this.selection);
    const next = all[Math.max(0, Math.min(all.length - 1, index + delta))];
    if (next) this.select(rowId(next));
  }

  reorderSession(delta: -1 | 1): void {
    const selected = this.selected;
    if (this.closing || this.mode !== "sessions" || selected?.kind !== "session") return;
    const sessions = this.currentRows.filter((row): row is Extract<Row, { kind: "session" }> =>
      row.kind === "session" && row.project.id === selected.project.id);
    const index = sessions.findIndex((row) => rowId(row) === this.selection);
    const next = index + delta;
    if (next < 0 || next >= sessions.length) return;
    const ids = sessions.map((row) => row.session.id);
    [ids[index], ids[next]] = [ids[next]!, ids[index]!];
    const previous = selected.project.sessionOrder;
    selected.project.sessionOrder = ids;
    try { this.store.save(); }
    catch (error) { selected.project.sessionOrder = previous; this.fail(error); return; }
    this.notice = "";
    this.changed();
  }

  showRenameSession(): void {
    const selected = this.selected;
    if (this.closing || this.mode !== "sessions" || selected?.kind !== "session" || this.deletingSessions.has(selected.session.id)) return;
    this.dialog = { kind: "rename-session", sessionId: selected.session.id };
    this.notice = "";
    this.changed();
  }

  renameSession(sessionId: string, title: string): boolean {
    const session = this.session(sessionId);
    if (this.closing || !session || this.deletingSessions.has(sessionId)) return false;
    title = title.replace(/\s+/g, " ").trim();
    if (!title) { this.fail("Enter a nonempty session name."); return false; }
    const previous = { title: session.title, titleRenamed: session.titleRenamed };
    session.title = title;
    session.titleRenamed = true;
    try { this.store.save(); }
    catch (error) { Object.assign(session, previous); this.fail(error); return false; }
    this.dialog = undefined;
    this.notice = "";
    this.changed();
    return true;
  }

  toggleProjects(): void {
    this.pendingDelete = undefined;
    const project = this.project;
    this.dialog = undefined;
    this.mode = this.mode === "projects" ? "sessions" : "projects";
    this.selection = project ? `project:${project.id}` : this.currentRows[0] && rowId(this.currentRows[0]);
    this.changed();
  }

  open(): void {
    const selected = this.selected;
    if (selected?.kind !== "session") return;
    this.pendingDelete = undefined;
    this.openedSessionId = selected.session.id;
    this.mode = "session";
    this.changed();
  }

  back(): void {
    this.pendingDelete = undefined;
    this.dialog = undefined;
    if (this.mode === "session") {
      this.selection = this.openedSessionId ? `session:${this.openedSessionId}` : this.selection;
      this.mode = "sessions";
    } else if (this.mode === "projects") this.mode = "sessions";
    this.changed();
  }

  escape(): void {
    if (this.mode === "session") { void this.cancel(); return; }
    this.back();
  }

  async compact(instructions?: string): Promise<void> {
    const session = this.mode === "session" ? this.opened : this.selected?.kind === "session" ? this.selected.session : undefined;
    if (!session) { this.fail("Open or select a session first to compact it."); return; }
    if (this.closing || this.cancelling.has(session.id)) return;
    if (this.compacting.has(session.id) || session.compactions?.length) {
      this.fail("This session is already compacting."); return;
    }
    this.compacting.add(session.id);
    this.notice = "Compacting context...";
    this.changed();
    try {
      const result = await this.engine.compact(session, instructions, () => this.changed(true));
      if (!this.closing) this.notice = result === "compacted" ? "Context compacted. History and usage totals are retained."
        : result === "unchanged" ? "Nothing to compact yet; recent context is kept verbatim."
        : result === "stale" ? "Summary superseded by a newer context; not applied." : "Compaction cancelled.";
    } catch (error) { if (!this.closing) this.fail(error); }
    finally { this.compacting.delete(session.id); this.changed(true); }
  }

  private undoTarget(): Session | undefined {
    return this.mode === "session" ? this.opened : this.selected?.kind === "session" ? this.selected.session : undefined;
  }

  private undoReady(session: Session): boolean {
    if (this.closing || this.undoing.has(session.projectId)) return false;
    const busy = this.store.state.sessions.some((other) => other.projectId === session.projectId
      && (this.canStop(other) || this.deletingSessions.has(other.id)));
    if (busy || this.configuring || this.activeShell?.projectId === session.projectId) { this.fail("Wait for this project's sessions and direct shell command to finish before /undo. Use /stop for agent work."); return false; }
    return true;
  }

  async showUndo(): Promise<void> {
    const session = this.undoTarget();
    if (!session) { this.fail("Open or select a session first to /undo."); return; }
    if (!this.undoReady(session)) return;
    const previousDialog = this.dialog;
    const mode = this.mode;
    try {
      const checkpoints = await this.engine.undoCheckpoints(session);
      if (this.closing || this.dialog !== previousDialog || this.mode !== mode || this.undoTarget()?.id !== session.id) return;
      if (!this.undoReady(session)) return;
      if (!checkpoints.length) { this.fail("No undo checkpoints yet. Only turns started after undo support was added can be restored."); return; }
      this.dialog = { kind: "undo", sessionId: session.id, checkpoints };
      this.notice = "";
      this.changed();
    } catch (error) { this.fail(error); }
  }

  async undo(checkpointId: string, sessionId: string): Promise<UndoResult | undefined> {
    const dialog = this.dialog;
    const session = this.session(sessionId);
    if (!session || dialog?.kind !== "undo" || dialog.sessionId !== sessionId
      || !dialog.checkpoints.some((point) => point.id === checkpointId)) {
      this.fail("Open /undo and select a checkpoint first."); return;
    }
    if (!this.undoReady(session)) return;
    this.undoing.add(session.projectId);
    this.notice = "Restoring the selected checkpoint...";
    this.changed();
    try {
      const result = await this.engine.undo(session, checkpointId, () => this.changed(true));
      if (this.dialog === dialog) this.dialog = undefined;
      this.notice = `Undone: conversation and ${result.files} tracked file${result.files === 1 ? "" : "s"} restored.`
        + (result.shell ? " Shell-command changes were NOT undone." : "");
      this.store.save();
      return result;
    } catch (error) { this.fail(error); }
    finally { this.undoing.delete(session.projectId); this.changed(); }
  }

  private hasPendingRun(session: Session): boolean {
    return session.status === "working" || !!session.pendingInput || !!session.followUps?.length
      || !!session.queuedInputs?.length || this.pending.has(session.id);
  }

  canStop(session: Session): boolean {
    return this.activeShell?.sessionId === session.id && this.activeShell.run.running || this.hasPendingRun(session) || !!session.compactions?.length || this.compacting.has(session.id)
      || this.cancelling.has(session.id);
  }

  async cancel(sessionId?: string): Promise<void> {
    const session = sessionId ? this.session(sessionId)
      : this.mode === "session" ? this.opened : this.selected?.kind === "session" ? this.selected.session : undefined;
    if (!session) { this.fail("Open or select a session first to stop it."); return; }
    if (this.closing || this.cancelling.has(session.id)) return;
    if (!this.canStop(session)) {
      this.notice = session.stopped ? "Stopped. Reply to continue." : "This session is already idle."; this.changed(); return;
    }
    const stoppingRun = this.hasPendingRun(session);
    const shell = this.activeShell?.sessionId === session.id ? this.activeShell.run : undefined;
    const stopAgent = stoppingRun || !!session.compactions?.length || this.compacting.has(session.id);
    shell?.cancel();
    this.cancelling.add(session.id);
    this.notice = "Stopping...";
    this.changed();
    try {
      await Promise.all([stopAgent ? this.engine.cancel(session.id) : undefined, shell?.done]);
      if (stoppingRun) markStopped(session);
      this.pending.delete(session.id);
      this.store.save();
      this.notice = stoppingRun ? "Stopped. Reply to continue." : shell ? "Shell command stopped." : "Compaction cancelled.";
    } catch (error) { this.fail(error); }
    finally { this.cancelling.delete(session.id); this.changed(); }
  }

  peek(): void {
    const selected = this.selected;
    if (selected?.kind === "session") {
      if (pendingQuestion(selected.session)) { this.showQuestions(selected.session.id); return; }
      this.dialog = { kind: "peek", sessionId: selected.session.id };
      this.changed();
    }
  }

  requestDelete(): void {
    if (this.mode === "session" || this.deleting) return;
    const selected = this.selected;
    if (selected && (selected.kind === "session" || this.store.state.sessions.some((s) => s.projectId === selected.project.id))) {
      this.pendingDelete = rowId(selected);
    }
    this.changed();
  }

  cancelDelete(): void {
    if (!this.pendingDelete) return;
    this.pendingDelete = undefined;
    this.changed();
  }

  async confirmDelete(): Promise<void> {
    const selected = this.selected;
    const target = this.pendingDelete;
    this.cancelDelete();
    if (!selected || target !== rowId(selected) || this.mode === "session" || this.deleting) return;
    const sessions = selected.kind === "session" ? [selected.session]
      : this.store.state.sessions.filter((s) => s.projectId === selected.project.id);
    const ids = new Set(sessions.map((s) => s.id));
    this.deleting = true;
    this.deletingProjectId = selected.kind === "project" ? selected.project.id : undefined;
    try {
      for (const id of ids) this.deletingSessions.add(id);
      const shell = this.activeShell && ids.has(this.activeShell.sessionId) ? this.activeShell.run : undefined;
      shell?.cancel();
      const results = await Promise.allSettled([...sessions.map((s) => this.engine.stop(s.id)), shell?.done]);
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      const index = this.currentRows.findIndex((row) => rowId(row) === this.selection);
      this.store.state.sessions = this.store.state.sessions.filter((s) => !ids.has(s.id));
      // Keep a surviving selection (including navigation during stop); otherwise stay at the same row.
      if (!this.selected) {
        const remaining = this.currentRows;
        const next = remaining[Math.max(0, Math.min(index, remaining.length - 1))];
        this.selection = next && rowId(next);
      }
      if (selected.kind === "project") this.notice = "Project sessions deleted. Project and files are kept.";
    } catch (error) {
      this.fail(error);
      return;
    } finally {
      for (const id of ids) this.deletingSessions.delete(id);
      this.deleting = false;
      this.deletingProjectId = undefined;
    }
    this.store.state.selectedProjectId = this.selected?.project.id;
    this.store.save();
    this.changed();
  }

  addProject(path: string): boolean {
    try {
      const project = this.store.addProject(path);
      this.selection = `project:${project.id}`;
      this.dialog = undefined;
      this.notice = "";
      this.changed();
      return true;
    } catch (error) { this.fail(error); return false; }
  }

  send(text: string, replyTo?: string, images: ImageAttachment[] = []): boolean {
    if (text.trimStart().startsWith("!")) return this.runShell(text.trimStart().slice(1), replyTo);
    if (!isImages(images)) { this.fail("Invalid image attachments. Paste an image or use an @image path."); return false; }
    text = text.trim() || (images.length ? "Describe the attached image(s)." : "");
    if (!text || this.closing || this.configuring) return false;
    const target = replyTo ?? (this.mode === "session" ? this.openedSessionId : undefined);
    let session = target ? this.session(target) : undefined;
    const project = target
      ? this.store.state.projects.find((p) => p.id === session?.projectId)
      : this.project;
    if (!project || (target && !session)) { this.fail("Select a project first. Use /projects to add one."); return false; }
    if (images.length && this.engine.supportsImages?.(session) === false) {
      this.fail("This model does not accept images. Choose an image-capable model with /model."); return false;
    }
    if (this.undoing.has(project.id)) { this.fail("This project is being restored. Wait for /undo to finish."); return false; }
    if (project.id === this.deletingProjectId) { this.fail("This project's sessions are being deleted."); return false; }
    if (target && (this.cancelling.has(target) || this.deletingSessions.has(target))) {
      this.fail("This session is stopping. Wait until it is idle before sending another.");
      return false;
    }
    const busy = !!session && this.hasPendingRun(session);
    if (!session) {
      const now = Date.now();
      session = {
        id: randomUUID(), projectId: project.id, title: text.replace(/\s+/g, " ").slice(0, 80),
        status: "working", preview: "Starting...", createdAt: now, updatedAt: now, messages: [],
        agent: this.engine.configuration(),
      };
      this.store.state.sessions.push(session);
      // Roll back creation if the initial state cannot be persisted, before any tools run.
      try { this.store.save(); } catch (error) {
        this.store.state.sessions = this.store.state.sessions.filter((s) => s !== session);
        this.fail(error); return false;
      }
      this.selection = `session:${session.id}`;
    }
    if (!busy) {
      session.messages.push({ role: "user", text, timestamp: Date.now(), ...(images.length ? { images } : {}) });
      delete session.stopped;
      session.status = "working";
      session.preview = "Starting...";
      session.updatedAt = Date.now();
      session.work = { startedAt: session.updatedAt };
    }
    this.notice = "";
    this.dialog = undefined;
    const active = session;
    this.pending.set(active.id, (this.pending.get(active.id) ?? 0) + 1);
    void this.engine.run(active, project, text, () => this.changed(true), images)
      .catch((error: unknown) => {
        active.status = "failed";
        active.preview = error instanceof Error ? error.message : String(error);
        active.messages.push({ role: "error", text: active.preview, timestamp: Date.now() });
      }).finally(() => {
        const remaining = (this.pending.get(active.id) ?? 1) - 1;
        if (remaining > 0) this.pending.set(active.id, remaining);
        else { this.pending.delete(active.id); finishWork(active); }
        this.changed(true);
      });
    this.changed(true);
    return true;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.auth?.codexQuota?.close();
    const shell = this.activeShell?.run;
    shell?.cancel();
    if (this.dialog?.kind === "auth") this.dialog.flow.dispose();
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.closePromise = Promise.all([this.engine.close(), shell?.done]).then(() => {}).finally(() => this.store.save());
    return this.closePromise;
  }
}
