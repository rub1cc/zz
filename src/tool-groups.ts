import type { ToolActivity, TranscriptMessage } from "./model.js";
import { canGroupTool, isShellTool } from "./tool-response.js";
import { accent, bold, dim, fit, green } from "./format.js";

export interface ToolGroup {
  end: number;
  tools: ToolActivity[];
}

/** Never fold across a narrative message, mutation, question, skill, or exceptional tool result. */
export function toolGroups(messages: TranscriptMessage[]): Map<number, ToolGroup> {
  const groups = new Map<number, ToolGroup>();
  let start = 0;
  while (start < messages.length) {
    let end = start;
    const tools: ToolActivity[] = [];
    while (end < messages.length) {
      const message = messages[end]!;
      if (message.role !== "tool" || !message.tool || !canGroupTool(message.tool)) break;
      tools.push(message.tool);
      end++;
    }
    if (tools.length > 1) groups.set(start, { end: end - 1, tools });
    start = Math.max(start + 1, end);
  }
  return groups;
}

export function toolGroupLabel(tools: ToolActivity[]): string {
  const parts: string[] = [];
  for (const status of ["done", "running", "pending"] as const) {
    const matching = tools.filter((tool) => tool.status === status);
    const reads = new Set(matching.filter((tool) => tool.name === "read")
      .map((tool) => String(tool.arguments.path).replaceAll("\\", "/"))).size;
    const shells = matching.filter(isShellTool).length;
    if (reads) {
      const verb = status === "done" ? "read" : status === "running" ? "reading" : "queued";
      const noun = status === "pending" ? "file read" : "file";
      parts.push(`${verb} ${reads} ${noun}${reads === 1 ? "" : "s"}`);
    }
    if (shells) {
      const verb = status === "done" ? "ran" : status === "running" ? "running" : "queued";
      parts.push(`${verb} ${shells} shell command${shells === 1 ? "" : "s"}`);
    }
  }
  const label = parts.join(", ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function renderToolGroup(tools: ToolActivity[], width: number, expanded: boolean, selected: boolean): string[] {
  const color = tools.some((tool) => tool.status !== "done") ? accent : green;
  const prefix = width > 2 ? `${selected ? accent(">") : color("\u25cf")} ` : "";
  const hint = expanded ? " (collapse)" : " (/expand)";
  return [prefix + fit(bold(toolGroupLabel(tools)) + dim(hint), Math.max(1, width - (width > 2 ? 2 : 0)))];
}
