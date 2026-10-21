import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolActivity, TranscriptMessage } from "./model.js";
import { activityLabel, canGroupTool, hiddenTask, isShellTool, toolDiagnostics, toolOutput } from "./tool-response.js";
import { accent, dim, fit, oneLine, plain, red } from "./format.js";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

export interface ToolGroup { end: number; tools: ToolActivity[] }

export function normalizedToolPath(value: unknown, cwd?: string): string {
  let raw = typeof value === "string" ? plain(value).replaceAll("\\", "/") : ".";
  if (raw.startsWith("@")) raw = raw.slice(1);
  if (raw === "~" || raw.startsWith("~/")) raw = path.join(homedir(), raw.slice(2));
  if (raw.startsWith("file://")) { try { raw = fileURLToPath(raw); } catch { /* Keep malformed failed targets inspectable. */ } }
  return cwd ? path.resolve(cwd, raw) : path.normalize(raw);
}

export function invisibleActivity(message: TranscriptMessage, showThinking: boolean): boolean {
  if ("images" in message && message.images?.length) return false;
  if (message.role === "thinking") return !showThinking || !message.thinking?.redacted && !plain(message.text).trim();
  return message.role === "assistant" && !plain(message.text).trim()
    || message.role === "tool" && !!message.tool && (hiddenTask(message.tool)
      || message.tool.preparing === true && (message.tool.name === "read" || isShellTool(message.tool)));
}

/** Group only adjacent visible inspections; hidden bookkeeping is not a boundary. */
export function toolGroups(messages: TranscriptMessage[], showThinking = true): Map<number, ToolGroup> {
  const groups = new Map<number, ToolGroup>();
  for (let start = 0; start < messages.length;) {
    const first = messages[start]!;
    if (first.role !== "tool" || !first.tool || !canGroupTool(first.tool)) { start++; continue; }
    const tools: ToolActivity[] = [];
    let end = start;
    let lastTool = start;
    for (; end < messages.length; end++) {
      const message = messages[end]!;
      if (invisibleActivity(message, showThinking)) continue;
      if (message.role !== "tool" || !message.tool || !canGroupTool(message.tool)) break;
      tools.push(message.tool); lastTool = end;
    }
    groups.set(start, { end: lastTool, tools });
    start = Math.max(start + 1, end);
  }
  return groups;
}

export function toolGroupLabel(tools: ToolActivity[], cwd?: string): string {
  const parts: string[] = [];
  const pending = tools.some(tool => tool.status === "running" || tool.status === "pending");
  const queued = pending && !tools.some(tool => tool.status === "running");
  const reads = new Set(tools.filter(tool => tool.name === "read").map(tool => normalizedToolPath(tool.arguments.path, cwd))).size;
  const shells = tools.filter(isShellTool).length;
  if (reads) parts.push(`${queued ? "queued" : pending ? "reading" : "read"} ${reads} ${queued ? "file read" : "file"}${reads === 1 ? "" : "s"}`);
  if (shells) parts.push(`${queued ? "queued" : pending ? "running" : "ran"} ${shells} shell command${shells === 1 ? "" : "s"}`);
  const calls = reads + shells !== tools.length ? ` (${tools.length} calls)` : "";
  const text = parts.join(", ") + calls;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** View-local observations: replay never invents live execution or completion order. */
export class ActivityPreview {
  private previous = new Map<string, ToolActivity["status"]>();
  private started = new Map<string, number>();
  private sequence = 0;
  private open?: string;
  private wasWorking = false;
  private run?: number;

  update(messages: TranscriptMessage[], working: boolean, run?: number, interrupted = false): void {
    if (working && (!this.wasWorking || run !== this.run)) { this.started.clear(); this.open = undefined; this.sequence = 0; }
    const next = new Map<string, ToolActivity["status"]>();
    for (const message of messages) {
      if (message.role !== "tool" || !message.tool) continue;
      const tool = message.tool;
      next.set(tool.id, tool.status);
      if (!working || !canGroupTool(tool)) continue;
      const before = this.previous.get(tool.id);
      if (tool.executionOrder !== undefined) {
        this.started.set(tool.id, tool.executionOrder);
        this.sequence = Math.max(this.sequence, tool.executionOrder);
      }
      if ((tool.status === "running" || tool.status === "done" || tool.status === "error")
        && !this.started.has(tool.id) && (tool.status === "running" || before === "pending" || before === "running"
          || this.wasWorking && !this.previous.has(tool.id))) this.started.set(tool.id, ++this.sequence);
      if (this.started.has(tool.id) || tool.status === "pending") this.open = tool.id;
    }
    if (interrupted) this.open = undefined;
    this.run = run; this.previous = next; this.wasWorking = working;
  }

  member(group: ToolGroup, messages: TranscriptMessage[], showThinking: boolean): ToolActivity | undefined {
    if (!group.tools.some(tool => tool.id === this.open)) return;
    if (!messages.slice(group.end + 1).every(message => invisibleActivity(message, showThinking))) return;
    const started = group.tools.filter(tool => this.started.has(tool.id));
    return started.length ? started.reduce((latest, tool) => this.started.get(tool.id)! > this.started.get(latest.id)! ? tool : latest)
      : group.tools.find(tool => tool.status === "pending");
  }
}

export function activityPreviewLines(tool: ToolActivity, width: number, cwd?: string): string[] {
  const target = normalizedToolPath(tool.arguments.path, cwd);
  const title = tool.name === "read" ? `${tool.status === "pending" ? "Waiting to read" : "Reading"} ${path.basename(target)}`
    : `${tool.status === "pending" ? "Waiting to run" : "Running"} ${oneLine(String(tool.arguments.command ?? "").split(/\r?\n/, 1)[0] ?? "")}`;
  const rows = [fit(`  ${title}`, width)];
  const prefix = width > 4 ? "  \u23bf " : "";
  const contentWidth = Math.max(1, width - prefix.length);
  const output = tool.name === "read" ? target : toolOutput(tool).trim() || "No output";
  const visual = plain(output).replaceAll("\r", "").replaceAll("\t", "  ").split("\n")
    .flatMap(line => wrapTextWithAnsi(line, contentWidth));
  const selected = tool.name === "read" ? visual.slice(0, 1) : visual.slice(-3);
  rows.push(...selected.map((line, i) => dim(fit(`${i ? " ".repeat(prefix.length) : prefix}${line}`, width))));
  return rows;
}

export function renderToolGroup(tools: ToolActivity[], width: number, expanded: boolean, selected: boolean, cwd?: string): string[] {
  const failed = tools.filter(tool => tool.status === "error");
  const pending = tools.some(tool => tool.status === "running" || tool.status === "pending");
  const marker = selected ? accent(">") : failed.length ? red("\u2022") : pending ? accent("\u2022") : " ";
  const status = failed.length ? red(`${failed.length} failed`) + dim(" · ") : "";
  const text = toolGroupLabel(tools, cwd);
  const rows = [fit(`${width > 2 ? marker + " " : ""}${status}${dim(text)}${expanded ? dim(" (collapse)") : ""}`, width)];
  if (!expanded && failed.length) {
    const first = failed[0]!;
    const error = toolDiagnostics(first).find(item => item.severity === "error")?.message || toolOutput(first) || "Tool failed";
    const prefix = width > 4 ? "  \u23bf " : "";
    const visual = wrapTextWithAnsi(`${activityLabel(first)}: ${oneLine(error)}`, Math.max(1, width - prefix.length));
    rows.push(...visual.slice(0, 3).map((line, index) => fit(`${index ? " ".repeat(prefix.length) : prefix}${red(line)}`, width)));
  }
  return rows;
}
