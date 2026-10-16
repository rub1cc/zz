import { Input, SelectList, fuzzyFilter, matchesKey, type Component, type Focusable, type SelectItem, type TuiAltScreen, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { Controller, Dialog } from "./controller.js";
import { accent, bold, dim, fit, oneLine, pad, warning } from "./format.js";
import type { AgentSettings } from "./model.js";

export class SettingsDialog implements Component, Focusable {
  readonly input: Input;
  private list!: SelectList;
  private items: SelectItem[];
  private size = 0;
  private busy = false;
  private listTop = 0;
  private _focused = false;
  private current: AgentSettings;
  get focused(): boolean { return this._focused; }
  set focused(value: boolean) { this._focused = value; this.input.focused = value && this.dialog.kind !== "thinking"; }

  constructor(readonly controller: Controller, readonly tui: TuiAltScreen,
    readonly dialog: Extract<Dialog, { kind: "model" | "thinking" | "skills" }>, readonly onSkill?: (name: string) => void) {
    this.input = new Input({ placeholder: dialog.kind === "skills" ? "filter skills" : "filter models", placeholderStyle: dim });
    this.current = controller.engine.configuration(dialog.sessionId ? controller.session(dialog.sessionId) : undefined);
    const active = this.current.model && `${this.current.model.provider}/${this.current.model.modelId}`;
    this.items = dialog.kind === "skills" ? dialog.skills.map((skill) => ({ value: skill.name, label: skill.name, description: skill.description }))
      : dialog.kind === "model"
      ? dialog.choices.map((m) => ({ value: `${m.provider}/${m.modelId}`, label: `${m.provider}/${m.modelId}${active === `${m.provider}/${m.modelId}` ? " (current)" : ""}`, description: m.name }))
      : (dialog.choices.find((m) => m.provider === this.current.model?.provider && m.modelId === this.current.model.modelId)?.thinkingLevels ?? [])
        .map((level) => ({ value: level, label: `${level}${level === this.current.thinkingLevel ? " (current)" : ""}` }));
    this.rebuild();
    const selected = this.items.findIndex((item) => item.value === (dialog.kind === "model" ? active : this.current.thinkingLevel));
    if (selected >= 0) this.list.setSelectedIndex(selected);
  }

  private rebuild(filterChanged = false): void {
    const size = Math.max(1, Math.min(12, Math.floor(this.tui.terminal.rows * 0.85) - (this.dialog.kind === "thinking" ? 8 : 10)));
    if (size === this.size && !filterChanged) return;
    const selected = !filterChanged && this.list?.getSelectedItem()?.value;
    this.size = size;
    const filtered = fuzzyFilter(this.items, this.input.getValue(), (item) => `${item.value} ${item.description ?? ""}`);
    this.list = new SelectList(filtered, size, {
      selectedPrefix: accent, selectedText: bold, description: dim, scrollInfo: dim, noMatch: warning,
    });
    if (selected) this.list.setSelectedIndex(Math.max(0, filtered.findIndex((m) => m.value === selected)));
    this.list.onSelect = (item) => { void this.choose(item); };
  }

  private async choose(item: SelectItem): Promise<void> {
    if (this.busy) return;
    if (this.dialog.kind === "skills") { this.onSkill?.(item.value); return; }
    this.busy = true;
    const model = this.dialog.choices.find((m) => `${m.provider}/${m.modelId}` === item.value);
    const change = this.dialog.kind === "model" && model
      ? { model: { provider: model.provider, modelId: model.modelId } }
      : { thinkingLevel: item.value as AgentSettings["thinkingLevel"] };
    await this.controller.configure(change, this.dialog.sessionId);
    this.busy = false;
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (this.busy) return;
    if (matchesKey(data, "escape")) {
      if (this.dialog.kind !== "skills" && this.dialog.returnToSettings) this.controller.showSettings(this.dialog.kind);
      else { this.controller.dialog = undefined; this.controller.notice = ""; this.controller.changed(); }
      return;
    }
    if (matchesKey(data, "ctrl+n")) this.list.handleInput("\x1b[B");
    else if (matchesKey(data, "ctrl+p")) this.list.handleInput("\x1b[A");
    else if (matchesKey(data, "up") || matchesKey(data, "down") || matchesKey(data, "enter")) this.list.handleInput(data);
    else if (this.dialog.kind !== "thinking") {
      this.input.handleInput(data); this.rebuild(true);
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    this.rebuild();
    const inner = Math.max(1, width - 4);
    const lines = [bold(this.dialog.kind === "skills" ? "Skills" : this.dialog.kind === "model" ? "Choose model" : "Thinking level"),
      dim(this.dialog.kind === "skills" ? "Select a skill, add a task, then Enter to load it"
        : this.dialog.sessionId ? "This session / applies to the next model request" : "Defaults for new sessions / saved in zz, not Pi"), ""];
    if (this.dialog.kind !== "thinking") lines.push(...this.input.render(inner), "");
    this.listTop = lines.length + 1;
    lines.push(...this.list.render(inner), "", this.controller.notice ? warning(oneLine(this.controller.notice))
      : dim(this.items.length ? "ctrl+n/p or arrows / enter select / esc cancel"
        : this.dialog.kind === "thinking" ? "Choose an available model with /model first. esc to close."
          : this.dialog.kind === "skills" ? "No skills found. Add a SKILL.md file to .pi/skills or ~/.agents/skills."
          : "No available models. Run pi and /login, then restart zz."));
    return [`+${"-".repeat(Math.max(0, width - 2))}+`, ...lines.map((line) => `| ${pad(fit(line, inner), inner)} |`),
      `+${"-".repeat(Math.max(0, width - 2))}+`].map((line) => fit(line, width));
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.busy || event.y < this.listTop) return;
    const handled = this.list.handleMouse({ ...event, x: event.x - 2, y: event.y - this.listTop, width: Math.max(1, event.width - 4) });
    if (handled) return { ...handled, focus: false };
  }

  invalidate(): void { this.list.invalidate(); this.input.invalidate(); }
}
