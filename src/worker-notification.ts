import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { accent, dim, fit, markdown, oneLine, warning } from "./format.js";
import type { WorkerResult, WorkerUpdate } from "./model.js";

export interface WorkerNotice {
  title: string;
  kind: WorkerUpdate["kind"] | "notification";
  text: string;
  sessionId?: string;
  status?: string;
  truncated?: boolean;
}

function resultNotice(value: unknown): WorkerNotice | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const result = value as Partial<WorkerResult>;
  if (typeof result.result !== "string" || typeof result.title !== "string" || typeof result.status !== "string") return;
  return { title: result.title, kind: result.status === "needs-input" ? "blocker" : "result", text: result.result,
    ...(typeof result.sessionId === "string" ? { sessionId: result.sessionId } : {}), status: result.status, truncated: result.resultTruncated === true };
}

/** Old notifications embed JSON followed by instructions. Decode only the leading balanced JSON value. */
function jsonPrefix(text: string): unknown {
  const source = text.trimStart();
  if (source[0] !== "{" && source[0] !== "[") return;
  let depth = 0, quoted = false, escaped = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") {
      if (--depth === 0) {
        try { return JSON.parse(source.slice(0, index + 1)); } catch { return; }
      }
    }
  }
}

function legacyNotices(text: string, title = "", kind: WorkerNotice["kind"] = "notification"): WorkerNotice[] {
  const body = text.trim();
  for (const prefix of ["Delegated task finished:", "Worker needs input:"]) {
    if (!body.startsWith(prefix)) continue;
    const notice = resultNotice(jsonPrefix(body.slice(prefix.length)));
    if (notice) return [{ ...notice, ...(prefix === "Worker needs input:" ? { kind: "blocker" as const } : {}) }];
  }
  if (body.startsWith("Session wait ended.")) {
    const start = body.indexOf("[");
    const results = start < 0 ? undefined : jsonPrefix(body.slice(start));
    if (Array.isArray(results)) {
      const notices = results.map(resultNotice).filter((notice): notice is WorkerNotice => !!notice);
      if (notices.length === results.length && notices.length) return notices;
    }
  }
  return [{ title, kind, text }];
}

function updateNotices(update: WorkerUpdate): WorkerNotice[] {
  if (update.result) {
    const notice = resultNotice(update.result);
    if (notice) return [notice];
  }
  if (update.waitResults) return update.waitResults.filter((result) => !update.observedSessionIds?.includes(result.sessionId))
    .map(resultNotice).filter((notice): notice is WorkerNotice => !!notice);
  if (update.id.startsWith("question:")) return legacyNotices(update.message, update.title, update.kind);
  return [{ title: update.title, kind: update.kind, text: update.message, sessionId: update.sessionId }];
}

/** Display metadata is independent of the transport prompt and remains usable after restart/cache eviction. */
export function workerNotices(text: string, updates?: readonly WorkerUpdate[]): WorkerNotice[] {
  let notices: WorkerNotice[];
  if (updates?.length) notices = updates.flatMap(updateNotices);
  else if (text.startsWith("Worker updates (")) {
    const headers = [...text.matchAll(/^\[(progress|blocker|result)\] ("(?:[^"\\]|\\.)*") \(task [^\n]*\)\r?\n/gm)];
    notices = headers.flatMap((header, index) => {
      const body = text.slice(header.index! + header[0].length, headers[index + 1]?.index ?? text.length).trim();
      return legacyNotices(body, JSON.parse(header[2]!) as string, header[1] as WorkerUpdate["kind"]);
    });
    if (!notices.length) notices = legacyNotices(text);
  } else notices = legacyNotices(text);
  const seen = new Set<string>();
  return notices.filter((notice) => {
    const key = JSON.stringify([notice.sessionId ?? notice.title, notice.kind, notice.status, notice.text]);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

export function workerNoticeHeading(notice: WorkerNotice): string {
  const status = notice.status;
  const label = notice.kind === "blocker" ? "Worker needs input" : status === "completed" ? "Worker completed"
    : status === "failed" ? "Worker failed" : status === "paused" || status === "cancelled" || status === "stopped" || status === "interrupted" ? "Worker stopped"
    : status === "deleted" ? "Worker deleted" : notice.kind === "progress" ? "Worker progress" : notice.kind === "result" ? "Worker result" : "Session update";
  return notice.title ? `${label}: ${notice.title}` : label;
}

export function workerUpdatePreview(update: WorkerUpdate): string {
  return updateNotices(update).map((notice) => notice.text).join(" ");
}

export function renderWorkerNotification(text: string, updates: readonly WorkerUpdate[] | undefined, width: number): string[] {
  const lines: string[] = [];
  const indent = width > 2 ? "  " : "";
  for (const notice of workerNotices(text, updates)) {
    if (lines.length) lines.push("");
    const color = notice.kind === "blocker" || notice.status === "failed" ? warning : accent;
    lines.push(...wrapTextWithAnsi(color(oneLine(workerNoticeHeading(notice))), Math.max(1, width)));
    const body = notice.text.trim() ? markdown(notice.text, Math.max(1, width - indent.length)) : [dim("No result text.")];
    lines.push(...body.map((line) => indent + line));
    if (notice.truncated) lines.push(...wrapTextWithAnsi(dim("Result truncated; ask the agent to read the worker session."), Math.max(1, width - indent.length)).map((line) => indent + line));
  }
  return lines.map((line) => fit(line, width));
}
