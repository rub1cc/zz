import path from "node:path";
import { homedir } from "node:os";
import { getLanguageFromPath, highlightCode, initTheme, renderDiff } from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { accent, bold, dim, fit, green, oneLine, plain, red, warning } from "./format.js";
import type { ToolActivity } from "./model.js";
import { shadeDiffRow } from "./diff-background.js";

const bullet = "\u2022";
const branch = "  \u23bf ";
const previewLimit = 3;
const shellPreviewLimit = 3;
let diffThemeInitialized = false;

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | undefined => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as RecordValue : undefined;

/** Durable wraps final details in result, and live details in details. Old caches may have neither. */
function resultDetails(tool: ToolActivity): RecordValue | undefined {
  const details = record(tool.details);
  return record(details?.result) ?? record(details?.details) ?? details;
}

export function toolDiagnostics(tool: ToolActivity): { severity?: unknown; message: string }[] {
  const values = record(tool.details)?.diagnostics;
  return Array.isArray(values) ? values.flatMap((value) => {
    const item = record(value);
    return typeof item?.message === "string" ? [{ severity: item.severity, message: item.message }] : [];
  }) : [];
}

export function compactToolPath(value: unknown, cwd?: string): string {
  const raw = typeof value === "string" ? plain(value).replaceAll("\\", "/") : "";
  if (cwd && path.isAbsolute(raw)) {
    const relative = path.relative(cwd, raw);
    if (relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) return relative;
  }
  const home = homedir();
  return raw === home ? "~" : raw.startsWith(home + "/") ? "~" + raw.slice(home.length) : raw;
}

export function activityLabel(tool: ToolActivity, nameStyle = (name: string) => name, cwd?: string): string {
  if (tool.name === "compact") return `${nameStyle("Context compacted")} (${oneLine(String(tool.arguments.reason ?? "manual"))})`;
  if (tool.name === "load_skill" && typeof tool.arguments.name === "string") return `${nameStyle("Skill")} ${oneLine(tool.arguments.name)}`;
  const targetPath = compactToolPath(tool.arguments.path, cwd);
  const names: Record<string, string> = { read: "Read", write: "Write", edit: "Update", bash: "Bash", powershell: "PowerShell",
    ask_user: "Ask user", ask_question: "Ask question", ask_multiple_questions: "Ask questions",
    task_create: "Create task", task_update: "Update tasks", task_list: "List tasks", task_get: "Get task" };
  const name = Object.hasOwn(names, tool.name) ? names[tool.name]! : tool.name;
  const target = isShellTool(tool)
    ? typeof tool.arguments.command === "string" ? oneLine(tool.arguments.command.split(/\r\n?|\n|\u2028|\u2029/, 1)[0] ?? "").trim() : ""
    : targetPath;
  const offset = typeof tool.arguments.offset === "number" ? tool.arguments.offset : undefined;
  const limit = typeof tool.arguments.limit === "number" ? tool.arguments.limit : undefined;
  const range = tool.name === "read" && (offset !== undefined || limit !== undefined)
    ? `:${offset ?? 1}${limit === undefined ? "" : `-${(offset ?? 1) + limit - 1}`}` : "";
  return `${nameStyle(oneLine(name))}${target ? `(${oneLine(target)}${range})` : ""}`;
}

export function isTaskTool(tool: ToolActivity): boolean {
  return ["task_create", "task_update", "task_list", "task_get"].includes(tool.name);
}

export function hiddenTask(tool: ToolActivity): boolean {
  return isTaskTool(tool) && tool.status !== "error" && tool.status !== "interrupted"
    && !tool.images?.length && !toolDiagnostics(tool).some(item => item.severity === "error" || item.severity === "warn");
}

export function isShellTool(tool: ToolActivity): boolean {
  return tool.name === "bash" || tool.name === "powershell";
}

/** Failed inspections can group; interruption, warnings and retained-output limits cannot. */
export function canGroupTool(tool: ToolActivity): boolean {
  const remarks = toolDiagnostics(tool);
  if (tool.preparing || tool.status === "interrupted" || tool.name !== "read" && tool.images?.length
    || remarks.some(item => tool.status !== "error" || item.severity !== "error")
    || record(resultDetails(tool)?.truncation)?.truncated
    || /<harness>[\s\S]*<\/harness>\s*$/.test(tool.output) && !(tool.status === "error" && remarks.length)) return false;
  if (isShellTool(tool)) return typeof tool.arguments.command === "string" && !!tool.arguments.command.trim();
  return tool.name === "read" && typeof tool.arguments.path === "string" && !!tool.arguments.path.trim();
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

function literal(text: string, width: number, prefix: string, limit = Infinity, color = (s: string) => s, direction: "head" | "tail" = "head"): string[] {
  const indent = width > visibleWidth(prefix) ? prefix : "";
  const contentWidth = Math.max(1, width - visibleWidth(indent));
  const visual = textLines(text).flatMap(line => wrapTextWithAnsi(line, contentWidth));
  const hidden = Math.max(0, visual.length - limit);
  const selected = !hidden ? visual : direction === "tail" ? visual.slice(-limit) : visual.slice(0, limit);
  const hint = dim(fit(`... +${hidden} ${direction === "tail" ? "earlier " : ""}line${hidden === 1 ? "" : "s"} (/expand)`, contentWidth));
  const rows = hidden ? direction === "tail" ? [hint, ...selected.map(color)] : [...selected.map(color), hint] : selected.map(color);
  const lines = rows.map((line, i) => `${i && indent === branch ? " ".repeat(indent.length) : indent}${line}`);
  return lines;
}

export function toolOutput(tool: ToolActivity): string {
  // SDK diagnostics are appended to model-visible output too; render the structured version once instead.
  return toolDiagnostics(tool).length ? tool.output.replace(/(?:\n)?<harness>\n[^]*\n<\/harness>$/, "") : tool.output;
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

function highlightSource(text: string, filePath: unknown): string[] {
  const source = textLines(text).join("\n");
  const language = typeof filePath === "string" ? getLanguageFromPath(filePath) : undefined;
  if (!language || process.env.NO_COLOR !== undefined) return source.split("\n");
  try { if (!diffThemeInitialized) { initTheme(); diffThemeInitialized = true; } return highlightCode(source, language); }
  catch { return source.split("\n"); }
}

function sourceRows(text: string, width: number, filePath: unknown, limit = Infinity, numbered = false): string[] {
  const prefix = width > 4 ? "    " : "";
  const rows = highlightSource(text, filePath).flatMap((line, i) =>
    wrapTextWithAnsi(`${numbered ? String(i + 1).padStart(3) + " " : ""}${line}`, Math.max(1, width - prefix.length)));
  if (!text) return [];
  const selected = rows.slice(0, limit).map(line => prefix + line);
  if (rows.length > limit) selected.push(fit(prefix + dim(`... +${rows.length - limit} lines (/expand)`), width));
  return selected;
}

function diffRows(rows: string[], width: number, expanded: boolean): string[] {
  if (rows.length <= 24) return rows;
  return [...(expanded ? rows : rows.slice(0, 24)), fit(dim(`    (${expanded ? "click to collapse" : `${rows.length - 24} more rows; click or /expand`})`), width)];
}

function renderCodeChanges(tool: ToolActivity, width: number, expanded: boolean, codeExpanded: boolean): string[] {
  if (tool.status !== "done") return [];
  if (tool.name === "write" && typeof tool.arguments.content === "string") {
    return sourceRows(tool.arguments.content, width, tool.arguments.path, expanded ? Infinity : 3, true);
  }
  if (tool.name !== "edit") return [];
  const diff = diffText(tool);
  if (diff !== undefined) {
    const sources = textLines(diff);
    if (!sources.length) return [];
    if (!diffThemeInitialized) { initTheme(); diffThemeInitialized = true; }
    // Sanitize source before Pi renders it, then retain its generated ANSI through wrapping.
    const rendered = renderDiff(sources.join("\n"), { filePath: typeof tool.arguments.path === "string" ? tool.arguments.path : undefined });
    const indent = width > 4 ? "    " : "";
    const rows = rendered.split("\n").flatMap((line, index) => {
      // Pi's word matcher can normalize whitespace; never change the SDK's displayed source.
      const source = sources[index]!;
      const styled = plain(line) === source ? line : renderDiff(source);
      const change = /^\+\s*\d+ /.test(source) ? "added" : /^-\s*\d+ /.test(source) ? "removed" : undefined;
      const contentWidth = Math.max(1, width - indent.length);
      return wrapTextWithAnsi(styled, contentWidth)
        .map((row) => `${indent}${shadeDiffRow(row, contentWidth, change)}`);
    });
    return diffRows(rows, width, codeExpanded);
  }
  // Older histories may lack SDK diff metadata. Show confirmed replacement fragments,
  // not invented file context, line numbers, or diffstats.
  return diffRows(appliedEdits(tool).flatMap((edit, i) => [
    ...literal(`Applied replacement ${i + 1} (line numbers unavailable)`, width, "    ", Infinity, dim),
    ...textLines(edit.oldText).flatMap((line) => literal(`- ${line}`, width, "    ", Infinity, red)),
    ...textLines(edit.newText).flatMap((line) => literal(`+ ${line}`, width, "    ", Infinity, green)),
  ]), width, codeExpanded);
}

function summary(tool: ToolActivity, output: string): string {
  if (tool.preparing || tool.status === "pending" || tool.status === "running" || tool.status === "error") return "";
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
    return record(resultDetails(tool)?.truncation)?.truncated ? `Read ${linesLabel(countLines(output))} (truncated)` : "";
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
  if (isShellTool(tool)) return "";
  if (["ask_user", "ask_question", "ask_multiple_questions"].includes(tool.name)) return "Question sent";
  return output ? "" : tool.images?.length ? `Returned ${tool.images.length} image${tool.images.length === 1 ? "" : "s"}` : "Done (no text output).";
}

export interface ToolRenderOptions { cwd?: string; codeExpanded?: boolean }

export function renderToolResponse(tool: ToolActivity, width: number, expanded: boolean, selected: boolean, options: ToolRenderOptions = {}): string[] {
  width = Math.max(1, width);
  const failed = tool.status === "error" || tool.status === "interrupted";
  const color = failed ? red : tool.status === "done" ? (s: string) => s : accent;
  const marker = selected ? accent(">") : color(bullet);
  const output = toolOutput(tool);
  const shell = isShellTool(tool);
  const label = summary(tool, output);
  const duration = tool.durationMs === undefined ? "" : tool.durationMs < 1000 ? ` (${Math.round(tool.durationMs)}ms)` : ` (${(tool.durationMs / 1000).toFixed(1)}s)`;
  const headingWidth = Math.max(1, width - (width > 2 ? 2 : 0));
  const state = tool.preparing ? "preparing..." : tool.status === "pending" ? "waiting..."
    : tool.status === "running" ? "running..." : tool.status === "error" ? "Failed" : "";
  const timing = shell || !label ? dim(duration) : "";
  const nameWidth = visibleWidth(activityLabel({ ...tool, arguments: {} }));
  const stateWidth = Math.max(0, headingWidth - visibleWidth(timing) - Math.min(headingWidth, nameWidth + 4));
  const suffix = (state ? fit((failed ? red : dim)(` · ${state}`), stateWidth) : "") + timing;
  const title = fit(activityLabel(tool, bold, options.cwd), Math.max(1, headingWidth - visibleWidth(suffix))) + suffix;
  const lines = indentLines([fit(title, headingWidth)], width, `${marker} `);
  if (label) lines.push(...literal(`${label}${shell ? "" : duration}`, width, branch, Infinity, failed ? red : dim));
  const previewPrefix = label ? "    " : branch;
  const skill = tool.name === "load_skill" || activityLabel(tool).startsWith("Skill ");
  const question = ["ask_user", "ask_question", "ask_multiple_questions"].includes(tool.name);
  for (const line of renderCodeChanges(tool, width, expanded, options.codeExpanded ?? true)) lines.push(line);
  if (!expanded) {
    if (shell) {
      if (tool.status !== "pending" && plain(output).trim()) lines.push(...literal(output, width, branch, shellPreviewLimit, failed ? red : dim, "tail"));
      else if (tool.status !== "pending") lines.push(...literal("No output", width, branch, Infinity, dim));
    } else if ((failed || !["read", "write", "edit", "compact"].includes(tool.name) && !skill && !question && !isTaskTool(tool)) && output) {
      lines.push(...literal(output, width, previewPrefix, previewLimit));
    }
  } else {
    const section = (title: string, text: string) => {
      lines.push(...literal(title, width, "    ", Infinity, dim),
        ...literal(text, width, "    ", Infinity, shell && title === "Output" && !failed ? dim : (s) => s));
    };
    if (Object.keys(tool.arguments).length) section("Arguments", JSON.stringify(tool.arguments, null, 2));
    if (tool.name === "read" && !failed && output) {
      lines.push(...literal("Output", width, "    ", Infinity, dim), ...sourceRows(output, width, tool.arguments.path));
    } else section("Output", output || (tool.status === "pending" || tool.status === "running" ? "Waiting for output..." : "No text output."));
    const details = JSON.stringify(tool.details, (_key, value) => value && typeof value === "object"
      && Object.keys(value).length === 0 ? undefined : value, 2);
    if (details && details !== "{}") section("Details", details);
  }
  const remarks = toolDiagnostics(tool);
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
