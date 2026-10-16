import { SelectList, matchesKey, wrapTextWithAnsi, type Component, type Focusable, type SelectItem, type TuiAltScreen, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { Controller, Dialog } from "./controller.js";
import { accent, bold, dim, fit, oneLine, pad, warning } from "./format.js";

/** The settings overview keeps application-wide behavior separate from agent choices. */
export class SettingsPage implements Component, Focusable {
  focused = false;
  private list!: SelectList;
  private key = "";
  private listTop = 0;
  private busy = false;

  constructor(readonly controller: Controller, readonly tui: TuiAltScreen,
    readonly dialog: Extract<Dialog, { kind: "settings" }>) {
    this.refresh();
  }

  private refresh(): void {
    const c = this.controller;
    const current = c.engine.configuration(this.dialog.sessionId ? c.session(this.dialog.sessionId) : undefined);
    const behavior = c.store.settings.replyBehavior;
    const key = JSON.stringify([current, behavior]);
    if (key === this.key) return;
    const selected = this.list?.getSelectedItem()?.value ?? this.dialog.selected;
    this.key = key;
    const scope = this.dialog.sessionId ? "Session" : "New-task";
    const items: SelectItem[] = [
      { value: "replyBehavior", label: `Busy-session replies   ${behavior === "steer" ? "Steer" : "Follow-up"}` },
      { value: "model", label: `${scope} model   ${oneLine(current.model ? `${current.model.provider}/${current.model.modelId}` : "Not configured")}` },
      { value: "thinking", label: `${scope} thinking   ${current.thinkingLevel}` },
    ];
    this.list = new SelectList(items, 3, {
      selectedPrefix: accent, selectedText: bold, description: dim, scrollInfo: dim, noMatch: warning,
    });
    this.list.setSelectedIndex(Math.max(0, items.findIndex((item) => item.value === selected)));
    this.list.onSelect = (item) => { void this.choose(item); };
  }

  private async choose(item: SelectItem): Promise<void> {
    if (this.busy) return;
    const c = this.controller;
    if (item.value === "replyBehavior") {
      c.setReplyBehavior(c.store.settings.replyBehavior === "steer" ? "followUp" : "steer");
      this.refresh();
    } else if (item.value === "model" || item.value === "thinking") {
      this.busy = true;
      try { await c.settings(item.value); }
      catch (error) { c.fail(error); }
      finally { this.busy = false; }
    }
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      this.controller.dialog = undefined;
      this.controller.notice = "";
      this.controller.changed();
      return;
    }
    if (this.busy) return;
    if (matchesKey(data, "ctrl+n")) this.list.handleInput("\x1b[B");
    else if (matchesKey(data, "ctrl+p")) this.list.handleInput("\x1b[A");
    else this.list.handleInput(data === " " ? "\r" : data);
    this.tui.requestRender();
  }

  render(width: number): string[] {
    this.refresh();
    const inner = Math.max(1, width - 4);
    const lines = [bold("Settings"), dim("Saved in zz / changes apply immediately"), ""];
    this.listTop = lines.length + 1;
    lines.push(...this.list.render(inner), "");
    const selected = this.list.getSelectedItem()?.value;
    const description = selected === "replyBehavior"
      ? ["Applies to future sends in all sessions, including existing sessions.",
        "Follow-up: wait until the current run finishes.",
        "Steer: deliver after the current tool round, before the next model request.",
        "Running tools are not aborted. Already queued messages keep their mode."]
      : [this.dialog.sessionId ? "Applies only to this open session." : "Defaults for new sessions; existing sessions keep their choices.",
        selected === "model" ? "Enter opens the model picker. Model changes wait for active work to finish."
          : "Enter opens supported thinking levels. Changes apply to the next model request."];
    lines.push(...description.flatMap((line) => wrapTextWithAnsi(dim(line), inner)), "",
      this.controller.notice ? warning(oneLine(this.controller.notice))
        : dim(this.busy ? "Loading choices... / esc close" : "arrows or ctrl+n/p / enter change / esc close"));
    return [`+${"-".repeat(Math.max(0, width - 2))}+`,
      ...lines.map((line) => `| ${pad(fit(line, inner), inner)} |`),
      `+${"-".repeat(Math.max(0, width - 2))}+`].map((line) => fit(line, width));
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.busy || event.y < this.listTop) return;
    const handled = this.list.handleMouse({ ...event, x: event.x - 2, y: event.y - this.listTop, width: Math.max(1, event.width - 4) });
    if (handled) return { ...handled, focus: false };
  }

  invalidate(): void { this.list.invalidate(); }
}
