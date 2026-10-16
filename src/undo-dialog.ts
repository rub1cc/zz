import { Input, SelectList, fuzzyFilter, matchesKey, wrapTextWithAnsi,
  type Component, type Focusable, type SelectItem, type TuiAltScreen, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { Controller, Dialog } from "./controller.js";
import type { UndoResult } from "./model.js";
import { accent, bold, dim, fit, oneLine, pad, warning } from "./format.js";

/** Opening, filtering, and browsing the picker never mutates the conversation or files. */
export class UndoDialog implements Component, Focusable {
  readonly input = new Input({ placeholder: "filter checkpoints by prompt", placeholderStyle: dim });
  private list!: SelectList;
  private items: SelectItem[];
  private size = 0;
  private listTop = 0;
  private listHeight = 0;
  private busy = false;
  private _focused = false;
  get focused(): boolean { return this._focused; }
  set focused(value: boolean) { this._focused = value; this.input.focused = value; }

  constructor(readonly controller: Controller, readonly tui: TuiAltScreen,
    readonly dialog: Extract<Dialog, { kind: "undo" }>, readonly onRestored: (result: UndoResult) => void) {
    this.items = dialog.checkpoints.map((point) => ({ value: point.id,
      label: `Turn ${point.turn}: ${oneLine(point.prompt) || "(empty prompt)"}`,
      description: point.timestamp ? new Date(point.timestamp).toLocaleString() : undefined }));
    this.rebuild();
  }

  private rebuild(filterChanged = false): void {
    const size = Math.max(1, Math.min(10, Math.floor(this.tui.terminal.rows * 0.85) - 17));
    if (size === this.size && !filterChanged) return;
    const selected = !filterChanged && this.list?.getSelectedItem()?.value;
    const filtered = fuzzyFilter(this.items, this.input.getValue(), (item) => `${item.label} ${item.description ?? ""}`);
    this.list = new SelectList(filtered, size, {
      selectedPrefix: accent, selectedText: bold, description: dim, scrollInfo: dim, noMatch: warning,
    }, { minPrimaryColumnWidth: 20, maxPrimaryColumnWidth: 80 });
    this.size = size;
    if (selected) this.list.setSelectedIndex(Math.max(0, filtered.findIndex((item) => item.value === selected)));
    this.list.onSelect = (item) => { void this.choose(item); };
  }

  private async choose(item: SelectItem): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const result = await this.controller.undo(item.value, this.dialog.sessionId);
      if (result) this.onRestored(result);
    } finally { this.busy = false; this.tui.requestRender(); }
  }

  handleInput(data: string): void {
    if (this.busy) return;
    if (matchesKey(data, "escape")) {
      this.controller.dialog = undefined; this.controller.notice = ""; this.controller.changed(); return;
    }
    if (matchesKey(data, "ctrl+n")) this.list.handleInput("\x1b[B");
    else if (matchesKey(data, "ctrl+p")) this.list.handleInput("\x1b[A");
    else if (matchesKey(data, "up") || matchesKey(data, "down") || matchesKey(data, "enter")) this.list.handleInput(data);
    else { this.input.handleInput(data); this.rebuild(true); }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    this.rebuild();
    const inner = Math.max(1, width - 4);
    const lines = [bold("Restore a checkpoint"), dim("Restore conversation and tracked files to BEFORE the selected prompt."), "",
      ...this.input.render(inner), ""];
    this.listTop = lines.length + 1;
    const list = this.list.render(inner);
    this.listHeight = list.length;
    lines.push(...list, "");
    const selected = this.dialog.checkpoints.find((point) => point.id === this.list.getSelectedItem()?.value);
    if (selected) {
      const preview = wrapTextWithAnsi(oneLine(selected.prompt), inner).slice(0, 2);
      lines.push(...preview, dim(`${selected.turns} turn${selected.turns === 1 ? "" : "s"} / ${selected.files} tracked file${selected.files === 1 ? "" : "s"} will be restored`));
      lines.push(selected.shell ? warning("Shell-command effects will NOT be undone.") : dim("Selected turn and all later turns are rewound."));
      if (selected.pending) lines.push(warning("Resume the previously selected, interrupted restore."));
    }
    lines.push("", this.controller.notice ? warning(oneLine(this.controller.notice))
      : dim(this.busy ? "Restoring selected checkpoint..." : "arrows / ctrl+n/p browse · enter restore · esc cancel"));
    return [`+${"-".repeat(Math.max(0, width - 2))}+`, ...lines.map((line) => `| ${pad(fit(line, inner), inner)} |`),
      `+${"-".repeat(Math.max(0, width - 2))}+`].map((line) => fit(line, width));
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.busy || event.y < this.listTop || event.y >= this.listTop + this.listHeight) return;
    // A click only selects. Restoring always requires an explicit Enter.
    const handled = this.list.handleMouse({ ...event, type: event.type === "click" ? "press" : event.type,
      x: event.x - 2, y: event.y - this.listTop, width: Math.max(1, event.width - 4) });
    return handled && { ...handled, focus: false };
  }

  invalidate(): void { this.list.invalidate(); this.input.invalidate(); }
}
