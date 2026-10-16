import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ShellResponse } from "./model.js";
import { accent, bold, dim, fit, green, oneLine, plain, warning } from "./format.js";

/** Shell output is a visible response, not a collapsed tool card or a model-authored answer. */
export function renderShellResponse(response: ShellResponse, width: number): string[] {
  const lines: string[] = [];
  const wrap = (text: string) => plain(text).replace(/[\x80-\x9f]/g, "").replaceAll("\t", "  ").split("\n")
    .flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
  lines.push(...wrap(`!${response.command}`).map(bold), dim(`Local shell / ${oneLine(response.cwd)}`), "");
  if (response.droppedBytes || response.droppedLines) lines.push(warning("Older output omitted (showing the bounded tail)."));
  lines.push(...wrap(response.text || (response.status === "running" || response.status === "stopping" ? "Waiting for output..." : "No output.")));
  if (response.error) lines.push(warning(oneLine(response.error)));
  const status = response.status === "running" ? accent("Shell running") : response.status === "stopping" ? warning("Stopping shell command...")
    : response.status === "cancelled" ? warning("Shell command cancelled") : response.status === "interrupted" ? warning("Shell interrupted; not restarted")
    : (response.status === "done" ? green : warning)(`Exit code ${response.exitCode ?? "unknown"}`);
  lines.push("", status);
  return lines.map((line) => fit(line, width));
}
