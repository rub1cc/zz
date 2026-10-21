import { Input, SelectList, matchesKey, wrapTextWithAnsi, type Component, type Focusable, type SelectItem, type TuiAltScreen, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { Controller, Dialog } from "./controller.js";
import { accent, bold, dim, fit, oneLine, pad, warning } from "./format.js";
import { displayPath } from "./store.js";
import { DirectoryInput } from "./directory-input.js";

export class WorkspaceDialog implements Component, Focusable {
  private readonly list: SelectList;
  private input?: Input;
  private step?: "base" | "path";
  private busy = false;
  private listTop = 0;
  private approvalId?: string;
  private _focused = false;
  get focused(): boolean { return this._focused; }
  set focused(value: boolean) { this._focused = value; if (this.input) this.input.focused = value; }

  constructor(private readonly controller: Controller, private readonly tui: TuiAltScreen,
    private readonly dialog: Extract<Dialog, { kind: "workspace" }>) {
    const project = controller.store.state.projects.find((p) => p.id === dialog.projectId)!;
    const session = dialog.sessionId ? controller.session(dialog.sessionId) : undefined;
    const current = session && controller.store.workspace(session);
    const defaults = project.workspaceDefault;
    const approval = session?.workspaceSwitch?.phase === "approval";
    this.approvalId = approval ? session.workspaceSwitch!.id : undefined;
    const items: SelectItem[] = approval ? [
      { value: "approve", label: "Approve external workspace", description: "Move this session's tools, instructions, and working directory there, then continue." },
      { value: "deny", label: "Deny entry", description: "Keep this session in its current checkout. Do not move or delete any files." },
    ] : session ? current?.status === "ready" ? [{ value: current.id, label: "Use this workspace for new sessions",
      description: "Shares this checkout; does not move this conversation." }] : [] : [
      { value: "new", label: "New worktree", description: `Separate checkout for each task, from ${defaults?.kind === "new" ? defaults.baseRef : "HEAD"}. Main directory outside Git.` },
      { value: "base", label: "New worktree from another ref...", description: "Choose a local branch, tag, commit, or existing remote-tracking ref." },
      { value: "main", label: "Main checkout", description: "Work directly in the project folder. Sessions share files." },
      ...controller.store.workspaces.filter((w) => w.projectId === project.id && w.kind === "worktree" && w.status === "ready")
        .map((w) => ({ value: w.id, label: w.branch ?? "Existing worktree", description: `${displayPath(w.path)}${w.managed ? "" : " (external)"}` })),
      { value: "import", label: "Register existing worktree...", description: "Add another Git checkout belonging to this repository." },
    ];
    this.list = new SelectList(items, Math.max(1, Math.min(10, tui.terminal.rows - 15)), {
      selectedPrefix: accent, selectedText: bold, description: dim, scrollInfo: dim, noMatch: warning,
    });
    const selected = defaults?.kind === "existing" ? defaults.workspaceId : defaults?.kind === "main" ? "main" : "new";
    this.list.setSelectedIndex(Math.max(0, items.findIndex((item) => item.value === selected)));
    this.list.onSelect = (item) => { void this.choose(item.value); };
  }

  private async choose(value: string): Promise<void> {
    const c = this.controller;
    const project = c.store.state.projects.find((p) => p.id === this.dialog.projectId);
    if (!project || this.busy) return;
    if (value === "approve" || value === "deny") {
      this.busy = true;
      try { await c.approveWorkspace(value === "approve", this.dialog.sessionId, this.approvalId); }
      finally { this.busy = false; this.tui.requestRender(); }
      return;
    }
    if (value === "base" || value === "import") {
      this.step = value === "base" ? "base" : "path";
      this.input = value === "base" ? new Input({ prompt: "Base ref: " }) : new DirectoryInput(() => this.tui.requestRender());
      this.input.focused = this.focused;
      if (value === "base") this.input.setValue(project.workspaceDefault?.kind === "new" ? project.workspaceDefault.baseRef : "HEAD");
      this.input.onSubmit = (text) => {
        if (this.step === "base") c.selectWorkspace({ kind: "new", baseRef: text.trim() });
        else {
          this.busy = true; c.notice = "Registering worktree..."; this.tui.requestRender();
          void c.importWorkspace(text.trim()).finally(() => { this.busy = false; this.tui.requestRender(); });
        }
      };
      c.notice = ""; this.tui.requestRender(); return;
    }
    c.selectWorkspace(value === "new" ? { kind: "new", baseRef: project.workspaceDefault?.kind === "new" ? project.workspaceDefault.baseRef : "HEAD" }
      : value === "main" || c.store.workspaces.some((w) => w.id === value && w.kind === "main") ? { kind: "main" } : { kind: "existing", workspaceId: value });
  }

  handleInput(data: string): void {
    if (this.busy) return;
    if (this.input instanceof DirectoryInput && this.input.dismissSuggestions(data)) { this.tui.requestRender(); return; }
    if (matchesKey(data, "escape")) {
      if (this.input) { this.input = undefined; this.step = undefined; this.controller.notice = ""; }
      else { this.controller.dialog = undefined; this.controller.notice = ""; this.controller.changed(); }
    } else if (this.input) this.input.handleInput(data);
    else this.list.handleInput(matchesKey(data, "ctrl+n") ? "\x1b[B" : matchesKey(data, "ctrl+p") ? "\x1b[A" : data);
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const c = this.controller;
    const inner = Math.max(1, width - 4);
    const session = this.dialog.sessionId ? c.session(this.dialog.sessionId) : undefined;
    const workspace = session && c.store.workspace(session);
    const lines = [bold(session ? "Session workspace" : "Workspace for new sessions"), ""];
    if (session?.workspaceSwitch?.phase === "approval") {
      lines.push(...wrapTextWithAnsi(warning("Approve external checkout?"), inner),
        ...wrapTextWithAnsi(oneLine(displayPath(session.workspaceSwitch.path)), inner),
        ...wrapTextWithAnsi(dim("Tools and checkout instructions move there. Existing edits stay put."), inner), "");
    } else if (session) {
      if (session.workspaceSwitch) lines.push(dim(session.preview), "");
      const path = c.store.sessionPath(session);
      const shared = c.store.state.sessions.filter((s) => c.store.sessionPath(s) === path).length;
      lines.push(...wrapTextWithAnsi(oneLine(displayPath(path)), inner),
        ...wrapTextWithAnsi(`${c.workspaceLabel(session)} / ${shared} session${shared === 1 ? "" : "s"} / ${workspace?.managed ? "zz-managed" : "external directory"}`, inner),
        ...wrapTextWithAnsi(dim("Session deletion keeps the checkout. Agent workspace tools can request a handoff."), inner), "");
      if (workspace?.error) lines.push(...wrapTextWithAnsi(warning(oneLine(workspace.error)), inner), "");
    } else lines.push(...wrapTextWithAnsi(dim("Saved for this project. Existing conversations never move."), inner), "");
    this.listTop = lines.length + 1;
    lines.push(...(this.input ? this.input.render(inner) : this.list.render(inner)), "",
      ...wrapTextWithAnsi(c.notice ? warning(oneLine(c.notice)) : dim(this.input ? "enter save / esc back" : "arrows select / enter apply / esc close"), inner));
    return [`+${"-".repeat(Math.max(0, width - 2))}+`, ...lines.map((line) => `| ${pad(fit(line, inner), inner)} |`),
      `+${"-".repeat(Math.max(0, width - 2))}+`].map((line) => fit(line, width));
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.busy || this.input || event.y < this.listTop) return;
    return this.list.handleMouse({ ...event, x: event.x - 2, y: event.y - this.listTop, width: Math.max(1, event.width - 4) });
  }
  invalidate(): void { this.input?.invalidate(); this.list.invalidate(); }
}
