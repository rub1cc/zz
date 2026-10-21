import {
  Input, Key, ScrollView, VStack, getKeybindings, matchesKey, visibleWidth, wrapTextWithAnsi,
  type Component, type Focusable, type OverlayHandle,
  type TuiAltScreen, type TuiMouseEvent, type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { Controller } from "./controller.js";
import { activityTimestamp, displayStatus, sessionPreview, transcriptMessages, lastReplyMessage, age, lastReply, rowId, type ImageAttachment, type ReplyBehavior, type Session, type Row } from "./model.js";
import { displayPath } from "./store.js";
import { accent, bold, dim, fit, green, markdown, oneLine, pad, red, warning, workingIcon } from "./format.js";
import { StickyPrompt } from "./sticky-prompt.js";
import { Transcript } from "./transcript.js";
import { AdaptiveWheelScroll } from "./scroll.js";
import { SettingsDialog } from "./settings-dialog.js";
import { SettingsPage } from "./settings-page.js";
import { renderShellResponse } from "./shell-response.js";
import { AuthDialog } from "./auth-dialog.js";
import { UndoDialog } from "./undo-dialog.js";
import { QuestionComposer } from "./question-composer.js";
import { pendingQuestion } from "./questions.js";
import { Composer } from "./composer.js";
import { DirectoryInput } from "./directory-input.js";
import { composerCommands } from "./discovery.js";
import { composerStatus, usageDetails } from "./usage.js";
import { TaskDisplay, taskDetails, taskProgress, taskVisibleLimit, type TaskDisplayClock } from "./task-display.js";
import { GitBranches } from "./git-branches.js";
import { WorkspaceDialog } from "./workspace-dialog.js";
import { version } from "./version.js";

export const scrollToEndIndicator = () => accent("[ Scroll to bottom (/bottom) ]");

function promptHistory(session: Session | undefined): string[] {
  return session ? transcriptMessages(session).flatMap((message) => message.role === "user" ? [message.text]
    : message.role === "shell" ? [`!${message.shell.command}`] : []) : [];
}

function queueHint(session: Session | undefined, behavior: ReplyBehavior): string | undefined {
  if (session?.status !== "working" && !session?.queuedInputs?.length) return;
  return `Enter queues ${behavior === "steer" ? "steering" : "a follow-up"}${session?.queuedInputs?.length ? ` / ${session.queuedInputs.length} queued` : ""}`;
}

class Dynamic implements Component {
  constructor(readonly draw: (width: number) => string[], readonly mouse?: (event: TuiMouseEvent) => TuiMouseEventResult | undefined) {}
  render(width: number): string[] { return this.draw(width).map((line) => fit(line, width)); }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined { return this.mouse?.(event); }
  invalidate(): void {}
}

class SessionList extends Dynamic {
  positions = new Map<string, number>();
  rename?: { sessionId: string; input: Input };
  renameHeight = 0;
  private hits = new Map<number, Row>();
  readonly transcript: Transcript;

  constructor(readonly controller: Controller, private readonly branches: GitBranches) {
    super((width) => this.drawList(width));
    this.transcript = new Transcript(controller, () => controller.changed());
  }

  override render(width: number): string[] {
    // Transcript rows are already width-safe; do not refit the entire history on scroll.
    if (this.controller.mode === "session" && this.controller.opened) return this.transcript.render(width);
    return super.render(width);
  }

  private drawList(width: number): string[] {
    const c = this.controller;
    this.hits.clear();
    this.positions.clear();
    this.renameHeight = 0;
    const lines: string[] = [];
    const rows = c.currentRows;
    const titleOf = (session: Session) => {
      const workspace = c.store.workspace(session);
      const branch = workspace?.status === "ready" ? this.branches.value(workspace.path) : undefined;
      return `${oneLine(session.title)}${workspace?.kind === "worktree" ? ` [${oneLine(branch ?? c.workspaceLabel(session))}]` : ""}`;
    };
    const titleWidths = new Map<string, number>();
    for (const row of rows) {
      if (row.kind === "session") titleWidths.set(row.project.id,
        Math.max(titleWidths.get(row.project.id) ?? 0, visibleWidth(titleOf(row.session))));
    }
    for (const row of rows) {
      if (row.kind === "project" && lines.length) lines.push("");
      const id = rowId(row);
      this.positions.set(id, lines.length);
      const selected = c.selection === id;
      const confirmation = row.kind === "session" && (c.pendingDelete === id || c.pendingDelete === `project:${row.project.id}`)
        ? "ctrl+x again to delete" : undefined;
      let rowLines: string[];
      if (row.kind === "project") {
        const count = c.store.state.sessions.filter((s) => s.projectId === row.project.id).length;
        const branch = this.branches.value(row.project.path);
        const collapsed = c.mode === "sessions" && c.collapsedProjects.has(row.project.id);
        const metadata = `${branch ? `  [${oneLine(branch)}]` : ""}  ${count} session${count === 1 ? "" : "s"}${collapsed ? " (collapsed)" : ""}`;
        const pathWidth = Math.max(8, width - visibleWidth(metadata) - 2);
        const heading = `${selected ? ">" : " "} ${bold(fit(oneLine(displayPath(row.project.path)), pathWidth))}`;
        rowLines = [`${heading}${dim(metadata)}`];
        if (c.pendingProjectRemoval === row.project.id) {
          rowLines.push(...wrapTextWithAnsi(red("r again to remove from list (files and sessions kept); any other key cancels"), Math.max(1, width)));
        }
      } else {
        const { session } = row;
        const status = displayStatus(session);
        const symbol = status === "working" ? accent(workingIcon()) : status === "needs-input" ? warning("?")
          : status === "failed" ? warning("!") : status === "paused" ? dim("-") : green("∙");
        if (this.rename?.sessionId === session.id) {
          const prefix = width >= 6 ? `  ${symbol} ` : "";
          const indent = width >= 6 ? "    " : "";
          rowLines = [
            ...this.rename.input.render(Math.max(1, width - visibleWidth(prefix))).map((line) => `${prefix}${line}`),
            ...wrapTextWithAnsi(c.notice ? warning(oneLine(c.notice)) : dim("enter save / esc cancel"), Math.max(1, width - indent.length))
              .map((line) => `${indent}${line}`),
          ];
          this.renameHeight = rowLines.length;
        } else {
          const progress = taskProgress(session.tasks);
          const time = `${progress ? `${progress}  ` : ""}${age(activityTimestamp(session))}`;
          const title = titleOf(session);
          const titleWidth = titleWidths.get(row.project.id)!;
          const label = status === "completed" ? "Done" : status === "needs-input" ? "Needs input"
            : status === "working" ? "Working" : status === "failed" ? "Failed" : "Paused";
          const state = status === "completed" ? green(label) : status === "working" ? label
            : status === "paused" ? dim(label) : warning(label);
          const previewWidth = Math.max(0, width - titleWidth - label.length - time.length - 13);
          if (previewWidth > 8 && (!confirmation || previewWidth >= confirmation.length)) {
            const preview = confirmation
              ? red(pad(confirmation, previewWidth))
              : dim(pad(fit(oneLine(sessionPreview(session)), previewWidth), previewWidth));
            rowLines = [`  ${symbol} ${pad(title, titleWidth)}  ${state}${dim(" · ")}${preview}  ${dim(time)}`];
          } else {
            const indent = width >= 6 ? "    " : "";
            rowLines = wrapTextWithAnsi(title, Math.max(1, width - indent.length))
              .map((part, index) => `${index === 0 && indent ? `  ${symbol} ` : indent}${part}`);
            if (progress) rowLines.push(fit(`${indent}${dim(`${progress} tasks`)}`, width));
            if (confirmation) rowLines.push(...wrapTextWithAnsi(red(confirmation), Math.max(1, width - indent.length))
              .map((part) => `${indent}${part}`));
          }
        }
      }
      // Keep selection and mouse targets across every wrapped title line.
      const background = "\x1b[48;5;254m";
      const foreground = "\x1b[38;5;236m";
      for (const rowLine of rowLines) {
        const line = fit(rowLine, width);
        this.hits.set(lines.length, row);
        lines.push(selected ? `${background}${foreground}${pad(line, width)
          .replaceAll("\x1b[0m", `\x1b[0m${background}${foreground}`)
          .replaceAll("\x1b[39m", foreground)}\x1b[39m\x1b[49m` : line);
      }
    }
    if (!lines.length) lines.push("  No projects. Press a to add a directory.");
    else if (c.mode === "sessions" && !c.store.state.sessions.some((s) => c.store.state.projects.some((p) => p.id === s.projectId))) {
      lines.push("", dim("  Describe a task below to start your first session."));
    }
    return lines;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.controller.dialog) return;
    if (this.controller.mode === "session") return this.transcript.handleMouse(event);
    if (event.type !== "move" && event.type !== "click") return;
    const row = this.hits.get(event.y);
    if (!row) return;
    const id = rowId(row);
    if (id !== this.controller.selection) this.controller.select(id);
    if (event.type === "click" && event.clickCount === 2 && row.kind === "session") this.controller.open();
    return { handled: true, render: true };
  }

  invalidate(): void { this.transcript.invalidate(); }
}

class SessionListScroll extends ScrollView {
  constructor(readonly list: SessionList) {
    super(list, { primary: true, follow: "none", scrollbar: "auto" });
  }

  override updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void {
    super.updateLayout(contentHeight, viewportHeight, requestRender);
    if (!this.list.rename || !viewportHeight) return;
    const line = this.list.positions.get(`session:${this.list.rename.sessionId}`);
    if (line === undefined) return;
    // Use current layout metrics so resize and newly expanded rows keep the input visible.
    const height = Math.min(this.list.renameHeight, viewportHeight);
    if (line < this.scrollTop) this.scrollTo(line);
    else if (line + height > this.scrollTop + viewportHeight) this.scrollTo(line + height - viewportHeight);
  }
}

class ContextScroll extends ScrollView {
  onLayout?: () => void;
  override updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void {
    super.updateLayout(contentHeight, viewportHeight, requestRender);
    this.onLayout?.();
  }
}

export class Dashboard extends VStack implements Focusable {
  readonly composer: Composer;
  readonly body: SessionList;
  readonly chatScroll: ScrollView;
  readonly stickyPrompt: StickyPrompt;
  readonly listScroll: ScrollView;
  private readonly bodyHost = new VStack();
  private readonly wheelScroll = new AdaptiveWheelScroll();
  private readonly taskDisplay: TaskDisplay;
  private readonly branches: GitBranches;
  get scroll(): ScrollView { return this.controller.mode === "session" ? this.chatScroll : this.listScroll; }
  private overlay?: OverlayHandle;
  private activeDialog?: Controller["dialog"];
  private dismissedQuestions = new Set<string>();
  private questionViews = new Map<string, QuestionComposer>();
  private questionComposer?: QuestionComposer;
  private _focused = false;
  private previousMode?: string;
  private previousSelection?: string;
  private previousSessionId?: string;

  get focused(): boolean { return this._focused; }
  set focused(value: boolean) {
    this._focused = value;
    this.syncFocus();
  }

  private syncFocus(): void {
    this.composer.focused = this.focused && !this.questionComposer && !this.body.rename;
    if (this.body.rename) this.body.rename.input.focused = this.focused;
    if (this.questionComposer) this.questionComposer.focused = this.focused && !this.controller.dialog;
  }

  constructor(readonly controller: Controller, readonly tui: TuiAltScreen, readonly quit: () => void, taskClock?: TaskDisplayClock) {
    super();
    this.taskDisplay = new TaskDisplay(() => tui.requestRender(), taskClock);
    this.branches = new GitBranches(() => tui.requestRender());
    // The viewport handles this binding before dashboard input; use /bottom instead.
    const keybindings = getKeybindings();
    keybindings.setUserBindings({ ...keybindings.getUserBindings(), "tui.altScreen.bottom": [] });
    this.composer = new Composer(tui, "describe a task for a new session", (error) => controller.fail(error));
    this.body = new SessionList(controller, this.branches);
    this.listScroll = new SessionListScroll(this.body);
    const chatScroll = new ContextScroll(this.body, { primary: true, follow: "end", scrollbar: "auto" });
    this.chatScroll = chatScroll;
    this.stickyPrompt = new StickyPrompt(this.body.transcript, chatScroll,
      () => controller.mode === "session" && this.body.transcript.belongsTo(controller.openedSessionId) && tui.terminal.rows >= 10, () => tui.requestRender());
    chatScroll.onLayout = () => this.stickyPrompt.refresh();
    this.bodyHost.addChild(this.listScroll, { basis: 0, grow: 1, minSize: 1 });
    this.addChild(new Dynamic((width) => this.header(width)), { basis: "auto", shrink: 0 });
    this.addChild(this.bodyHost, { basis: 0, grow: 1, minSize: 1 });
    this.addChild(new Dynamic((width) => this.footer(width), (event) => !controller.dialog ? this.questionComposer?.handleMouse({
      ...event, y: event.y - 1, height: Math.max(0, event.height - 2),
    }) : undefined), { basis: "auto", shrink: 0 });
    this.composer.onSubmit = (text, images) => this.command(text) ? "command" : controller.send(text, undefined, images);
    controller.onChange = () => this.sync();
    controller.auth?.codexQuota?.start(() => tui.requestRender());
  }

  override handleMouse(event: TuiMouseEvent): ReturnType<VStack["handleMouse"]> {
    if (this.controller.mode !== "session" || this.controller.dialog || event.type !== "wheel" || !event.wheelDelta) return;
    const direction = event.wheelDelta < 0 ? -1 : 1;
    const lines = this.wheelScroll.next(direction, performance.now());
    // Pi already includes the Alt-wheel multiplier in wheelDelta.
    this.chatScroll.scrollBy(direction * lines * Math.abs(event.wheelDelta));
    return { handled: true, focus: false, render: true, target: {
      component: this, originX: event.screenX - event.x, originY: event.screenY - event.y,
      width: event.width, height: event.height,
    } };
  }

  private command(text: string): boolean {
    if (text.trimStart().startsWith("!")) { this.controller.runShell(text.trimStart().slice(1)); return true; }
    const command = text.trim();
    const auth = /^\/(login|logout)(?:\s+([\s\S]*))?$/.exec(command);
    if (auth) {
      this.controller.showAuth(auth[1] as "login" | "logout", auth[2]?.trim() || undefined);
      return true;
    }
    if (command === "/model" || command === "/thinking") {
      void this.controller.settings(command === "/model" ? "model" : "thinking").catch((error: unknown) => this.controller.fail(error));
      return true;
    }
    if (command === "/settings" || command === "/config") { this.controller.showSettings(); return true; }
    if (/^\/workspace(?:\s|$)/.test(command)) {
      if (command === "/workspace") this.controller.showWorkspace();
      else if (command === "/workspace approve" || command === "/workspace deny") void this.controller.approveWorkspace(command.endsWith("approve"));
      else if (this.controller.mode === "session") this.controller.fail("Use /workspace to inspect this session. Change defaults from the dashboard, or ask the agent to enter or exit a workspace.");
      else if (command === "/workspace main") this.controller.selectWorkspace({ kind: "main" });
      else if (/^\/workspace new(?:\s|$)/.test(command)) this.controller.selectWorkspace({ kind: "new", baseRef: command.slice("/workspace new".length).trim() || "HEAD" });
      else if (/^\/workspace add\s+/.test(command)) void this.controller.importWorkspace(command.slice("/workspace add".length).trim());
      else this.controller.fail("Usage: /workspace, /workspace approve|deny, /workspace main, /workspace new [base-ref], /workspace add PATH");
      return true;
    }
    if (command === "/projects") { this.controller.toggleProjects(); return true; }
    if (command === "/session") { this.controller.showUsage(); return true; }
    if (command === "/tasks") { this.controller.showTasks(); return true; }
    if (command === "/answer") { this.controller.showQuestions(); return true; }
    if (/^\/copy(?:\s|$)/.test(command)) {
      void this.controller.copyResponse(command.slice("/copy".length)); return true;
    }
    if (/^\/compact(?:\s|$)/.test(command)) {
      void this.controller.compact(command.slice("/compact".length).trim() || undefined); return true;
    }
    if (/^\/undo(?:\s|$)/.test(command)) {
      if (command !== "/undo") { this.controller.fail("Usage: /undo — open the checkpoint picker; nothing is restored until you select one."); return true; }
      void this.controller.showUndo();
      return true;
    }
    if (command === "/stop") { void this.controller.cancel(); return true; }
    if (command === "/help") {
      this.controller.dialog = { kind: "help" }; this.controller.changed(); return true;
    }
    if (command === "/skills") {
      void this.controller.skills().catch((error: unknown) => this.controller.fail(error)); return true;
    }
    if (command === "/top" && this.controller.mode === "session") {
      this.chatScroll.scrollToStart(); return true;
    }
    if (command === "/bottom" && this.controller.mode === "session") {
      this.chatScroll.scrollToEnd(); return true;
    }
    if ((command === "/expand" || command === "/collapse") && this.controller.mode === "session") {
      this.body.render(this.tui.terminal.columns);
      this.body.transcript.toggleAll(command === "/expand");
      return true;
    }
    // Never turn a known command from another view into a new agent task.
    if (composerCommands(true).some(({ name }) => command === `/${name}`)) {
      this.controller.fail(`${command} is only available in an open session. Type / to see commands for this view.`);
      return true;
    }
    return false;
  }

  private header(_width: number): string[] {
    const c = this.controller;
    if (c.mode === "projects") return [`${bold("Projects")}  ${dim("add and remove directories")}`, ""];
    if (c.mode === "session" && c.opened) {
      const path = c.store.sessionPath(c.opened);
      const shared = c.store.state.sessions.filter((s) => c.store.sessionPath(s) === path).length;
      const branch = this.branches.value(path);
      if (c.store.workspace(c.opened)?.kind === "worktree") return [bold(oneLine(c.opened.title)),
        dim(oneLine(`${branch ?? c.workspaceLabel(c.opened)} / ${displayStatus(c.opened)}${shared > 1 ? ` / shared by ${shared} sessions` : ""}`)),
        dim(oneLine(displayPath(path)))];
      return [bold(oneLine(c.opened.title)), dim(oneLine(`${displayPath(path)}  ${branch ?? c.workspaceLabel(c.opened)}${shared > 1 ? ` / shared by ${shared} sessions` : ""}  ${displayStatus(c.opened)}`)), ""];
    }
    const visible = c.store.state.sessions.filter((s) => c.store.state.projects.some((p) => p.id === s.projectId));
    const count = (status: string) => visible.filter((s) => displayStatus(s) === status).length;
    const extra = count("failed") + count("paused");
    const settings = c.engine.configuration();
    const model = settings.model ? `${settings.model.provider}/${settings.model.modelId}` : "no model configured";
    const thinking = settings.thinkingLevel === "off" ? "thinking off" : `${settings.thinkingLevel} effort`;
    const path = c.project ? ` · ${displayPath(c.project.path)}` : "";
    return [
      `${bold("ZZ")} ${dim(`v${version}`)}`,
      dim(oneLine(`New sessions: ${model} · ${thinking}${path}`)),
      dim(`${count("needs-input")} awaiting input · ${count("working")} working · ${count("completed")} completed${extra ? ` · ${extra} interrupted or failed` : ""}`), "",
    ];
  }

  private footer(width: number): string[] {
    const c = this.controller;
    const rule = dim("-".repeat(Math.max(0, width)));
    if (c.mode === "projects") return ["", rule, dim("a add / r remove / enter select / ctrl+x clear sessions / esc back"), c.notice ? warning(oneLine(c.notice)) : dim("r twice removes from list, keeping files and sessions. Ctrl+x twice deletes sessions only.")];
    const notice = !this.questionComposer && !this.body.rename && c.notice ? [warning(oneLine(c.notice))] : [];
    const input = this.questionComposer ? this.questionComposer.render(width, Math.max(1, this.tui.terminal.rows - this.header(width).length - 3))
      : this.composer.render(width);
    const taskBudget = Math.max(0, Math.min(taskVisibleLimit(this.tui.terminal.rows) + 2,
      this.tui.terminal.rows - this.header(width).length - input.length - notice.length - 3));
    return ["",
      ...(!this.questionComposer && c.mode === "session" ? this.taskDisplay.render(c.opened, width, taskBudget, this.tui.terminal.rows) : []),
      ...notice, ...(c.mode === "session" && c.opened?.workspaceSwitch?.phase === "approval"
        ? [warning("External checkout needs approval: /workspace (or /workspace approve / deny)")] : []), ...(c.mode === "sessions" && c.project ? [dim(oneLine(`Workspace: ${c.workspaceDefaultLabel()} /workspace`))] : []), ...input,
      composerStatus(c.configuration, c.engine.stats(c.mode === "session" ? c.opened : undefined),
        c.auth?.codexQuota?.value(c.configuration.model?.provider))];
  }

  dispose(): void { this.branches.close(); this.taskDisplay.close(); this.controller.auth?.codexQuota?.close(); }

  sync(): void {
    const c = this.controller;
    const visibleWorkspaceIds = new Set(c.store.state.sessions.filter((s) => c.store.state.projects.some((p) => p.id === s.projectId)).map((s) => s.workspaceId));
    this.branches.sync(c.mode === "session" ? c.opened ? [c.store.sessionPath(c.opened)] : []
      : [...c.store.state.projects.map((project) => project.path), ...c.store.workspaces.filter((w) => w.status === "ready" && visibleWorkspaceIds.has(w.id)).map((w) => w.path)]);
    const quotaSettings = c.dialog?.kind === "peek" ? c.engine.configuration(c.session(c.dialog.sessionId)) : c.configuration;
    c.auth?.codexQuota?.select(c.mode === "projects" ? undefined : quotaSettings.model?.provider);
    this.taskDisplay.sync(c.store.state.sessions);
    if (c.dialog || c.mode !== this.previousMode || c.openedSessionId !== this.previousSessionId) this.wheelScroll.reset();
    if (c.mode !== this.previousMode || c.openedSessionId !== this.previousSessionId) {
      this.composer.setHistory(promptHistory(c.mode === "session" ? c.opened : undefined));
    }
    this.composer.setAttachmentScope(c.mode === "session" ? `session:${c.openedSessionId}` : `new:${c.project?.path}`);
    const project = c.executionProject(c.mode === "session" ? c.opened : undefined);
    this.composer.setDiscovery(project && c.mode !== "projects"
      ? { cwd: project.path, commands: true, session: c.mode === "session", selectedSession: c.selected?.kind === "session" } : undefined,
      project ? { list: () => c.engine.listSkills(project) } : undefined);
    if (c.mode !== this.previousMode) {
      this.bodyHost.clear();
      if (c.mode === "session") this.bodyHost.addChild(this.stickyPrompt, { basis: "auto", shrink: 0 });
      this.bodyHost.addChild(this.scroll, { basis: 0, grow: 1, minSize: 1 });
      if (c.mode === "session") this.scroll.scrollToEnd();
      else if (this.previousMode === "session") this.composer.handleInput("\x05");
      else this.scroll.scrollToStart();
      this.previousMode = c.mode;
    }
    if (c.mode === "session" && c.openedSessionId !== this.previousSessionId) this.chatScroll.scrollToEnd();
    this.previousSessionId = c.openedSessionId;
    if (c.dialog?.kind === "rename-session" && (c.mode !== "sessions"
      || c.selection !== `session:${c.dialog.sessionId}` || !c.session(c.dialog.sessionId))) {
      c.dialog = undefined;
      c.notice = "";
    }
    if (c.dialog?.kind === "rename-session") {
      if (this.body.rename?.sessionId !== c.dialog.sessionId) {
        const sessionId = c.dialog.sessionId;
        const input = new Input({ prompt: "" });
        input.setValue(c.session(sessionId)!.title);
        input.handleInput("\x05");
        input.onSubmit = (title) => { c.renameSession(sessionId, title); };
        input.onEscape = () => { c.dialog = undefined; c.notice = ""; c.changed(); };
        this.body.rename = { sessionId, input };
      }
    } else {
      if (this.body.rename) this.body.rename.input.focused = false;
      this.body.rename = undefined;
    }
    if (c.questionForm && pendingQuestion(c.session(c.questionForm.sessionId))?.id !== c.questionForm.request.id) c.questionForm = undefined;
    const request = pendingQuestion(c.mode === "session" ? c.opened : undefined);
    const questionKey = request && `${c.openedSessionId}:${request.id}`;
    // Questions replace only the open session's composer, never another view or dialog.
    if (request && questionKey && !this.dismissedQuestions.has(questionKey) && !c.dialog
      && (c.questionForm?.request.id !== request.id || c.questionForm.sessionId !== c.openedSessionId)) {
      c.questionForm = { sessionId: c.openedSessionId!, request };
      c.notice = "";
    }
    if (this.questionComposer) this.questionComposer.focused = false;
    this.questionComposer = undefined;
    if (c.questionForm && c.mode === "session" && c.questionForm.sessionId === c.openedSessionId) {
      const key = `${c.questionForm.sessionId}:${c.questionForm.request.id}`;
      this.questionComposer = this.questionViews.get(key);
      if (!this.questionComposer) {
        this.questionComposer = new QuestionComposer(c, this.tui, c.questionForm, () => this.dismissedQuestions.add(key));
        this.questionViews.set(key, this.questionComposer);
        if (this.questionViews.size > 20) this.questionViews.delete(this.questionViews.keys().next().value!);
      }
    }
    if (c.dialog?.kind === "workspace" && c.dialog.sessionId) {
      const requestId = c.session(c.dialog.sessionId)?.workspaceSwitch?.id;
      if (c.dialog.requestId !== requestId) c.dialog = { ...c.dialog, requestId };
    }
    if (c.dialog !== this.activeDialog) {
      const previousDialog = this.activeDialog;
      this.activeDialog = c.dialog;
      if (previousDialog?.kind === "auth") previousDialog.flow.dispose();
      this.overlay?.hide();
      this.overlay = undefined;
      const undoSessionId = c.dialog?.kind === "undo" ? c.dialog.sessionId : undefined;
      // Rename shares the dialog lifecycle, but renders in the selected row.
      if (c.dialog && c.dialog.kind !== "rename-session") this.overlay = this.tui.showOverlay(c.dialog.kind === "auth"
        ? new AuthDialog(c.dialog.flow, this.tui, () => c.closeAuth()) : c.dialog.kind === "model" || c.dialog.kind === "thinking" || c.dialog.kind === "skills"
        ? new SettingsDialog(c, this.tui, c.dialog, (name) => {
          this.composer.setValue(`$${name} ${this.composer.getValue()}`);
          this.composer.handleInput("\x05");
          c.dialog = undefined; c.changed();
        }) : c.dialog.kind === "undo" ? new UndoDialog(c, this.tui, c.dialog, (result) => {
          if (c.mode === "session" && c.openedSessionId === undoSessionId && !this.composer.hasContent) {
            this.composer.setValue(result.prompt); c.changed();
          }
        }) : c.dialog.kind === "workspace" ? new WorkspaceDialog(c, this.tui, c.dialog) : c.dialog.kind === "settings" ? new SettingsPage(c, this.tui, c.dialog) : new DialogView(c, this.tui, this.taskDisplay), {
        width: "88%", maxHeight: "85%", margin: 1,
      });
    }
    if (c.mode !== "session" && c.selection !== this.previousSelection) this.revealSelection();
    this.previousSelection = c.selection;
    this.syncFocus();
    this.tui.requestRender();
  }

  private revealSelection(): void {
    this.body.render(Math.max(1, this.tui.terminal.columns - 1));
    const line = this.body.positions.get(this.controller.selection ?? "");
    if (line === undefined) return;
    if (line < this.scroll.scrollTop) this.scroll.scrollTo(line);
    else if (line >= this.scroll.scrollTop + this.scroll.viewportHeight) {
      this.scroll.scrollTo(Math.max(0, line - this.scroll.viewportHeight + 1));
    }
  }

  private revealTool(): void {
    this.body.render(this.tui.terminal.columns);
    const line = this.body.transcript.positions.get(this.body.transcript.selected ?? "");
    if (line === undefined) return;
    if (line < this.scroll.scrollTop) this.scroll.scrollTo(line);
    else if (line >= this.scroll.scrollTop + this.scroll.viewportHeight) this.scroll.scrollTo(Math.max(0, line - this.scroll.viewportHeight + 1));
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    const c = this.controller;
    if (this.body.rename) {
      if (matchesKey(data, "ctrl+c")) this.quit();
      else this.body.rename.input.handleInput(data);
      this.tui.requestRender();
      return;
    }
    if (this.questionComposer && !c.dialog) {
      if (matchesKey(data, "ctrl+c")) this.quit();
      else this.questionComposer.handleInput(data);
      return;
    }
    if (c.pendingProjectRemoval) {
      if (data === "r") c.confirmProjectRemoval();
      else c.cancelProjectRemoval();
      return;
    }
    if (c.pendingDelete) {
      if (matchesKey(data, "ctrl+x")) {
        void c.confirmDelete().catch((error: unknown) => c.fail(error)); return;
      }
      c.cancelDelete();
      return;
    }
    // Legacy terminals encode Ctrl+J as LF, which also matches Enter. Route
    // composer shortcuts before the empty-composer open/toggle shortcuts.
    if (c.mode !== "projects" && (matchesKey(data, "ctrl+j") || matchesKey(data, "ctrl+g"))) {
      this.composer.handleInput(data); this.tui.requestRender(); return;
    }
    if (matchesKey(data, "ctrl+c")) { this.quit(); return; }
    if (c.mode !== "projects" && matchesKey(data, "ctrl+v")) { this.composer.handleInput(data); return; }
    if (c.mode !== "projects" && this.composer.handleDiscoveryInput(data)) { this.tui.requestRender(); return; }
    if (matchesKey(data, "escape")) { c.escape(); return; }
    if (matchesKey(data, Key.pageUp)) { this.scroll.scrollBy(-Math.max(1, this.scroll.viewportHeight - 2)); this.tui.requestRender(); return; }
    if (matchesKey(data, Key.pageDown)) { this.scroll.scrollBy(Math.max(1, this.scroll.viewportHeight - 2)); this.tui.requestRender(); return; }
    if (c.mode === "session") {
      if (!this.composer.hasContent && (matchesKey(data, "left") || matchesKey(data, "ctrl+h"))) { c.back(); return; }
      if (matchesKey(data, "tab") || matchesKey(data, "ctrl+n") || matchesKey(data, "ctrl+p")) {
        this.body.render(this.tui.terminal.columns);
        this.body.transcript.move(matchesKey(data, "ctrl+p") ? -1 : 1);
        this.revealTool(); return;
      }
      if (!this.composer.hasContent && (matchesKey(data, "space") || matchesKey(data, "enter") || matchesKey(data, "right"))) {
        this.body.render(this.tui.terminal.columns);
        this.body.transcript.toggle(matchesKey(data, "right") ? true : undefined);
        this.revealTool(); return;
      }
    }
    if (c.mode !== "session") {
      if (c.mode === "sessions" && (matchesKey(data, "shift+up") || matchesKey(data, "shift+down"))) {
        c.reorderSession(matchesKey(data, "shift+up") ? -1 : 1);
        this.revealSelection(); return;
      }
      if (c.mode === "sessions" && matchesKey(data, "ctrl+r")) { c.showRenameSession(); return; }
      const editingLines = this.composer.getValue().includes("\n");
      const previous = (!editingLines && matchesKey(data, "up")) || matchesKey(data, "ctrl+p");
      const next = (!editingLines && matchesKey(data, "down")) || matchesKey(data, "ctrl+n");
      if (previous || next) {
        c.move(previous ? -1 : 1); this.revealSelection(); return;
      }
      if (matchesKey(data, "ctrl+x")) { c.requestDelete(); return; }
      if (c.mode === "projects") {
        if (data === "a" || matchesKey(data, "enter") && !c.selected) { c.dialog = { kind: "add-project" }; c.changed(); }
        else if (data === "r") { c.requestProjectRemoval(); }
        else if (matchesKey(data, "enter")) { c.mode = "sessions"; c.changed(); }
        return;
      }
      if (!this.composer.hasContent) {
        if (matchesKey(data, "space")) { c.peek(); return; }
        if (matchesKey(data, "enter")) {
          if (c.selected?.kind === "project") c.toggleProject();
          else c.open();
          this.revealSelection(); return;
        }
      }
    }
    this.composer.handleInput(data);
    this.tui.requestRender();
  }
}

class DialogView implements Component, Focusable {
  readonly input: Input | Composer;
  private _focused = false;
  private offset = 0;
  private cache?: { text: string; width: number; lines: string[] };
  get focused(): boolean { return this._focused; }
  set focused(value: boolean) { this._focused = value; this.input.focused = value; }

  constructor(readonly controller: Controller, readonly tui: TuiAltScreen, private readonly taskDisplay: TaskDisplay) {
    this.input = controller.dialog?.kind === "peek"
      ? new Composer(tui, "reply to this session", (error) => controller.fail(error))
      : controller.dialog?.kind === "add-project"
        ? new DirectoryInput(() => tui.requestRender())
        : new Input();
    const dialog = controller.dialog;
    if (this.input instanceof Composer && dialog?.kind === "peek") {
      this.input.setHistory(promptHistory(controller.session(dialog.sessionId)));
      const project = controller.executionProject(controller.session(dialog.sessionId));
      if (project) this.input.setDiscovery({ cwd: project.path, commands: false, session: true },
        { list: () => controller.engine.listSkills(project) });
    }
    this.input.onSubmit = (text: string, images: ImageAttachment[] = []): boolean | "command" => {
      const dialog = controller.dialog;
      if (dialog?.kind === "add-project") return controller.addProject(text.trim());
      if (dialog?.kind === "peek") {
        if (text.trim() === "/workspace approve" || text.trim() === "/workspace deny") { void controller.approveWorkspace(text.trim().endsWith("approve"), dialog.sessionId); return "command"; }
        if (text.trim() === "/tasks") { controller.showTasks(dialog.sessionId); return "command"; }
        if (text.trimStart().startsWith("!")) { controller.runShell(text.trimStart().slice(1), dialog.sessionId); return "command"; }
        return controller.send(text, dialog.sessionId, images);
      }
      return false;
    };
  }

  handleInput(data: string): void {
    const c = this.controller;
    const dialog = c.dialog;
    if (this.input instanceof Composer && this.input.handleDiscoveryInput(data)) { this.tui.requestRender(); return; }
    if (this.input instanceof DirectoryInput && this.input.dismissSuggestions(data)) { this.tui.requestRender(); return; }
    if (matchesKey(data, "escape")) {
      c.dialog = undefined; c.notice = ""; c.changed(); return;
    }
    if (dialog?.kind === "help" || dialog?.kind === "usage" || dialog?.kind === "tasks") {
      if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
        this.offset = Math.max(0, this.offset + (matchesKey(data, Key.pageDown) ? 8 : -8));
      } else { c.dialog = undefined; c.changed(); }
    }
    else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
      this.offset = Math.max(0, this.offset + (matchesKey(data, Key.pageUp) ? 8 : -8));
    } else this.input.handleInput(data);
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const c = this.controller;
    const dialog = c.dialog;
    if (!dialog || dialog.kind === "workspace" || dialog.kind === "model" || dialog.kind === "thinking" || dialog.kind === "skills" || dialog.kind === "settings") return [];
    const inner = Math.max(1, width - 4);
    const frame = (lines: string[]) => [
      `+${"-".repeat(Math.max(0, width - 2))}+`,
      ...lines.map((line) => `| ${pad(fit(line, inner), inner)} |`),
      `+${"-".repeat(Math.max(0, width - 2))}+`,
    ].map((line) => fit(line, width));
    if (dialog.kind === "usage" || dialog.kind === "tasks") {
      const session = c.session(dialog.sessionId);
      const lines = (session ? dialog.kind === "tasks" ? taskDetails(session.tasks, inner)
        : usageDetails(c.engine.stats(session)) : ["Session not found."])
        .flatMap((line) => wrapTextWithAnsi(line, inner));
      const height = Math.max(1, Math.floor(this.tui.terminal.rows * 0.85) - 6);
      this.offset = Math.min(this.offset, Math.max(0, lines.length - height));
      return frame([bold(dialog.kind === "tasks" ? "Session tasks" : "Session usage"), "", ...lines.slice(this.offset, this.offset + height), "", dim("pgup pgdn scroll / any other key closes")]);
    }
    if (dialog.kind === "help") {
      const session = c.mode === "session";
      const selectedSession = c.selected?.kind === "session";
      const view = session ? "Open session" : selectedSession ? "Dashboard (session selected)" : "Dashboard (project selected)";
      const help = [bold(`Commands: ${view}`),
        ...composerCommands(session, selectedSession).map(({ name, description }) => `/${name}  ${description}`),
        ...(!session && !selectedSession ? [dim("Select a session for /copy, /session, /tasks, /compact, /undo and /stop.")] : []),
        "", bold("Keyboard shortcuts"),
      "up / ctrl+p     select previous project or session",
      "down / ctrl+n   select next project or session",
      "enter           new task when composer has text", "enter           open session when composer is empty",
      "enter           collapse or expand selected project (empty composer)",
      "enter           queue a busy-session reply (/settings chooses follow-up or steer)",
      "↑ / ↓           recall sent prompts in session / peek (empty draft or start of first line)",
      "↓               after newest recalled prompt, restore your unsent draft",
      "ctrl+j          insert a newline in the draft",
      "ctrl+g          edit draft in $VISUAL / $EDITOR (default vim)",
      "/               search commands available in this view",
      "@               search files; @image.png attaches on send",
      "ctrl+v          paste a clipboard image, copied files or text",
      "!command        run a local shell command in this session's workspace",
      "backspace       remove an inline [Image #N] tag and its attachment",
      "/settings       replies, model, reasoning display and auto-compaction",
      "tab             complete a path at the cursor",
      "↑↓ / ctrl+n/p   select suggestion; tab fills; enter runs slash commands",
      "esc             dismiss suggestions / close dialogs; otherwise /stop in session",
      "space           peek last reply when composer is empty", "/projects       manage projects (esc returns to dashboard)",
      "shift+up/down   reorder selected session within its project (dashboard)",
      "ctrl+r          rename selected session (dashboard)",
      "ctrl+x twice    delete session or all sessions in selected project", "a               add a project (in project management)",
      "r twice         remove project from list, keeping files and sessions (project management)",
      "pgup / pgdn     scroll transcript or peek",
      "wheel           adaptive chat scrolling; Alt scrolls 5x farther",
      "ctrl+home / /top jump to the oldest chat output",
      "left / ctrl+h   dashboard when composer is empty (work continues)",
      "$skill-name [task] load a skill; type $ to find skills",
      "tab / ctrl+n/p  select tool or thinking blocks in session",
      "space / enter   expand or collapse selected block (empty composer)",
      "ctrl+c          quit (running sessions pause)", "", dim("New tasks always run in the selected row's project.")]
        .flatMap((line) => wrapTextWithAnsi(line, inner));
      const height = Math.max(1, Math.floor(this.tui.terminal.rows * 0.85) - 6);
      this.offset = Math.min(this.offset, Math.max(0, help.length - height));
      return frame([bold("zz shortcuts"), "", ...help.slice(this.offset, this.offset + height), "", dim("pgup pgdn scroll / any other key closes")]);
    }
    if (dialog.kind === "add-project") return frame([
      bold("Add project"), dim("Enter an existing directory. ~ is supported; spaces need no quotes."), "",
      ...this.input.render(inner), "", c.notice ? warning(oneLine(c.notice)) : dim("up/down select / tab complete / enter add / esc dismiss or cancel"),
    ]);
    if (dialog.kind !== "peek") return [];
    const session = c.session(dialog.sessionId);
    const text = session ? lastReply(session) : "Session not found.";
    const reply = session && lastReplyMessage(session);
    if (this.cache?.text !== text || this.cache.width !== inner) this.cache = { text, width: inner, lines: markdown(text, inner) };
    const replyLines = reply?.role === "shell" ? renderShellResponse(reply.shell, inner) : this.cache.lines;
    const inputLines = this.input.render(inner);
    const hint = queueHint(session, c.store.settings.replyBehavior);
    const belowComposer = [
      ...(hint ? [dim(hint)] : []),
      composerStatus(c.engine.configuration(session), c.engine.stats(session),
        c.auth?.codexQuota?.value(c.engine.configuration(session).model?.provider)),
    ];
    const checklist = this.taskDisplay.render(session, inner, Math.max(0, Math.min(taskVisibleLimit(this.tui.terminal.rows) + 2,
      Math.floor(this.tui.terminal.rows * 0.85) - 7 - inputLines.length - belowComposer.length - (c.notice ? 1 : 0))), this.tui.terminal.rows);
    const available = Math.max(1, Math.floor(this.tui.terminal.rows * 0.85)
      - 6 - inputLines.length - checklist.length - belowComposer.length - (c.notice ? 1 : 0));
    const lines = replyLines;
    this.offset = Math.min(this.offset, Math.max(0, lines.length - available));
    const end = Math.max(available, lines.length - this.offset);
    const body = lines.slice(Math.max(0, end - available), end);
    return frame([
      bold(oneLine(session?.title ?? "Last reply")), dim("Last agent message"), "", ...body, "",
      ...(c.notice ? [warning(oneLine(c.notice))] : []),
      ...checklist, ...inputLines, ...belowComposer,
    ]);
  }

  invalidate(): void { this.cache = undefined; this.input.invalidate(); }
}
