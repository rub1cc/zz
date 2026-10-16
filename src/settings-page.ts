import { Input, SelectList, matchesKey, wrapTextWithAnsi, type Component, type Focusable, type SelectItem, type TuiAltScreen, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { Controller, Dialog } from "./controller.js";
import { accent, bold, dim, fit, oneLine, pad, warning } from "./format.js";
import { isCompactionTokenField, type CompactionTokenField } from "./compaction-settings.js";

const tokenLabels: Record<CompactionTokenField, string> = {
  reserveTokens: "Compaction reserve", keepRecentTokens: "Keep recent tokens", backgroundTokens: "Background lead",
};
const tokens = (value: number) => value.toLocaleString("en-US");

/** The settings overview keeps application-wide behavior separate from agent choices. */
export class SettingsPage implements Component, Focusable {
  private _focused = false;
  get focused(): boolean { return this._focused; }
  set focused(value: boolean) { this._focused = value; if (this.editing) this.editing.input.focused = value; }
  private list!: SelectList;
  private key = "";
  private listTop = 0;
  private inputTop = 0;
  private busy = false;
  private editing?: { field: CompactionTokenField; input: Input };

  constructor(readonly controller: Controller, readonly tui: TuiAltScreen,
    readonly dialog: Extract<Dialog, { kind: "settings" }>) {
    this.refresh();
  }

  private refresh(): void {
    const c = this.controller;
    const current = c.engine.configuration(this.dialog.sessionId ? c.session(this.dialog.sessionId) : undefined);
    const behavior = c.store.settings.replyBehavior;
    const showThinking = c.store.settings.showThinking !== false;
    const policy = c.store.compaction;
    const key = JSON.stringify([current, behavior, showThinking, policy, this.tui.terminal.rows, this.editing?.field]);
    if (key === this.key) return;
    const selected = this.list?.getSelectedItem()?.value ?? this.dialog.selected;
    this.key = key;
    const scope = this.dialog.sessionId ? "Session" : "New-task";
    const items: SelectItem[] = [
      { value: "replyBehavior", label: `Busy-session replies   ${behavior === "steer" ? "Steer" : "Follow-up"}` },
      { value: "model", label: `${scope} model   ${oneLine(current.model ? `${current.model.provider}/${current.model.modelId}` : "Not configured")}` },
      { value: "thinking", label: `${scope} thinking   ${current.thinkingLevel}` },
      { value: "showThinking", label: `Show reasoning   ${showThinking ? "On" : "Off"}` },
      { value: "autoCompaction", label: `Auto-compaction   ${policy.enabled ? "On" : "Off"}` },
      ...(["reserveTokens", "keepRecentTokens", "backgroundTokens"] as const)
        .map((field) => ({ value: field, label: `${tokenLabels[field]}   ${tokens(policy[field])}` })),
    ];
    const visible = Math.max(1, Math.min(items.length, Math.floor(this.tui.terminal.rows * 0.85) - (this.editing ? 14 : 12)));
    this.list = new SelectList(items, visible, {
      selectedPrefix: accent, selectedText: bold, description: dim, scrollInfo: dim, noMatch: warning,
    });
    this.list.setSelectedIndex(Math.max(0, items.findIndex((item) => item.value === selected)));
    this.list.onSelect = (item) => { void this.choose(item); };
  }

  private async choose(item: SelectItem): Promise<void> {
    if (this.busy || this.editing) return;
    const c = this.controller;
    if (item.value === "replyBehavior") {
      c.setReplyBehavior(c.store.settings.replyBehavior === "steer" ? "followUp" : "steer");
    } else if (item.value === "showThinking") {
      c.toggleThinking();
    } else if (item.value === "autoCompaction") {
      c.setCompaction({ enabled: !c.store.compaction.enabled });
    } else if (isCompactionTokenField(item.value)) {
      const field = item.value;
      const input = new Input();
      input.setValue(String(c.store.compaction[field]));
      input.handleInput("\x05");
      input.focused = this.focused;
      input.onSubmit = (value) => {
        const text = value.trim();
        if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) {
          c.fail("Enter a whole token count, without commas or units.");
        } else if (c.setCompaction({ [field]: Number(text) })) {
          this.editing = undefined;
        }
        this.refresh();
        this.tui.requestRender();
      };
      this.editing = { field, input };
      c.notice = "";
    } else if (item.value === "model" || item.value === "thinking") {
      this.busy = true;
      try { await c.settings(item.value); }
      catch (error) { c.fail(error); }
      finally { this.busy = false; }
    }
    this.refresh();
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      if (this.editing) { this.editing = undefined; this.refresh(); }
      else this.controller.dialog = undefined;
      this.controller.notice = "";
      this.controller.changed();
      return;
    }
    if (this.busy) return;
    if (this.editing) this.editing.input.handleInput(data);
    else if (matchesKey(data, "ctrl+n")) this.list.handleInput("\x1b[B");
    else if (matchesKey(data, "ctrl+p")) this.list.handleInput("\x1b[A");
    else this.list.handleInput(data === " " ? "\r" : data);
    this.tui.requestRender();
  }

  private description(selected?: string): string[] {
    const c = this.controller;
    if (selected === "replyBehavior") return ["Applies to future sends in all sessions, including existing sessions.",
      "Follow-up: wait until the current run finishes.",
      "Steer: deliver after the current tool round, before the next model request.",
      "Running tools are not aborted. Already queued messages keep their mode."];
    if (selected === "showThinking") return ["Show or hide provider reasoning (thinking blocks) in all sessions.",
      "Display only: does not change the model's thinking level or request hidden reasoning.",
      "Providers that return no thinking blocks have nothing to show."];
    if (selected === "autoCompaction" || selected && isCompactionTokenField(selected)) {
      const policy = c.store.compaction;
      const window = c.engine.stats(this.dialog.sessionId ? c.session(this.dialog.sessionId) : undefined).contextWindow;
      const blocking = window ? `For this model: block above ${tokens(window - policy.reserveTokens)} estimated tokens.`
        : "Block above context window minus compaction reserve.";
      const background = window && policy.backgroundTokens > 0
        ? `Background above ${tokens(window - policy.reserveTokens - policy.backgroundTokens)} estimated tokens.` : "";
      return ["Saved globally for all current and future sessions; not Pi's settings.",
        ...(selected === "autoCompaction" ? ["Enables threshold compaction and context-overflow recovery.",
          "Off still allows /compact. In-progress compactions are not cancelled."]
          : selected === "reserveTokens" ? ["Tokens kept free for the answer; summaries use up to 80% of this budget. Minimum: 2."]
          : selected === "keepRecentTokens" ? ["Approximate recent context kept verbatim; older turns are summarized.",
            "Also applies to manual /compact. No older eligible turns means nothing to compact."]
          : ["Start a background summary this many tokens before the blocking threshold.",
            "0 disables background compaction only; blocking and overflow recovery stay enabled when On."]),
        blocking, ...(background ? [background] : [])];
    }
    return [this.dialog.sessionId ? "Applies only to this open session." : "Defaults for new sessions; existing sessions keep their choices.",
      selected === "model" ? "Enter opens the model picker. Model changes wait for active work to finish."
        : "Enter opens supported thinking levels. Changes apply to the next model request."];
  }

  render(width: number): string[] {
    this.refresh();
    const inner = Math.max(1, width - 4);
    const lines = [bold("Settings"), dim("Saved in zz / changes apply at the next request or policy check"), ""];
    this.listTop = lines.length + 1;
    if (!this.editing || Math.floor(this.tui.terminal.rows * 0.85) >= 20) lines.push(...this.list.render(inner), "");
    if (this.editing) {
      lines.push(dim(`Edit ${tokenLabels[this.editing.field].toLowerCase()} (tokens)`));
      this.inputTop = lines.length + 1;
      lines.push(...this.editing.input.render(inner), "");
    }
    const description = this.description(this.list.getSelectedItem()?.value).flatMap((line) => wrapTextWithAnsi(dim(line), inner));
    const available = Math.max(0, Math.floor(this.tui.terminal.rows * 0.85) - lines.length - 4);
    lines.push(...description.slice(0, available), "",
      this.controller.notice ? warning(oneLine(this.controller.notice))
        : dim(this.busy ? "Loading choices... / esc close" : this.editing ? "enter save / esc cancel edit"
          : "arrows or ctrl+n/p / enter change / esc close"));
    return [`+${"-".repeat(Math.max(0, width - 2))}+`,
      ...lines.map((line) => `| ${pad(fit(line, inner), inner)} |`),
      `+${"-".repeat(Math.max(0, width - 2))}+`].map((line) => fit(line, width));
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.busy) return;
    if (this.editing) {
      if (event.y !== this.inputTop) return;
      return this.editing.input.handleMouse({ ...event, x: event.x - 2, y: 0, width: Math.max(1, event.width - 4) });
    }
    if (event.y < this.listTop) return;
    const handled = this.list.handleMouse({ ...event, x: event.x - 2, y: event.y - this.listTop, width: Math.max(1, event.width - 4) });
    if (handled) return { ...handled, focus: false };
  }

  invalidate(): void { this.list.invalidate(); this.editing?.input.invalidate(); }
}
