import { Markdown, visibleWidth, wrapTextWithAnsi, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { renderShellResponse } from "./shell-response.js";
import { ImageDisplay } from "./image-display.js";
import type { Controller } from "./controller.js";
import { accent, dim, fit, markdownTheme, oneLine, pad, plain, shimmer, warning, workingIcon } from "./format.js";
import { transcriptMessages, lastReplyMessage, compactionLabel, type Message, type Session } from "./model.js";
import { answeredQuestions, formQuestion, isQuestionTool, type AnsweredQuestion, type Questionnaire } from "./questions.js";
import { indentLines, renderToolResponse } from "./tool-response.js";
import { renderToolGroup, toolGroups } from "./tool-groups.js";
export { activityLabel } from "./tool-response.js";

export function workLabel(session: Session): string | undefined {
  if (session.status === "working") {
    const state = session.stopped ? "Stopping..." : session.preview.startsWith("Retrying:") ? oneLine(session.preview)
      : session.preview === "Thinking..." || session.messages.at(-1)?.role === "thinking" ? "Thinking..." : "Working";
    return shimmer(`${workingIcon()} ${state}`);
  }
  const work = session.work;
  if (!work || work.finishedAt === undefined || session.status === "paused") return;
  const seconds = Math.max(0, Math.round((work.finishedAt - work.startedAt) / 1000));
  const duration = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const time = new Date(work.finishedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const result = session.status === "failed" ? "failed" : session.status === "needs-input" ? "awaiting input" : "done";
  return dim(`✻ Worked for ${duration} · ${result} ${time}`);
}

export function renderAnsweredQuestions(answers: AnsweredQuestion[], width: number): string[] {
  const lines = wrapTextWithAnsi("● User answered the agent's questions:", Math.max(1, width));
  for (const [index, answer] of answers.entries()) {
    const prefix = width >= 8 ? index === 0 ? "  ⎿ · " : "    · " : "";
    const content = `${oneLine(answer.question)} → ${oneLine(answer.answer)}`;
    lines.push(...wrapTextWithAnsi(content, Math.max(1, width - visibleWidth(prefix)))
      .map((line, i) => dim(`${i === 0 ? prefix : " ".repeat(visibleWidth(prefix))}${line}`)));
  }
  return lines;
}

export class Transcript implements Component {
  private sessionId?: string;
  private cache: { text: string; role: Message["role"]; renderer: Markdown }[] = [];
  private expanded = new Set<string>();
  private groupMembers = new Map<string, string[]>();
  private collapsedThinking = new Set<string>();
  private readonly images: ImageDisplay;
  private ids: string[] = [];
  private hits = new Map<number, string>();
  readonly positions = new Map<string, number>();
  selected?: string;

  constructor(readonly controller: Controller, readonly changed: () => void) { this.images = new ImageDisplay(changed); }

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
    if (id.startsWith("thinking:")) {
      if (expand ?? this.collapsedThinking.has(id)) this.collapsedThinking.delete(id); else this.collapsedThinking.add(id);
    } else {
      const members = this.groupMembers.get(id) ?? [id];
      const open = expand ?? !members.some((member) => this.expanded.has(member));
      for (const member of members) { if (open) this.expanded.add(member); else this.expanded.delete(member); }
    }
    this.changed();
  }

  toggleAll(expand: boolean): void {
    for (const id of this.ids) {
      if (id.startsWith("thinking:")) { if (expand) this.collapsedThinking.delete(id); else this.collapsedThinking.add(id); }
      else for (const member of this.groupMembers.get(id) ?? [id]) {
        if (expand) this.expanded.add(member); else this.expanded.delete(member);
      }
    }
    this.changed();
  }

  render(width: number): string[] {
    const session = this.controller.opened;
    if (!session) return [];
    if (this.sessionId !== session.id) {
      this.sessionId = session.id; this.cache = []; this.expanded.clear(); this.collapsedThinking.clear(); this.images.clear(); this.selected = undefined;
    }
    this.ids = []; this.hits.clear(); this.positions.clear();
    const messages = transcriptMessages(session);
    const groups = toolGroups(messages);
    this.groupMembers.clear();
    // The first call anchors a growing group; expansion remains attached to its member calls.
    for (const group of groups.values()) {
      const id = group.tools[0]!.id;
      const members = group.tools.map((tool) => tool.id);
      this.groupMembers.set(id, members);
      if (this.selected && members.includes(this.selected)) this.selected = id;
    }
    this.cache.length = messages.length;
    const lines: string[] = [];
    let question: Questionnaire | undefined;
    let groupedThrough = -1;
    for (const [index, message] of messages.entries()) {
      if (index <= groupedThrough) continue;
      const group = groups.get(index);
      if (group) {
        const id = group.tools[0]!.id;
        const open = group.tools.some((tool) => this.expanded.has(tool.id));
        const start = lines.length;
        this.ids.push(id);
        for (const tool of group.tools) this.positions.set(tool.id, start);
        lines.push(...renderToolGroup(group.tools, width, open, this.selected === id));
        if (open) for (const tool of group.tools) lines.push(...renderToolResponse(tool, width, true, false), "");
        for (let y = start; y < lines.length; y++) this.hits.set(y, id);
        lines.push("");
        groupedThrough = group.end;
        continue;
      }
      if (message.role === "shell") {
        lines.push(...renderShellResponse(message.shell, Math.max(1, width)), "");
        continue;
      }
      if (message.role === "thinking") {
        if (this.controller.store.settings.showThinking === false) continue;
        const id = message.thinking?.id ?? `thinking:${index}:${message.timestamp}`;
        this.ids.push(id); this.positions.set(id, lines.length); this.hits.set(lines.length, id);
        const open = !this.collapsedThinking.has(id);
        const heading = `${message.thinking?.redacted ? "Thinking (redacted)" : "Thinking"}${open ? "" : " (/expand)"}`;
        lines.push(...indentLines(wrapTextWithAnsi(dim(heading), Math.max(1, width - (width > 2 ? 2 : 0))), width,
          `${this.selected === id ? accent(">") : dim("✻")} `));
        if (open && (message.text || message.thinking?.redacted)) {
          const text = message.thinking?.redacted ? "Thinking was redacted by the provider." : message.text;
          for (const source of plain(text).split("\n")) lines.push(...wrapTextWithAnsi(source.replaceAll("\t", "  "), Math.max(1, width - (width > 4 ? 4 : 0))).map((line) => `${width > 4 ? "    " : ""}${dim(line)}`));
        }
        lines.push(""); continue;
      }
      if (message.role === "tool") {
        const tool = message.tool ?? { id: `legacy:${index}:${message.timestamp}`, name: "Tool output", arguments: {}, output: message.text, status: "done" };
        if (isQuestionTool(tool.name)) question = tool.status === "done" ? formQuestion(tool) : undefined;
        const id = tool.id;
        this.ids.push(id); this.positions.set(id, lines.length); this.hits.set(lines.length, id);
        const open = this.expanded.has(id);
        const start = lines.length;
        lines.push(...renderToolResponse(tool, width, open, this.selected === id));
        for (let y = start; y < lines.length; y++) this.hits.set(y, id);
        if (open && tool.images?.length) lines.push(...this.images.render(tool.images, `tool:${tool.id}`, Math.max(1, width)));
        lines.push("");
        continue;
      }
      if (message.role === "user") {
        const answers = question && answeredQuestions(message.text, question);
        question = undefined;
        if (answers) {
          lines.push(...renderAnsweredQuestions(answers, width));
          if (message.images?.length) lines.push(...this.images.render(message.images, `message:${index}:${message.timestamp}`, Math.max(1, width)));
          lines.push("");
          continue;
        }
      }
      const contentWidth = Math.max(1, width - (width > 2 ? 2 : 0));
      if (message.role === "user") {
        const content = plain(message.text).replaceAll("\t", "  ").split("\n")
          .flatMap((line) => wrapTextWithAnsi(line, contentWidth));
        lines.push(...indentLines(content, width, "❯ ").map((line) =>
          `\x1b[48;2;238;238;238m\x1b[38;2;32;32;32m${pad(line, width)}\x1b[39m\x1b[49m`));
      } else {
        let cached = this.cache[index];
        if (!cached || cached.text !== message.text || cached.role !== message.role) {
          cached = { text: message.text, role: message.role, renderer: new Markdown(plain(message.text), 0, 0, markdownTheme) };
          this.cache[index] = cached;
        }
        if (message.role === "error") {
          lines.push(warning("● Error"));
          lines.push(...indentLines(cached.renderer.render(Math.max(1, width - (width > 4 ? 4 : 0))), width, "  ⎿ ").map(warning));
        } else if (message.text) lines.push(...indentLines(cached.renderer.render(contentWidth), width, "● "));
      }
      if (message.images?.length) lines.push(...this.images.render(message.images, `message:${index}:${message.timestamp}`, Math.max(1, width)));
      lines.push("");
    }
    if (this.selected && !this.ids.includes(this.selected)) this.selected = undefined;
    const compacting = compactionLabel(session);
    if (compacting) lines.push(...wrapTextWithAnsi(accent(oneLine(compacting)), Math.max(1, width)), "");
    if (session.compactionFailure) lines.push(...wrapTextWithAnsi(warning(oneLine(`Compaction failed (${session.compactionFailure.reason}): ${session.compactionFailure.error}`)), Math.max(1, width)), "");
    if (session.queuedInputs?.length) {
      const modes = new Set(session.queuedInputs.map((input) => input.mode ?? "followUp"));
      const label = modes.size > 1 ? "Queued messages" : modes.has("steer") ? "Queued steering" : "Queued follow-ups";
      lines.push(accent(`${label} (${session.queuedInputs.length})`));
      for (const [index, input] of session.queuedInputs.entries()) {
        const mode = modes.size > 1 ? `[${input.mode === "steer" ? "steer" : "follow-up"}] ` : "";
        for (const [lineIndex, source] of plain(`${input.text}${input.imageCount ? ` [${input.imageCount} image${input.imageCount === 1 ? "" : "s"}]` : ""}`).split("\n").entries()) {
          const prefix = lineIndex === 0 ? `${index + 1}. ${mode}` : "   ";
          lines.push(...wrapTextWithAnsi(`${prefix}${source}`, Math.max(1, width)).map((line) => dim(line)));
        }
      }
      lines.push("");
    }
    const status = session.status !== "working" && lastReplyMessage(session)?.role === "shell" ? undefined : workLabel(session);
    if (status) lines.push(...wrapTextWithAnsi(status, Math.max(1, width)), "");
    if (session.status === "needs-input") lines.push(...wrapTextWithAnsi(accent("? Waiting for your answer"), Math.max(1, width)), "");
    if (session.status === "paused") lines.push(...wrapTextWithAnsi(dim(session.stopped ? "Stopped. Reply to continue." : "Paused. Reply to continue."), Math.max(1, width)), "");
    return lines.map((line) => fit(line, width));
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const id = this.hits.get(event.y);
    if (!id || event.type !== "click" || event.button !== "left") return;
    this.selected = id; this.toggle();
    return { handled: true, render: true };
  }

  invalidate(): void { for (const cached of this.cache) cached?.renderer.invalidate(); this.images.invalidate(); }
}
