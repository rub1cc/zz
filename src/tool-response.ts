import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { accent, bold, dim, fit, green, oneLine, plain, red, warning } from "./format.js";
import type { ToolActivity } from "./model.js";

const bullet = "\u25cf";
const branch = "  \u23bf ";
const previewLimit = 6;

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | undefined => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as RecordValue : undefined;

/** Durable wraps final details in result, and live details in details. Old caches may have neither. */
function resultDetails(tool: ToolActivity): RecordValue | undefined {
  const details = record(tool.details);
  return record(details?.result) ?? record(details?.details) ?? details;
}

function diagnostics(tool: ToolActivity): { severity?: unknown; message: string }[] {
  const values = record(tool.details)?.diagnostics;
  return Array.isArray(values) ? values.flatMap((value) => {
    const item = record(value);
    return typeof item?.message === "string" ? [{ severity: item.severity, message: item.message }] : [];
  }) : [];
}

export function activityLabel(tool: ToolActivity): string {
  if (tool.name === "compact") return `Context compacted (${oneLine(String(tool.arguments.reason ?? "manual"))})`;
  if (tool.name === "load_skill" && typeof tool.arguments.name === "string") return `Skill ${oneLine(tool.arguments.name)}`;
  const path = typeof tool.arguments.path === "string" ? tool.arguments.path.replaceAll("\\", "/") : "";
  if (tool.name === "read" && /(^|\/)SKILL\.md$/i.test(path)) return `Skill ${oneLine(path.split("/").at(-2) || "instructions")}`;
  const names: Record<string, string> = { read: "Read", write: "Write", edit: "Update", bash: "Bash", powershell: "PowerShell",
    ask_user: "Ask user", ask_question: "Ask question", ask_multiple_questions: "Ask questions",
    task_create: "Create task", task_update: "Update tasks", task_list: "List tasks", task_get: "Get task" };
  const name = Object.hasOwn(names, tool.name) ? names[tool.name]! : tool.name;
  const target = isShellTool(tool) ? "" : path;
  return `${oneLine(name)}${target ? `(${oneLine(target)})` : ""}`;
}

function isTaskTool(tool: ToolActivity): boolean {
  return ["task_create", "task_update", "task_list", "task_get"].includes(tool.name);
}

export function isShellTool(tool: ToolActivity): boolean {
  return tool.name === "bash" || tool.name === "powershell";
}

/** Only routine, nonexceptional calls can disappear into an expandable group. */
export function canGroupTool(tool: ToolActivity): boolean {
  if (!["done", "running", "pending"].includes(tool.status) || tool.images?.length || diagnostics(tool).length
    || record(resultDetails(tool)?.truncation)?.truncated || /<harness>[\s\S]*<\/harness>\s*$/.test(tool.output)) return false;
  if (isShellTool(tool)) return typeof tool.arguments.command === "string" && !!tool.arguments.command.trim();
  return tool.name === "read" && typeof tool.arguments.path === "string" && !!tool.arguments.path.trim()
    && !/(^|[\\/])SKILL\.md$/i.test(tool.arguments.path);
}

function textLines(text: string): string[] {
  const normalized = plain(text).replaceAll("\r\n", "\n").replaceAll("\t", "  ");
  return normalized ? normalized.replace(/\n$/, "").split("\n") : [];
}

function countLines(text: string): number { return textLines(text).length; }
const linesLabel = (count: number) => `${count} line${count === 1 ? "" : "s"}`;

/** Prefix only when there is room for content; even one-cell terminals remain usable. */
export function indentLines(lines: string[], width: number, first: string, rest = " ".repeat(visibleWidth(first))): string[] {
  const prefixWidth = visibleWidth(first);
  const usePrefix = width > prefixWidth;
  return lines.map((line, index) => fit(`${usePrefix ? index === 0 ? first : rest : ""}${line}`, width));
}

function literal(text: string, width: number, prefix: string, limit = Infinity, color = (s: string) => s): string[] {
  const indent = width > visibleWidth(prefix) ? prefix : "";
  const contentWidth = Math.max(1, width - visibleWidth(indent));
  const lines: string[] = [];
  const sources = textLines(text);
  let more = false;
  for (const [index, source] of sources.entries()) {
    const wrapped = wrapTextWithAnsi(source, contentWidth);
    const remaining = limit - lines.length;
    const offset = lines.length;
    for (const [i, line] of wrapped.slice(0, remaining).entries()) {
      lines.push(`${indent === branch && offset + i > 0 ? " ".repeat(visibleWidth(indent)) : indent}${color(line)}`);
    }
    if (wrapped.length > remaining || lines.length >= limit && index < sources.length - 1) { more = true; break; }
  }
  if (more) lines.push(`${indent}${dim(fit("... more (/expand)", contentWidth))}`);
  return lines;
}

function outputText(tool: ToolActivity): string {
  // SDK diagnostics are appended to model-visible output too; render the structured version once instead.
  return diagnostics(tool).length ? tool.output.replace(/(?:\n)?<harness>\n[^]*\n<\/harness>$/, "") : tool.output;
}

function diffText(tool: ToolActivity): string | undefined {
  const diff = resultDetails(tool)?.diff;
  return typeof diff === "string" ? diff : undefined;
}

function appliedEdits(tool: ToolActivity): { oldText: string; newText: string }[] {
  const edits = Array.isArray(tool.arguments.edits) ? tool.arguments.edits : [tool.arguments];
  return edits.flatMap((value) => {
    const edit = record(value);
    return typeof edit?.oldText === "string" && typeof edit.newText === "string"
      ? [{ oldText: edit.oldText, newText: edit.newText }] : [];
  });
}

function renderCodeChanges(tool: ToolActivity, width: number): string[] {
  if (tool.status !== "done") return [];
  if (tool.name === "write" && typeof tool.arguments.content === "string") {
    const content = textLines(tool.arguments.content).map((line, i) => `${String(i + 1).padStart(3)} ${line}`).join("\n");
    return literal(content, width, "    ");
  }
  if (tool.name !== "edit") return [];
  const diff = diffText(tool);
  if (diff !== undefined) {
    // Color before wrapping so long additions/removals keep their color on every row.
    return textLines(diff).flatMap((source) => literal(source || "\n", width, "    ", Infinity,
      /^\+\s*\d+ /.test(source) ? green : /^-\s*\d+ /.test(source) ? red : dim));
  }
  // Older histories may lack SDK diff metadata. Show confirmed replacement fragments,
  // not invented file context, line numbers, or diffstats.
  return appliedEdits(tool).flatMap((edit, i) => [
    ...literal(`Applied replacement ${i + 1} (line numbers unavailable)`, width, "    ", Infinity, dim),
    ...textLines(edit.oldText).flatMap((line) => literal(`- ${line}`, width, "    ", Infinity, red)),
    ...textLines(edit.newText).flatMap((line) => literal(`+ ${line}`, width, "    ", Infinity, green)),
  ]);
}

function summary(tool: ToolActivity, output: string): string {
  if (tool.status === "pending") return `Pending...${isShellTool(tool) ? " (/expand)" : ""}`;
  if (tool.status === "running") return `Running...${isShellTool(tool) ? " (/expand)" : ""}`;
  if (tool.status === "error") return "Error (/expand)";
  if (tool.status === "interrupted") return "Interrupted; completion not confirmed. (/expand)";
  if (tool.name === "compact") return "Summary available (/expand)";
  if (tool.name === "task_update" && Array.isArray(tool.arguments.operations)) {
    const count = tool.arguments.operations.length;
    return `Applied ${count} task operation${count === 1 ? "" : "s"} (/expand)`;
  }
  if (isTaskTool(tool)) return `${tool.name === "task_create" ? "Task created" : tool.name === "task_update" ? "Task updated" : "Task details available"} (/expand)`;
  if (tool.name === "load_skill" || activityLabel(tool).startsWith("Skill ")) return "Skill instructions loaded (/expand)";
  if (tool.name === "read") {
    if (tool.images?.length) return `Read ${tool.images.length} image${tool.images.length === 1 ? "" : "s"}`;
    return `Read ${linesLabel(countLines(output))}${record(resultDetails(tool)?.truncation)?.truncated ? " (truncated)" : ""}`;
  }
  if (tool.name === "write" && typeof tool.arguments.content === "string") return `Wrote ${linesLabel(countLines(tool.arguments.content))}`;
  if (tool.name === "edit") {
    const diff = diffText(tool);
    if (diff !== undefined) {
      const lines = textLines(diff);
      const added = lines.filter((line) => /^\+\s*\d+ /.test(line)).length;
      const removed = lines.filter((line) => /^-\s*\d+ /.test(line)).length;
      return added || removed ? `Added ${linesLabel(added)}, removed ${linesLabel(removed)}` : "Updated file";
    }
    return appliedEdits(tool).length ? "Updated file (line numbers unavailable)" : "Updated file (diff unavailable)";
  }
  if (isShellTool(tool)) return "Ran 1 shell command (/expand)";
  if (["ask_user", "ask_question", "ask_multiple_questions"].includes(tool.name)) return "Question sent";
  return output ? "" : tool.images?.length ? `Returned ${tool.images.length} image${tool.images.length === 1 ? "" : "s"}` : "Done (no text output).";
}

export function renderToolResponse(tool: ToolActivity, width: number, expanded: boolean, selected: boolean): string[] {
  width = Math.max(1, width);
  const failed = tool.status === "error" || tool.status === "interrupted";
  const color = failed ? warning : tool.status === "done" ? green : accent;
  const marker = selected ? accent(">") : color(bullet);
  const output = outputText(tool);
  const label = summary(tool, output);
  const duration = tool.durationMs === undefined ? "" : tool.durationMs < 1000 ? ` (${Math.round(tool.durationMs)}ms)` : ` (${(tool.durationMs / 1000).toFixed(1)}s)`;
  const title = bold(activityLabel(tool)) + (!label ? dim(duration) : "");
  const lines = indentLines([fit(title, Math.max(1, width - (width > 2 ? 2 : 0)))], width, `${marker} `);
  if (label) lines.push(...literal(`${label}${duration}`, width, branch, Infinity, failed ? warning : dim));
  const previewPrefix = label ? "    " : branch;
  const skill = tool.name === "load_skill" || activityLabel(tool).startsWith("Skill ");
  const question = ["ask_user", "ask_question", "ask_multiple_questions"].includes(tool.name);
  for (const line of renderCodeChanges(tool, width)) lines.push(line);
  if (!expanded) {
    if (isShellTool(tool)) {
      if (tool.status === "error" && !diagnostics(tool).length && output) {
        lines.push(...indentLines([warning(fit(oneLine(textLines(output)[0] ?? ""), Math.max(1, width - (width > 4 ? 4 : 0))))], width, "    "));
      }
    } else if ((failed || !["read", "write", "edit", "compact"].includes(tool.name) && !skill && !question && !isTaskTool(tool)) && output) {
      lines.push(...literal(output, width, previewPrefix, previewLimit));
    }
  } else {
    const section = (title: string, text: string) => {
      lines.push(...literal(title, width, "    ", Infinity, dim), ...literal(text, width, "    "));
    };
    if (Object.keys(tool.arguments).length) section("Arguments", JSON.stringify(tool.arguments, null, 2));
    section("Output", output || (tool.status === "pending" || tool.status === "running" ? "Waiting for output..." : "No text output."));
    const details = JSON.stringify(tool.details, (_key, value) => value && typeof value === "object"
      && Object.keys(value).length === 0 ? undefined : value, 2);
    if (details && details !== "{}") section("Details", details);
  }
  const remarks = diagnostics(tool);
  const exceptional = (remark: { severity?: unknown }) => remark.severity === "error" || remark.severity === "warn";
  const visibleRemarks = expanded ? remarks : [...remarks.filter(exceptional), ...remarks.filter((remark) => !exceptional(remark))].slice(0, 2);
  for (const diagnostic of visibleRemarks) {
    const color = diagnostic.severity === "error" || diagnostic.severity === "warn" ? warning : dim;
    if (expanded) lines.push(...literal(diagnostic.message, width, "    ", Infinity, color));
    else lines.push(...indentLines([color(fit(oneLine(diagnostic.message), Math.max(1, width - (width > 4 ? 4 : 0))))], width, "    "));
  }
  if (!expanded && remarks.length > 2) lines.push(...indentLines([
    dim(fit("More diagnostics (/expand)", Math.max(1, width - (width > 4 ? 4 : 0)))),
  ], width, "    "));
  if (!expanded && tool.images?.length) lines.push(...literal(`${tool.images.length} image${tool.images.length === 1 ? "" : "s"} available (/expand)`, width, "    ", Infinity, dim));
  return lines.map((line) => fit(line, width));
}
