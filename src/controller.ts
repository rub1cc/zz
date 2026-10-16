import { randomUUID } from "node:crypto";
import { finishWork, markStopped, rowId, rows, type AgentSettings, type ModelOption, type Project, type Row, type Session, type SessionStats, type SkillOption } from "./model.js";
import { Store } from "./store.js";

export interface Engine {
  run(session: Session, project: Project, prompt: string, changed: () => void): Promise<void>;
  stop(sessionId: string): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  close(): Promise<void>;
  configuration(session?: Session): AgentSettings;
  stats(session?: Session): SessionStats;
  listModels(): Promise<ModelOption[]>;
  configure(change: Partial<AgentSettings>, session?: Session): Promise<void>;
  listSkills(project: Project): Promise<SkillOption[]>;
}

export type Mode = "sessions" | "projects" | "session";
export type Dialog =
  | { kind: "peek"; sessionId: string }
  | { kind: "delete"; sessionId: string }
  | { kind: "remove-project"; projectId: string }
  | { kind: "add-project" }
  | { kind: "model" | "thinking"; sessionId?: string; choices: ModelOption[] }
  | { kind: "skills"; sessionId?: string; skills: SkillOption[] }
  | { kind: "usage"; sessionId: string }
  | { kind: "help" };

export class Controller {
  mode: Mode = "sessions";
  selection?: string;
  openedSessionId?: string;
  dialog?: Dialog;
  notice = "";
  onChange: () => void = () => {};
  private closing = false;
  private closePromise?: Promise<void>;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private pending = new Set<string>();
  private cancelling = new Set<string>();
  private configuring = false;
  private thinkingQueue = Promise.resolve();

  constructor(readonly store: Store, readonly engine: Engine) {
    for (const session of store.state.sessions) {
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

  showUsage(): void {
    const session = this.mode === "session" ? this.opened : this.selected?.kind === "session" ? this.selected.session : undefined;
    if (!session) { this.fail("Open or select a session first to view /session usage."); return; }
    this.dialog = { kind: "usage", sessionId: session.id };
    this.notice = "";
    this.changed();
  }

  async settings(kind: "model" | "thinking"): Promise<void> {
    const sessionId = this.mode === "session" ? this.openedSessionId : undefined;
    const mode = this.mode;
    const choices = await this.engine.listModels();
    if (this.closing || this.mode !== mode || (mode === "session" && this.openedSessionId !== sessionId)) return;
    this.dialog = { kind, sessionId, choices };
    this.notice = "";
    this.changed();
  }

  cycleThinking(): Promise<void> {
    const mode = this.mode;
    const sessionId = mode === "session" ? this.openedSessionId : undefined;
    this.thinkingQueue = this.thinkingQueue.then(async () => {
      if (this.closing || this.mode !== mode || (mode === "session" && this.openedSessionId !== sessionId)) return;
      const session = sessionId ? this.session(sessionId) : undefined;
      const choices = await this.engine.listModels();
      if (this.closing || this.mode !== mode || (mode === "session" && this.openedSessionId !== sessionId)) return;
      const current = this.engine.configuration(session);
      const levels = choices.find((model) => model.provider === current.model?.provider && model.modelId === current.model.modelId)?.thinkingLevels;
      if (!levels?.length) { this.fail("Choose an available model with /model first."); return; }
      const next = levels[(levels.indexOf(current.thinkingLevel) + 1) % levels.length]!;
      if (await this.configure({ thinkingLevel: next }, sessionId)) {
        this.notice = levels.length === 1 ? `This model supports thinking ${next} only.`
          : `Thinking ${next}${session?.status === "working" ? " / applies to the next model request" : ""}`;
        this.changed();
      }
    }).catch((error: unknown) => this.fail(error));
    return this.thinkingQueue;
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
    if (!thinkingOnly && session && (session.status === "working" || this.pending.has(session.id))) {
      this.fail("Wait for this session to finish before changing its model or thinking."); return false;
    }
    this.configuring = true;
    try {
      await this.engine.configure(change, session);
      this.dialog = undefined;
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

  toggleProjects(): void {
    const project = this.project;
    this.dialog = undefined;
    this.mode = this.mode === "projects" ? "sessions" : "projects";
    this.selection = project ? `project:${project.id}` : this.currentRows[0] && rowId(this.currentRows[0]);
    this.changed();
  }

  open(): void {
    const selected = this.selected;
    if (selected?.kind !== "session") return;
    this.openedSessionId = selected.session.id;
    this.mode = "session";
    this.changed();
  }

  back(): void {
    this.dialog = undefined;
    if (this.mode === "session") {
      this.selection = this.openedSessionId ? `session:${this.openedSessionId}` : this.selection;
      this.mode = "sessions";
    } else if (this.mode === "projects") this.mode = "sessions";
    this.changed();
  }

  escape(): void {
    if (this.mode === "session") {
      void this.cancel(this.openedSessionId); return;
    }
    this.back();
  }

  canStop(session: Session): boolean {
    return session.status === "working" || this.pending.has(session.id) || this.cancelling.has(session.id);
  }

  async cancel(sessionId?: string): Promise<void> {
    const session = sessionId ? this.session(sessionId)
      : this.mode === "session" ? this.opened : this.selected?.kind === "session" ? this.selected.session : undefined;
    if (!session) { this.fail("Open or select a session first to stop it."); return; }
    if (this.closing || this.cancelling.has(session.id)) return;
    if (!this.canStop(session)) {
      this.notice = session.stopped ? "Stopped. Reply to continue." : "This session is already idle."; this.changed(); return;
    }
    this.cancelling.add(session.id);
    this.notice = "Stopping...";
    this.changed();
    try {
      await this.engine.cancel(session.id);
      markStopped(session);
      this.pending.delete(session.id);
      this.store.save();
      this.notice = "Stopped. Reply to continue.";
    } catch (error) { this.fail(error); }
    finally { this.cancelling.delete(session.id); this.changed(); }
  }

  peek(): void {
    const selected = this.selected;
    if (selected?.kind === "session") {
      this.dialog = { kind: "peek", sessionId: selected.session.id };
      this.changed();
    }
  }

  requestDelete(): void {
    if (this.mode === "session") return;
    const selected = this.selected;
    if (selected?.kind === "session") this.dialog = { kind: "delete", sessionId: selected.session.id };
    else if (this.mode === "projects" && selected) this.dialog = { kind: "remove-project", projectId: selected.project.id };
    this.changed();
  }

  async confirmDelete(): Promise<void> {
    const dialog = this.dialog;
    this.dialog = undefined;
    if (dialog?.kind === "delete") {
      try {
        this.pending.add(dialog.sessionId);
        await this.engine.stop(dialog.sessionId);
        this.store.state.sessions = this.store.state.sessions.filter((s) => s.id !== dialog.sessionId);
        this.pending.delete(dialog.sessionId);
      } catch (error) {
        this.pending.delete(dialog.sessionId);
        this.fail(error);
        return;
      }
    } else if (dialog?.kind === "remove-project") {
      this.store.state.projects = this.store.state.projects.filter((p) => p.id !== dialog.projectId);
      this.notice = "Project removed from the list. Files and session history are kept.";
    } else return;
    this.selection = this.currentRows[0] && rowId(this.currentRows[0]);
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

  send(text: string, replyTo?: string): boolean {
    text = text.trim();
    if (!text || this.closing || this.configuring) return false;
    const target = replyTo ?? (this.mode === "session" ? this.openedSessionId : undefined);
    let session = target ? this.session(target) : undefined;
    const project = target
      ? this.store.state.projects.find((p) => p.id === session?.projectId)
      : this.project;
    if (!project || (target && !session)) { this.fail("Select a project first. Use ctrl+o to add one."); return false; }
    if (session?.status === "working" || (target && (this.pending.has(target) || this.cancelling.has(target)))) {
      this.fail("This session is still working. Wait for its reply before sending another.");
      return false;
    }
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
    session.messages.push({ role: "user", text, timestamp: Date.now() });
    delete session.stopped;
    session.status = "working";
    session.preview = "Starting...";
    session.updatedAt = Date.now();
    session.work = { startedAt: session.updatedAt };
    this.notice = "";
    this.dialog = undefined;
    const active = session;
    this.pending.add(active.id);
    void this.engine.run(active, project, text, () => this.changed(true))
      .catch((error: unknown) => {
        active.status = "failed";
        active.preview = error instanceof Error ? error.message : String(error);
        active.messages.push({ role: "error", text: active.preview, timestamp: Date.now() });
      }).finally(() => { finishWork(active); this.pending.delete(active.id); this.changed(true); });
    this.changed(true);
    return true;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.closePromise = this.engine.close().finally(() => this.store.save());
    return this.closePromise;
  }
}
