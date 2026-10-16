import {
  Input, Key, ScrollView, VStack, matchesKey, wrapTextWithAnsi,
  type Component, type Focusable, type OverlayHandle,
  type TuiAltScreen, type TuiMouseEvent, type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { Controller } from "./controller.js";
import { age, lastReply, rowId, type Row } from "./model.js";
import { displayPath } from "./store.js";
import { accent, bold, dim, fit, green, markdown, oneLine, pad, warning } from "./format.js";
import { Transcript } from "./transcript.js";
import { SettingsDialog } from "./settings-dialog.js";
import { Composer } from "./composer.js";
import { composerStatus, usageDetails } from "./usage.js";

export const scrollToEndIndicator = () => accent("[ Scroll to bottom / ctrl+end ]");

class Dynamic implements Component {
  constructor(readonly draw: (width: number) => string[]) {}
  render(width: number): string[] { return this.draw(width).map((line) => fit(line, width)); }
  invalidate(): void {}
}

class SessionList extends Dynamic {
  positions = new Map<string, number>();
  private hits = new Map<number, Row>();
  readonly transcript: Transcript;

  constructor(readonly controller: Controller) {
    super((width) => this.drawList(width));
    this.transcript = new Transcript(controller, () => controller.changed());
  }

  private drawList(width: number): string[] {
    const c = this.controller;
    this.hits.clear();
    this.positions.clear();
    if (c.mode === "session" && c.opened) {
      return this.transcript.render(width);
    }
    const lines: string[] = [];
    for (const row of c.currentRows) {
      if (row.kind === "project" && lines.length) lines.push("");
      const id = rowId(row);
      this.positions.set(id, lines.length);
      this.hits.set(lines.length, row);
      const selected = c.selection === id;
      let line: string;
      if (row.kind === "project") {
        const count = c.store.state.sessions.filter((s) => s.projectId === row.project.id).length;
        line = `${selected ? ">" : " "} ${bold(oneLine(displayPath(row.project.path)))}${dim(`  ${count} session${count === 1 ? "" : "s"}`)}`;
      } else {
        const { session } = row;
        const symbol = session.status === "working" ? accent("*") : session.status === "needs-input" ? warning("?")
          : session.status === "failed" ? warning("!") : session.status === "paused" ? dim("-") : green(".");
        const time = age(session.updatedAt);
        const titleWidth = Math.min(28, Math.max(8, Math.floor(width * 0.3)));
        const title = pad(fit(oneLine(session.title), titleWidth), titleWidth);
        const previewWidth = Math.max(0, width - titleWidth - time.length - 10);
        line = previewWidth > 8
          ? `  ${symbol} ${title}  ${dim(pad(fit(oneLine(session.preview), previewWidth), previewWidth))}  ${dim(time)}`
          : `  ${symbol} ${oneLine(session.title)}`;
      }
      line = fit(line, width);
      // Truncation inserts full SGR resets; restore inverse so the entire row stays selected.
      lines.push(selected ? `\x1b[7m${pad(line, width).replaceAll("\x1b[0m", "\x1b[0m\x1b[7m")}\x1b[27m` : line);
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

export class Dashboard extends VStack implements Focusable {
  readonly composer: Composer;
  readonly body: SessionList;
  readonly chatScroll: ScrollView;
  readonly listScroll: ScrollView;
  private readonly bodyHost = new VStack();
  get scroll(): ScrollView { return this.controller.mode === "session" ? this.chatScroll : this.listScroll; }
  private overlay?: OverlayHandle;
  private activeDialog?: Controller["dialog"];
  private _focused = false;
  private previousMode?: string;
  private previousSelection?: string;
  private previousSessionId?: string;
  private draft = "";

  get focused(): boolean { return this._focused; }
  set focused(value: boolean) { this._focused = value; this.composer.focused = value; }

  constructor(readonly controller: Controller, readonly tui: TuiAltScreen, readonly quit: () => void) {
    super();
    this.composer = new Composer(tui, "describe a task for a new session", (error) => controller.fail(error));
    this.body = new SessionList(controller);
    this.listScroll = new ScrollView(this.body, { primary: true, follow: "none", scrollbar: "auto" });
    this.chatScroll = new ScrollView(this.body, { primary: true, follow: "end", scrollbar: "auto" });
    this.bodyHost.addChild(this.listScroll, { basis: 0, grow: 1, minSize: 1 });
    this.addChild(new Dynamic((width) => this.header(width)), { basis: "auto", shrink: 0 });
    this.addChild(this.bodyHost, { basis: 0, grow: 1, minSize: 1 });
    this.addChild(new Dynamic((width) => this.footer(width)), { basis: "auto", shrink: 0 });
    this.composer.onSubmit = (text) => this.command(text) || controller.send(text);
    controller.onChange = () => this.sync();
  }

  private command(text: string): boolean {
    const command = text.trim();
    if (command === "/model" || command === "/thinking") {
      void this.controller.settings(command === "/model" ? "model" : "thinking").catch((error: unknown) => this.controller.fail(error));
      return true;
    }
    if (command === "/session") { this.controller.showUsage(); return true; }
    if (command === "/stop") { void this.controller.cancel(); return true; }
    if (command === "/help") {
      this.controller.dialog = { kind: "help" }; this.controller.changed(); return true;
    }
    if (command === "/skills") {
      void this.controller.skills().catch((error: unknown) => this.controller.fail(error)); return true;
    }
    if (command === "/bottom" && this.controller.mode === "session") {
      this.chatScroll.scrollToEnd(); return true;
    }
    if ((command === "/expand" || command === "/collapse") && this.controller.mode === "session") {
      this.body.render(this.tui.terminal.columns);
      this.body.transcript.toggleAll(command === "/expand");
      return true;
    }
    return false;
  }

  private header(_width: number): string[] {
    const c = this.controller;
    if (c.mode === "projects") return ["", `  ${bold("Projects")}  ${dim("add and remove directories")}`, ""];
    if (c.mode === "session" && c.opened) return ["", `  ${bold(oneLine(c.opened.title))}`, `  ${dim(oneLine(displayPath(c.project?.path ?? "")))}  ${dim(c.opened.status)}`, ""];
    const visible = c.store.state.sessions.filter((s) => c.store.state.projects.some((p) => p.id === s.projectId));
    const count = (status: string) => visible.filter((s) => s.status === status).length;
    const extra = count("failed") + count("paused");
    return ["", `  ${dim(`${count("needs-input")} awaiting input / ${count("working")} working / ${count("completed")} completed${extra ? ` / ${extra} interrupted or failed` : ""}`)}`, ""];
  }

  private footer(width: number): string[] {
    const c = this.controller;
    const rule = dim("-".repeat(Math.max(0, width - 4)));
    if (c.mode === "projects") return ["", `  ${rule}`, `  ${dim("a add / enter select / ctrl+x remove / ctrl+o back")}`, `  ${c.notice ? warning(oneLine(c.notice)) : dim("Removing a project keeps its files and session history.")}`, ""];
    const context = c.mode === "session" ? `Reply to ${oneLine(c.opened?.title ?? "session")}` : `New task in ${oneLine(displayPath(c.project?.path ?? "(select a project)"))}`;
    return ["", `  ${dim(context)}`,
      ...(c.notice ? [`  ${warning(oneLine(c.notice))}`] : []),
      ...this.composer.render(Math.max(1, width - 4)).map((line) => `  ${line}`),
      `  ${composerStatus(c.configuration, c.engine.stats(c.mode === "session" ? c.opened : undefined))}`, ""];
  }

  sync(): void {
    const c = this.controller;
    this.composer.setDiscovery(c.project && c.mode !== "projects"
      ? { cwd: c.project.path, commands: true, session: c.mode === "session" } : undefined);
    if (c.mode !== this.previousMode) {
      this.bodyHost.clear();
      this.bodyHost.addChild(this.scroll, { basis: 0, grow: 1, minSize: 1 });
      if (c.mode === "session") { this.draft = this.composer.getValue(); this.composer.setValue(""); this.scroll.scrollToEnd(); }
      else if (this.previousMode === "session") { this.composer.setValue(this.draft); this.composer.handleInput("\x05"); }
      else this.scroll.scrollToStart();
      this.previousMode = c.mode;
    }
    if (c.mode === "session" && c.openedSessionId !== this.previousSessionId) this.chatScroll.scrollToEnd();
    this.previousSessionId = c.openedSessionId;
    if (c.dialog !== this.activeDialog) {
      this.overlay?.hide();
      this.overlay = undefined;
      this.activeDialog = c.dialog;
      if (c.dialog) this.overlay = this.tui.showOverlay(c.dialog.kind === "model" || c.dialog.kind === "thinking" || c.dialog.kind === "skills"
        ? new SettingsDialog(c, this.tui, c.dialog, (name) => {
          this.composer.setValue(`/skill:${name} ${this.composer.getValue()}`);
          this.composer.handleInput("\x05");
          c.dialog = undefined; c.changed();
        }) : new DialogView(c, this.tui), {
        width: "88%", maxHeight: "85%", margin: 1,
      });
    }
    if (c.mode !== "session" && c.selection !== this.previousSelection) this.revealSelection();
    this.previousSelection = c.selection;
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
    // Legacy terminals encode Ctrl+J as LF, which also matches Enter. Route
    // composer shortcuts before the empty-composer open/toggle shortcuts.
    if (c.mode !== "projects" && (matchesKey(data, "ctrl+j") || matchesKey(data, "ctrl+g"))) {
      this.composer.handleInput(data); this.tui.requestRender(); return;
    }
    if (matchesKey(data, "ctrl+c")) { this.quit(); return; }
    if (c.mode !== "projects" && this.composer.handleDiscoveryInput(data)) { this.tui.requestRender(); return; }
    if (matchesKey(data, "shift+tab")) { void c.cycleThinking(); return; }
    if (matchesKey(data, "ctrl+l") || matchesKey(data, "ctrl+t")) {
      void c.settings(matchesKey(data, "ctrl+l") ? "model" : "thinking").catch((error: unknown) => c.fail(error)); return;
    }
    if (matchesKey(data, "ctrl+o")) { c.toggleProjects(); return; }
    if (matchesKey(data, "escape")) { c.escape(); return; }
    if (matchesKey(data, Key.pageUp)) { this.scroll.scrollBy(-Math.max(1, this.scroll.viewportHeight - 2)); this.tui.requestRender(); return; }
    if (matchesKey(data, Key.pageDown)) { this.scroll.scrollBy(Math.max(1, this.scroll.viewportHeight - 2)); this.tui.requestRender(); return; }
    if (c.mode === "session") {
      if (!this.composer.getValue() && (matchesKey(data, "left") || matchesKey(data, "ctrl+h"))) { c.back(); return; }
      if (matchesKey(data, "tab") || matchesKey(data, "ctrl+n") || matchesKey(data, "ctrl+p")) {
        this.body.render(this.tui.terminal.columns);
        this.body.transcript.move(matchesKey(data, "ctrl+p") ? -1 : 1);
        this.revealTool(); return;
      }
      if (!this.composer.getValue() && (matchesKey(data, "space") || matchesKey(data, "enter") || matchesKey(data, "right"))) {
        this.body.render(this.tui.terminal.columns);
        this.body.transcript.toggle(matchesKey(data, "right") ? true : undefined);
        this.revealTool(); return;
      }
    }
    if (c.mode !== "session") {
      const editingLines = this.composer.getValue().includes("\n");
      const previous = (!editingLines && matchesKey(data, "up")) || matchesKey(data, "ctrl+p");
      const next = (!editingLines && matchesKey(data, "down")) || matchesKey(data, "ctrl+n");
      if (previous || next) {
        c.move(previous ? -1 : 1); this.revealSelection(); return;
      }
      if (matchesKey(data, "ctrl+x")) { c.requestDelete(); return; }
      if (c.mode === "projects") {
        if (data === "a" || matchesKey(data, "enter") && !c.selected) { c.dialog = { kind: "add-project" }; c.changed(); }
        else if (matchesKey(data, "enter")) { c.mode = "sessions"; c.changed(); }
        return;
      }
      if (!this.composer.getValue()) {
        if (matchesKey(data, "space")) { c.peek(); return; }
        if (matchesKey(data, "enter")) { c.open(); return; }
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
  private busy = false;
  private cache?: { text: string; width: number; lines: string[] };
  get focused(): boolean { return this._focused; }
  set focused(value: boolean) { this._focused = value; this.input.focused = value; }

  constructor(readonly controller: Controller, readonly tui: TuiAltScreen) {
    this.input = controller.dialog?.kind === "peek"
      ? new Composer(tui, "reply to this session", (error) => controller.fail(error))
      : new Input({ placeholder: "/path/to/project", placeholderStyle: dim });
    const dialog = controller.dialog;
    if (this.input instanceof Composer && dialog?.kind === "peek") {
      const project = controller.store.state.projects.find((p) => p.id === controller.session(dialog.sessionId)?.projectId);
      if (project) this.input.setDiscovery({ cwd: project.path, commands: false, session: true });
    }
    this.input.onSubmit = (text) => {
      const dialog = controller.dialog;
      if (dialog?.kind === "add-project") return controller.addProject(text.trim());
      if (dialog?.kind === "peek") return controller.send(text, dialog.sessionId);
      return false;
    };
  }

  handleInput(data: string): void {
    const c = this.controller;
    const dialog = c.dialog;
    if (this.busy) return;
    if (this.input instanceof Composer && this.input.handleDiscoveryInput(data)) { this.tui.requestRender(); return; }
    if (matchesKey(data, "escape")) { c.dialog = undefined; c.notice = ""; c.changed(); return; }
    if (dialog?.kind === "delete" || dialog?.kind === "remove-project") {
      if (matchesKey(data, "ctrl+x")) {
        this.busy = true;
        void c.confirmDelete().catch((error: unknown) => c.fail(error));
      } else { c.dialog = undefined; c.changed(); }
    } else if (dialog?.kind === "help" || dialog?.kind === "usage") {
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
    if (!dialog || dialog.kind === "model" || dialog.kind === "thinking" || dialog.kind === "skills") return [];
    const inner = Math.max(1, width - 4);
    const frame = (lines: string[]) => [
      `+${"-".repeat(Math.max(0, width - 2))}+`,
      ...lines.map((line) => `| ${pad(fit(line, inner), inner)} |`),
      `+${"-".repeat(Math.max(0, width - 2))}+`,
    ].map((line) => fit(line, width));
    if (dialog.kind === "delete") return frame([
      bold("Delete session?"), "", oneLine(c.session(dialog.sessionId)?.title ?? ""), "",
      warning("ctrl+x again to delete"), dim("Any other key cancels. Project files are never deleted."),
    ]);
    if (dialog.kind === "remove-project") return frame([
      bold("Remove project from the list?"), "", fit(oneLine(displayPath(dialog.projectId)), inner), "",
      warning("ctrl+x again to remove"), dim("Files and sessions are kept. Re-add the path to restore them."),
    ]);
    if (dialog.kind === "usage") {
      const session = c.session(dialog.sessionId);
      const lines = (session ? usageDetails(c.engine.stats(session)) : ["Session not found."])
        .flatMap((line) => wrapTextWithAnsi(line, inner));
      const height = Math.max(1, Math.floor(this.tui.terminal.rows * 0.85) - 6);
      this.offset = Math.min(this.offset, Math.max(0, lines.length - height));
      return frame([bold("Session usage"), "", ...lines.slice(this.offset, this.offset + height), "", dim("pgup pgdn scroll / any other key closes")]);
    }
    if (dialog.kind === "help") {
      const help = ["up / ctrl+p     select previous project or session",
      "down / ctrl+n   select next project or session",
      "enter           new task when composer has text", "enter           open session when composer is empty",
      "ctrl+j          insert a newline in the draft",
      "ctrl+g          edit draft in $VISUAL / $EDITOR (default vim)",
      "/               search commands available in this view",
      "@               search project files (fd); browse paths without fd",
      "tab             complete a path at the cursor",
      "↑↓ / ctrl+n/p   select suggestion; tab / enter fills without sending",
      "esc             dismiss suggestions before stopping work",
      "space           peek last reply when composer is empty", "ctrl+o          manage projects",
      "ctrl+x twice    delete selected session", "a               add a project (in project management)",
      "pgup / pgdn     scroll transcript or peek", "esc             stop work in session; close dialogs",
      "left / ctrl+h   dashboard when composer is empty (work continues)",
      "/stop           stop open/selected session, preserving its history",
      "ctrl+l /model   choose model (new tasks or open session)",
      "ctrl+t /thinking choose supported thinking level",
      "shift+tab       cycle supported thinking levels",
      "/skills         choose a skill; /skill:name [task] loads it",
      "/session        context, tokens, cache and estimated cost",
      "ctrl+end /bottom scroll to bottom and follow new output",
      "tab / ctrl+n/p  select tools in session",
      "space / enter   expand or collapse selected tool (empty composer)",
      "/expand /collapse show or hide all tool details",
      "ctrl+c          quit (running sessions pause)", "", dim("New tasks always run in the selected row's project.")];
      const height = Math.max(1, Math.floor(this.tui.terminal.rows * 0.85) - 6);
      this.offset = Math.min(this.offset, Math.max(0, help.length - height));
      return frame([bold("zz shortcuts"), "", ...help.slice(this.offset, this.offset + height), "", dim("pgup pgdn scroll / any other key closes")]);
    }
    if (dialog.kind === "add-project") return frame([
      bold("Add project"), dim("Enter an existing directory. ~ is supported."), "",
      ...this.input.render(inner), "", c.notice ? warning(oneLine(c.notice)) : dim("enter add / esc cancel"),
    ]);
    if (dialog.kind !== "peek") return [];
    const session = c.session(dialog.sessionId);
    const text = session ? lastReply(session) : "Session not found.";
    if (this.cache?.text !== text || this.cache.width !== inner) this.cache = { text, width: inner, lines: markdown(text, inner) };
    const inputLines = this.input.render(inner);
    const belowComposer = [composerStatus(c.engine.configuration(session), c.engine.stats(session))];
    const available = Math.max(1, Math.floor(this.tui.terminal.rows * 0.85)
      - 6 - inputLines.length - belowComposer.length - (c.notice ? 1 : 0));
    const lines = this.cache.lines;
    this.offset = Math.min(this.offset, Math.max(0, lines.length - available));
    const end = Math.max(available, lines.length - this.offset);
    const body = lines.slice(Math.max(0, end - available), end);
    return frame([
      bold(oneLine(session?.title ?? "Last reply")), dim("Last agent message"), "", ...body, "",
      ...(c.notice ? [warning(oneLine(c.notice))] : []),
      ...inputLines, ...belowComposer,
    ]);
  }

  invalidate(): void { this.cache = undefined; this.input.invalidate(); }
}
