import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ShellResponse } from "./model.js";
import { accent, dim, fit, green, oneLine, plain, warning } from "./format.js";
import { indentLines } from "./tool-response.js";

/** Shell output is a visible response, not a collapsed tool card or a model-authored answer. */
export function renderShellResponse(response: ShellResponse, width: number): string[] {
  const lines: string[] = [];
  const wrap = (text: string) => plain(text).replace(/[\x80-\x9f]/g, "").replaceAll("\t", "  ").split("\n")
    .flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
  const contentWidth = Math.max(1, width - (width > 2 ? 2 : 0));
  lines.push(...indentLines(wrapTextWithAnsi(plain(`!${response.command}`), contentWidth), width, accent("\u276f ")),
    ...indentLines(wrapTextWithAnsi(dim(`Local shell / ${oneLine(response.cwd)}`), contentWidth), width, "\u25cf "), "");
  if (response.droppedBytes || response.droppedLines) lines.push(warning("Older output omitted (showing the bounded tail)."));
  lines.push(...wrap(response.text || (response.status === "running" || response.status === "stopping" ? "Waiting for output..." : "No output.")));
  if (response.error) lines.push(...wrapTextWithAnsi(warning(oneLine(response.error)), Math.max(1, width)));
  const status = response.status === "running" ? accent("Shell running") : response.status === "stopping" ? warning("Stopping shell command...")
    : response.status === "cancelled" ? warning("Shell command cancelled") : response.status === "interrupted" ? warning("Shell interrupted; not restarted")
    : (response.status === "done" ? green : warning)(`Exit code ${response.exitCode ?? "unknown"}`);
  lines.push("", ...wrapTextWithAnsi(status, Math.max(1, width)));
  return lines.map((line) => fit(line, width));
}
