import { spawn } from "node:child_process";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Input, SelectList, fuzzyFilter, matchesKey, wrapTextWithAnsi,
  type Component, type Focusable, type SelectItem, type TuiAltScreen, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { AuthFlow } from "./auth.js";
import { accent, bold, dim, fit, oneLine, pad, plain, warning } from "./format.js";

/** Provider URLs are data, never shell commands or arbitrary protocol handlers. */
export function browserUrl(value: string | undefined): string | undefined {
  if (!value || /[\x00-\x20\x7f-\x9f]/.test(value)) return;
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? value : undefined; } catch { return; }
}

export function openAuthUrl(value: string): void {
  const url = browserUrl(value);
  if (!url) return;
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  spawn(command, args, { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
}

/** Deliberately matches zz's model picker; sign-in content stays outside the composer. */
export class AuthDialog implements Component, Focusable {
  private input = new Input({ placeholder: "filter providers", placeholderStyle: dim });
  private list?: SelectList;
  private controls?: object | string;
  private filter = "";
  private listTop = 0;
  private offset = 0;
  private status = "";
  private _focused = false;
  get focused(): boolean { return this._focused; }
  set focused(value: boolean) { this._focused = value; this.input.focused = value; }

  constructor(readonly flow: AuthFlow, readonly tui: TuiAltScreen, readonly close: () => void,
    readonly open = openAuthUrl, readonly copy = copyToClipboard) {}

  private ensureControls(): void {
    const key = this.flow.prompt ?? this.flow.phase;
    if (this.controls !== key) {
      this.controls = key;
      // Recreate, rather than only clear, to discard Input's undo/kill history after a secret prompt.
      this.input = new Input({ placeholder: this.flow.phase === "choose" ? "filter providers"
        : this.flow.prompt && "placeholder" in this.flow.prompt ? this.flow.prompt.placeholder && oneLine(this.flow.safe(this.flow.prompt.placeholder)) : undefined, placeholderStyle: dim });
      this.input.focused = this.focused;
      this.input.onSubmit = (value) => {
        if (!value.trim()) return;
        this.input = new Input();
        this.input.focused = this.focused;
        this.flow.submit(value);
      };
      this.filter = "";
      this.offset = 0;
      this.status = "";
      this.rebuild();
    }
  }

  private rebuild(maxRows?: number): void {
    const prompt = this.flow.prompt;
    let items: SelectItem[] = this.flow.phase === "choose" ? this.flow.choices.map((choice) => ({
      value: choice.id, label: oneLine(choice.label), description: oneLine(choice.status),
    })) : prompt?.type === "select" ? prompt.options.map((option) => ({ value: option.id,
      label: oneLine(option.label), description: option.description && oneLine(option.description) })) : [];
    items = fuzzyFilter(items, this.filter, (item) => `${item.label} ${item.description ?? ""}`);
    const selected = this.list?.getSelectedItem()?.value;
    this.list = new SelectList(items, maxRows ?? Math.max(1, Math.min(prompt?.type === "select" ? 4 : 10, Math.floor(this.tui.terminal.rows * 0.85) - 11)), {
      selectedPrefix: accent, selectedText: bold, description: dim, scrollInfo: dim, noMatch: warning,
    });
    if (selected) this.list.setSelectedIndex(Math.max(0, items.findIndex((item) => item.value === selected)));
    this.list.onSelect = (item) => {
      if (this.flow.phase === "choose") void this.flow.choose(item.value);
      else this.flow.submit(item.value);
    };
  }

  handleInput(data: string): void {
    this.ensureControls();
    if (matchesKey(data, "escape")) { this.close(); return; }
    const url = browserUrl(this.flow.url);
    if (url && matchesKey(data, "ctrl+o")) { this.open(url); return; }
    if (url && matchesKey(data, "ctrl+x")) {
      void this.copy(url).then(() => { this.status = "Sign-in URL copied."; }, () => { this.status = "Could not copy; open the displayed URL manually."; })
        .finally(() => this.tui.requestRender());
      return;
    }
    if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
      this.offset = Math.max(0, this.offset + (matchesKey(data, "pageDown") ? 4 : -4));
    } else if (this.flow.phase === "confirm" && matchesKey(data, "enter")) void this.flow.confirm();
    else if ((this.flow.phase === "done" || this.flow.phase === "error") && matchesKey(data, "enter")) { this.close(); return; }
    else if (this.flow.phase === "choose" || this.flow.prompt?.type === "select") {
      if (matchesKey(data, "ctrl+n")) this.list?.handleInput("\x1b[B");
      else if (matchesKey(data, "ctrl+p")) this.list?.handleInput("\x1b[A");
      else if (matchesKey(data, "up") || matchesKey(data, "down") || matchesKey(data, "enter")) this.list?.handleInput(data);
      else if (this.flow.phase === "choose") { this.input.handleInput(data); this.filter = this.input.getValue(); this.rebuild(); }
    } else if (this.flow.prompt) this.input.handleInput(data);
    this.tui.requestRender();
  }

  render(width: number): string[] {
    this.ensureControls();
    const inner = Math.max(1, width - 4);
    const flow = this.flow;
    const url = browserUrl(flow.url);
    const lines = [bold(`${flow.action === "login" ? "Login" : "Logout"}${flow.selected ? ` / ${oneLine(flow.selected.name)}` : ""}`),
      dim("Credentials are shared with Pi, not stored in zz sessions."), ""];
    const budget = Math.max(1, Math.floor(this.tui.terminal.rows * 0.85) - lines.length - 4);
    const scroll = (content: string[], available: number) => {
      this.offset = Math.min(this.offset, Math.max(0, content.length - available));
      return content.slice(this.offset, this.offset + available);
    };
    if (flow.phase === "choose") {
      if (flow.choices.length) {
        lines.push(...this.input.render(inner), "");
        // Rebuild on resize as well as filtering, preserving the current selection.
        this.rebuild(Math.max(1, Math.min(10, budget - 3)));
        this.listTop = lines.length + 1;
        lines.push(...this.list!.render(inner));
      } else lines.push(...scroll(flow.messages.flatMap((message) => wrapTextWithAnsi(oneLine(message), inner)), budget));
    } else if (flow.phase === "confirm") {
      const content = [...wrapTextWithAnsi(warning(`Remove ${oneLine(flow.selected?.name ?? "")} credentials from both zz and Pi?`), inner), "",
        ...wrapTextWithAnsi(dim("This affects all sessions using this provider. Environment variables and models.json remain active. It does not revoke access at the provider."), inner)];
      lines.push(...scroll(content, budget));
    } else {
      const prompt = flow.prompt;
      const promptLines = prompt ? wrapTextWithAnsi(oneLine(flow.safe(prompt.message)), inner).slice(0, Math.min(3, Math.max(1, budget - 2))) : [];
      let controls: string[] = [];
      if (prompt?.type === "select") {
        this.rebuild(Math.max(1, Math.min(4, budget - promptLines.length - 1)));
        controls = this.list!.render(inner).slice(0, 4);
      } else if (prompt?.type === "secret") {
        controls = [`> ${"*".repeat(Math.min([...this.input.getValue()].length, Math.max(0, inner - 3)))}${this.focused ? `${CURSOR_MARKER}\x1b[7m \x1b[27m` : ""}`];
      } else if (prompt) controls = this.input.render(inner);
      const reserve = promptLines.length + controls.length;
      const topBudget = Math.max(0, budget - reserve);
      if (url && topBudget > 1) {
        const parts = wrapTextWithAnsi(url, inner).slice(0, Math.max(0, Math.min(4, topBudget - 2)));
        lines.push(...parts.map((part) => `\x1b]8;;${url}\x07${accent(part)}\x1b]8;;\x07`),
          dim("Ctrl+O open browser / Ctrl+X copy full URL"));
      } else if (flow.url && !url && topBudget > 1) lines.push(warning("Unsupported sign-in URL."));
      const content = [...flow.messages, ...(flow.progress ? [flow.progress] : [])]
        .flatMap((message) => wrapTextWithAnsi(plain(flow.safe(message)), inner));
      const available = Math.max(0, budget - (lines.length - 3) - reserve);
      lines.push(...scroll(content, available), ...promptLines);
      this.listTop = lines.length + 1;
      lines.push(...controls);
    }
    lines.push("", this.status ? dim(this.status) : dim(flow.phase === "confirm" ? "enter remove / pgup pgdn scroll / esc cancel"
      : flow.phase === "done" || flow.phase === "error" ? "enter or esc close / pgup pgdn scroll"
      : flow.phase === "choose" ? "arrows or ctrl+n/p / enter select / esc cancel" : "enter submit / pgup pgdn scroll / esc cancel"));
    return [`+${"-".repeat(Math.max(0, width - 2))}+`, ...lines.map((line) => `| ${pad(fit(line, inner), inner)} |`),
      `+${"-".repeat(Math.max(0, width - 2))}+`].map((line) => fit(line, width));
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.flow.phase !== "choose" && this.flow.prompt?.type !== "select") return;
    if (event.y < this.listTop) return;
    const result = this.list?.handleMouse({ ...event, x: event.x - 2, y: event.y - this.listTop, width: Math.max(1, event.width - 4) });
    return result && { ...result, focus: false };
  }

  invalidate(): void { this.list?.invalidate(); this.input.invalidate(); }
}
