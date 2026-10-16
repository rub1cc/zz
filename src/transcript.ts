import { Markdown, visibleWidth, wrapTextWithAnsi, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { Controller } from "./controller.js";
import { accent, bold, dim, fit, green, markdownTheme, oneLine, plain, shimmer, warning } from "./format.js";
import type { Message, Session, ToolActivity } from "./model.js";

const userStyle = {
  color: (text: string) => `\x1b[38;2;32;32;32m${text}\x1b[39m`,
  bgColor: (text: string) => `\x1b[48;2;238;238;238m${text}\x1b[49m`,
};

export function activityLabel(tool: ToolActivity): string {
  if (tool.name === "load_skill" && typeof tool.arguments.name === "string") return `Skill ${tool.arguments.name}`;
  const path = typeof tool.arguments.path === "string" ? tool.arguments.path.replaceAll("\\", "/") : "";
  if (tool.name === "read" && /(^|\/)SKILL\.md$/i.test(path)) {
    return `Skill ${path.split("/").at(-2) || "instructions"}`;
  }
  const target = path || (typeof tool.arguments.command === "string" ? tool.arguments.command : "");
  return `${tool.name}${target ? ` ${target}` : ""}`;
}

export function workLabel(session: Session): string | undefined {
  if (session.status === "working") return shimmer("✻ Working");
  const work = session.work;
  if (!work || work.finishedAt === undefined || session.status === "paused") return;
  const seconds = Math.max(0, Math.round((work.finishedAt - work.startedAt) / 1000));
  const duration = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const time = new Date(work.finishedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const result = session.status === "failed" ? "failed" : session.status === "needs-input" ? "awaiting input" : "done";
  return dim(`✻ Worked for ${duration} · ${result} ${time}`);
}

export class Transcript implements Component {
  private sessionId?: string;
  private cache: { text: string; role: Message["role"]; renderer: Markdown }[] = [];
  private expanded = new Set<string>();
  private ids: string[] = [];
  private hits = new Map<number, string>();
  readonly positions = new Map<string, number>();
  selected?: string;

  constructor(readonly controller: Controller, readonly changed: () => void) {}

  move(delta: number): void {
    if (!this.ids.length) return;
    const current = this.selected ? this.ids.indexOf(this.selected) : -1;
    const index = current < 0 ? delta < 0 ? this.ids.length - 1 : 0
      : Math.max(0, Math.min(this.ids.length - 1, current + delta));
    this.selected = this.ids[index];
    this.changed();
  }

  toggle(expand?: boolean): void {
    const id = this.selected ?? this.ids.at(-1);
    if (!id) return;
    this.selected = id;
    if (expand ?? !this.expanded.has(id)) this.expanded.add(id); else this.expanded.delete(id);
    this.changed();
  }

  toggleAll(expand: boolean): void {
    for (const id of this.ids) { if (expand) this.expanded.add(id); else this.expanded.delete(id); }
    this.changed();
  }

  render(width: number): string[] {
    const session = this.controller.opened;
    if (!session) return [];
    if (this.sessionId !== session.id) {
      this.sessionId = session.id; this.cache = []; this.expanded.clear(); this.selected = undefined;
    }
    this.ids = []; this.hits.clear(); this.positions.clear();
    this.cache.length = session.messages.length;
    const lines: string[] = [];
    for (const [index, message] of session.messages.entries()) {
      if (message.role === "tool") {
        const tool = message.tool ?? { id: `legacy:${index}:${message.timestamp}`, name: "Tool output", arguments: {}, output: message.text, status: "done" };
        const id = tool.id;
        this.ids.push(id); this.positions.set(id, lines.length); this.hits.set(lines.length, id);
        const open = this.expanded.has(id);
        const color = tool.status === "error" || tool.status === "interrupted" ? warning : tool.status === "done" ? green : accent;
        const time = tool.durationMs === undefined ? "" : tool.durationMs < 1000 ? ` ${Math.round(tool.durationMs)}ms` : ` ${(tool.durationMs / 1000).toFixed(1)}s`;
        const prefix = `  ${this.selected === id ? accent(">") : " "} ${dim(open ? "[-]" : "[+]")} `;
        const suffix = `  ${color(tool.status)}${dim(time)}`;
        const label = fit(oneLine(activityLabel(tool)), Math.max(1, width - visibleWidth(prefix) - visibleWidth(suffix)));
        lines.push(`${prefix}${bold(label)}${suffix}`);
        if (open) {
          const section = (label: string, text: string) => {
            lines.push(`      ${dim(label)}`);
            for (const source of plain(text).split("\n")) {
              const wrapped = wrapTextWithAnsi(source.replaceAll("\t", "  "), Math.max(1, width - 8));
              lines.push(...(wrapped.length ? wrapped : [""]).map((line) => `      ${line}`));
            }
          };
          if (Object.keys(tool.arguments).length) section("Arguments", JSON.stringify(tool.arguments, null, 2));
          section("Output", tool.output || (tool.status === "running" || tool.status === "pending" ? "Waiting for output..." : "No text output."));
          const details = JSON.stringify(tool.details, (_key, value) => value && typeof value === "object"
            && Object.keys(value).length === 0 ? undefined : value, 2);
          if (details && details !== "{}") section("Details", details);
        }
        lines.push("");
        continue;
      }
      let cached = this.cache[index];
      if (!cached || cached.text !== message.text || cached.role !== message.role) {
        const user = message.role === "user";
        cached = { text: message.text, role: message.role,
          renderer: new Markdown(plain(message.text), user ? 1 : 0, user ? 1 : 0, markdownTheme, user ? userStyle : undefined) };
        this.cache[index] = cached;
      }
      if (message.role === "error") lines.push(`  ${warning("Error")}`);
      lines.push(...cached.renderer.render(Math.max(1, width - 4)).map((line) => `  ${line}`), "");
    }
    if (this.selected && !this.ids.includes(this.selected)) this.selected = undefined;
    const status = workLabel(session);
    if (status) lines.push(`  ${status}`, "");
    return lines.map((line) => fit(line, width));
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const id = this.hits.get(event.y);
    if (!id || event.type !== "click" || event.button !== "left") return;
    this.selected = id; this.toggle();
    return { handled: true, render: true };
  }

  invalidate(): void { for (const cached of this.cache) cached?.renderer.invalidate(); }
}
