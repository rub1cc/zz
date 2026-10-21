import { isDeepStrictEqual } from "node:util";
import { Markdown, visibleWidth, wrapTextWithAnsi, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { renderShellResponse } from "./shell-response.js";
import { ImageDisplay } from "./image-display.js";
import type { Controller } from "./controller.js";
import { accent, dim, fit, markdownTheme, oneLine, pad, plain, shimmer, warning, workingIcon } from "./format.js";
import { transcriptMessages, lastReplyMessage, compactionLabel, displayStatus, sessionPreview, type Message, type Session, type TranscriptMessage } from "./model.js";
import { answeredQuestions, formQuestion, isQuestionTool, type AnsweredQuestion, type Questionnaire } from "./questions.js";
import { hiddenTask, indentLines, renderToolResponse } from "./tool-response.js";
import { ActivityPreview, activityPreviewLines, invisibleActivity, renderToolGroup, toolGroups } from "./tool-groups.js";
export { activityLabel } from "./tool-response.js";

export function formatWorkingDuration(seconds: number): string {
  let remaining = Math.max(0, Math.floor(seconds));
  const parts: string[] = [];
  for (const [unit, size] of [["d", 86400], ["h", 3600], ["m", 60], ["s", 1]] as const) {
    const value = Math.floor(remaining / size); remaining %= size;
    if (value || parts.length || unit === "s") parts.push(`${value}${unit}`);
  }
  return parts.join(" ");
}

export function workLabel(session: Session): string | undefined {
  if (displayStatus(session) === "waiting") return dim(sessionPreview(session));
  if (session.status === "working") {
    const state = session.stopped ? "Stopping..." : session.preview.startsWith("Retrying:") ? oneLine(session.preview)
      : session.preview === "Thinking..." || session.messages.at(-1)?.role === "thinking" ? "Thinking..." : "Working";
    const now = Date.now();
    const elapsed = session.work ? formatWorkingDuration((now - session.work.startedAt) / 1000) : "?s";
    return `${shimmer(`${workingIcon(now)} ${state}`, now)}${dim(` (${elapsed})`)}`;
  }
  const work = session.work;
  if (!work || work.finishedAt === undefined || session.status !== "completed") return;
  const seconds = Math.max(0, Math.floor((work.finishedAt - work.startedAt) / 1000));
  if (seconds < 10) return;
  return dim(`✽ Worked for ${formatWorkingDuration(seconds)}`);
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

function thinkingId(message: Message, index: number): string {
  return message.thinking?.id ?? `thinking:${index}:${message.timestamp}`;
}

function hasThinkingContent(message: Message): boolean {
  return !!message.thinking?.redacted || !!plain(message.text).trim();
}

function thinkingLines(message: Message, width: number, open: boolean, selected: boolean): string[] {
  const heading = `${message.thinking?.redacted ? "Thinking (redacted)" : "Thinking"}${open ? "" : " (/expand)"}`;
  const lines = indentLines(wrapTextWithAnsi(dim(heading), Math.max(1, width - (width > 2 ? 2 : 0))), width,
    `${selected ? accent(">") : dim("✻")} `);
  if (open) {
    const text = message.thinking?.redacted ? "Thinking was redacted by the provider." : message.text;
    for (const source of plain(text).split("\n")) lines.push(...wrapTextWithAnsi(source.replaceAll("\t", "  "), Math.max(1, width - (width > 4 ? 4 : 0)))
      .map((line) => `${width > 4 ? "    " : ""}${dim(line)}`));
  }
  return [...lines, ""];
}

interface HistoryCheckpoint {
  index: number;
  line: number;
  ids: number;
  question?: Questionnaire;
}

interface HistoryCache {
  width: number;
  messages: TranscriptMessage[];
  showThinking: boolean;
  selected?: string;
  previews: Map<number, string>;
  lines: string[];
  checkpoints: HistoryCheckpoint[];
}

export class Transcript implements Component {
  private sessionId?: string;
  private cache: { text: string; role: Message["role"]; renderer: Markdown }[] = [];
  private historyCache?: HistoryCache;
  private expanded = new Set<string>();
  private openGroups = new Set<string>();
  private preview = new ActivityPreview();
  private parents = new Map<string, string>();
  private codeViews = new Map<string, boolean>();
  private mutations = new Set<string>();
  private observedRun?: number;
  private receiptAnchor?: string;
  private previousStatus?: Session["status"];
  readonly prompts = new Map<number, string>();
  private groupMembers = new Map<string, string[]>();
  private collapsedThinking = new Set<string>();
  private readonly images: ImageDisplay;
  private ids: string[] = [];
  private hits = new Map<number, string>();
  readonly positions = new Map<string, number>();
  selected?: string;
  lineCount = 0;

  belongsTo(sessionId: string | undefined): boolean { return this.sessionId === sessionId; }

  constructor(readonly controller: Controller, readonly changed: () => void) {
    this.images = new ImageDisplay(() => { this.historyCache = undefined; changed(); });
  }

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
    this.historyCache = undefined;
    this.selected = id;
    if (id.startsWith("thinking:")) {
      if (expand ?? this.collapsedThinking.has(id)) this.collapsedThinking.delete(id); else this.collapsedThinking.add(id);
    } else if (this.mutations.has(id)) {
      this.codeViews.set(id, expand ?? !(this.codeViews.get(id) ?? true));
    } else if (this.groupMembers.has(id)) {
      if (expand ?? !this.openGroups.has(id)) this.openGroups.add(id); else this.openGroups.delete(id);
    } else {
      if (expand ?? !this.expanded.has(id)) this.expanded.add(id); else this.expanded.delete(id);
    }
    this.changed();
  }

  toggleAll(expand: boolean): void {
    this.historyCache = undefined;
    if (expand) this.collapsedThinking.clear();
    for (const id of this.mutations) this.codeViews.set(id, expand);
    for (const [id, members] of this.groupMembers) {
      if (expand) this.openGroups.add(id); else this.openGroups.delete(id);
      for (const member of members) {
        if (expand) this.expanded.add(member); else this.expanded.delete(member);
      }
    }
    for (const id of this.ids) {
      if (id.startsWith("thinking:")) { if (expand) this.collapsedThinking.delete(id); else this.collapsedThinking.add(id); }
      else if (!this.groupMembers.has(id)) {
        if (expand) this.expanded.add(id); else this.expanded.delete(id);
      }
    }
    this.changed();
  }

  render(width: number): string[] {
    const session = this.controller.opened;
    if (!session) return [];
    if (this.sessionId !== session.id) {
      this.sessionId = session.id; this.cache = []; this.openGroups.clear(); this.codeViews.clear();
      this.observedRun = undefined; this.receiptAnchor = undefined; this.previousStatus = undefined;
      this.preview = new ActivityPreview(); this.expanded.clear(); this.collapsedThinking.clear(); this.images.clear(); this.selected = undefined;
      this.historyCache = undefined;
    }
    const messages = transcriptMessages(session);
    const showThinking = this.controller.store.settings.showThinking !== false;
    const anchor = `${messages.length}:${JSON.stringify(messages.at(-1))}`;
    if (session.status === "working") { this.observedRun = session.work?.startedAt; this.receiptAnchor = undefined; }
    else if (this.previousStatus === "working" && session.status === "completed" && this.observedRun === session.work?.startedAt) this.receiptAnchor = anchor;
    if (this.receiptAnchor !== anchor) this.receiptAnchor = undefined;
    this.previousStatus = session.status;
    this.preview.update(messages, session.status === "working", session.work?.startedAt, session.status === "paused" || session.status === "failed" || session.status === "needs-input");
    const groups = toolGroups(messages, showThinking);
    const previews = new Map([...groups].map(([index, group]) => [index, this.preview.member(group, messages, showThinking)?.id ?? ""]));
    const cached = this.historyCache;
    const reusable = cached && cached.width === width && cached.showThinking === showThinking && cached.selected === this.selected
      ? cached : undefined;
    if (reusable && isDeepStrictEqual(reusable.previews, previews) && isDeepStrictEqual(reusable.messages, messages)) {
      const lines = reusable.lines.concat(this.renderStatus(session, width));
      this.lineCount = lines.length;
      return lines;
    }
    let unchanged = 0;
    if (reusable) while (unchanged < Math.min(reusable.messages.length, messages.length)
      && isDeepStrictEqual(reusable.messages[unchanged], messages[unchanged])) unchanged++;
    if (reusable) for (const index of new Set([...previews.keys(), ...reusable.previews.keys()])) {
      if (previews.get(index) !== reusable.previews.get(index)) unchanged = Math.min(unchanged, index);
    }
    const history = this.renderHistory(messages, width, reusable, unchanged);
    // Snapshot only changed inputs; nested tool arguments can mutate in place.
    const snapshot = (reusable?.messages.slice(0, unchanged) ?? []).concat(structuredClone(messages.slice(unchanged)));
    this.historyCache = { width, showThinking, previews, selected: this.selected, messages: snapshot, ...history };
    const lines = history.lines.concat(this.renderStatus(session, width));
    this.lineCount = lines.length;
    return lines;
  }

  private renderHistory(messages: TranscriptMessage[], width: number, cached?: HistoryCache, unchanged = 0): Pick<HistoryCache, "lines" | "checkpoints"> {
    const showThinking = this.controller.store.settings.showThinking !== false;
    const groups = toolGroups(messages, showThinking);
    const cwd = this.controller.opened ? this.controller.store.sessionPath(this.controller.opened) : undefined;
    const previousParents = this.parents;
    this.parents = new Map();
    this.groupMembers.clear();
    this.mutations = new Set(messages.flatMap(message => message.role === "tool" && message.tool?.name === "edit" ? [message.tool.id] : []));
    for (const group of groups.values()) {
      const id = `group:${group.tools[0]!.id}`;
      const members = group.tools.map(tool => tool.id);
      this.groupMembers.set(id, members);
      for (const member of members) this.parents.set(member, id);
      if (this.selected && members.includes(this.selected) && !this.openGroups.has(id)) this.selected = id;
    }
    for (const [member, oldGroup] of previousParents) {
      const nextGroup = this.parents.get(member);
      if (nextGroup && this.openGroups.has(oldGroup)) this.openGroups.add(nextGroup);
    }
    if (this.selected?.startsWith("group:") && !this.groupMembers.has(this.selected)) {
      const member = [...previousParents].find(([, parent]) => parent === this.selected)?.[0];
      this.selected = member ? this.parents.get(member) ?? member : undefined;
    }
    this.cache.length = messages.length;
    // Appending a routine tool can extend a group that starts before the changed message.
    for (const [index, group] of groups) if (index < unchanged && (group.end >= unchanged)) unchanged = index;
    const resume = cached?.checkpoints.findLast((checkpoint) => checkpoint.index <= unchanged);
    const start = resume?.index ?? 0;
    const prefixLines = resume?.line ?? 0;
    const lines = cached?.lines.slice(0, prefixLines) ?? [];
    const checkpoints = cached?.checkpoints.filter((checkpoint) => checkpoint.index < start) ?? [];
    if (start) {
      this.ids.length = resume!.ids;
      for (const [id, line] of this.positions) if (line >= prefixLines) this.positions.delete(id);
      for (const line of this.prompts.keys()) if (line >= prefixLines) this.prompts.delete(line);
      for (const line of this.hits.keys()) if (line >= prefixLines) this.hits.delete(line);
    } else {
      this.ids = []; this.hits.clear(); this.positions.clear(); this.prompts.clear();
    }
    let question = resume?.question;
    let groupedThrough = -1;
    for (let index = start; index < messages.length; index++) {
      if (index <= groupedThrough) continue;
      const message = messages[index]!;
      checkpoints.push({ index, line: lines.length, ids: this.ids.length, question });
      const group = groups.get(index);
      if (group) {
        const id = `group:${group.tools[0]!.id}`;
        const open = this.openGroups.has(id);
        const start = lines.length;
        this.ids.push(id); this.positions.set(id, start);
        for (const tool of group.tools) this.positions.set(tool.id, start);
        const preview = this.preview.member(group, messages, showThinking);
        const header = preview
          ? open ? activityPreviewLines(preview, width, cwd).slice(0, 1) : activityPreviewLines(preview, width, cwd)
          : renderToolGroup(group.tools, width, open, this.selected === id, cwd);
        if (preview && !open && group.tools.some(tool => tool.status === "error")) {
          header.push(fit("  " + warning(`${group.tools.filter(tool => tool.status === "error").length} failed`), width),
            ...renderToolGroup(group.tools, width, false, false, cwd).slice(1));
        }
        if (preview && this.selected === id) header[0] = fit(accent(">") + header[0]!.slice(1), width);
        lines.push(...header);
        for (let y = start; y < lines.length; y++) this.hits.set(y, id);
        if (open) {
          const indent = width > 4 ? "  " : "";
          const memberWidth = Math.max(1, width - indent.length);
          for (const tool of group.tools) {
            const memberStart = lines.length;
            this.ids.push(tool.id); this.positions.set(tool.id, memberStart);
            const expanded = this.expanded.has(tool.id);
            lines.push(...renderToolResponse(tool, memberWidth, expanded, this.selected === tool.id, { cwd }).map(line => indent + line));
            if (expanded && tool.images?.length) lines.push(...this.images.render(tool.images, `tool:${tool.id}`, memberWidth).map(line => indent + line));
            for (let y = memberStart; y < lines.length; y++) this.hits.set(y, tool.id);
            lines.push("");
          }
        }
        lines.push("");
        groupedThrough = group.end;
        continue;
      }
      if (invisibleActivity(message, showThinking)) continue;
      if (message.role === "shell") {
        lines.push(...renderShellResponse(message.shell, Math.max(1, width)), "");
        continue;
      }
      if (message.role === "thinking") {
        if (this.controller.store.settings.showThinking === false || !hasThinkingContent(message)) continue;
        const id = thinkingId(message, index);
        this.ids.push(id); this.positions.set(id, lines.length); this.hits.set(lines.length, id);
        lines.push(...thinkingLines(message, width, !this.collapsedThinking.has(id), this.selected === id));
        continue;
      }
      if (message.role === "tool") {
        if (message.tool && hiddenTask(message.tool)) continue;
        const tool = message.tool ?? { id: `legacy:${index}:${message.timestamp}`, name: "Tool output", arguments: {}, output: message.text, status: "done" };
        if (isQuestionTool(tool.name)) question = tool.status === "done" ? formQuestion(tool) : undefined;
        const id = tool.id;
        this.ids.push(id); this.positions.set(id, lines.length); this.hits.set(lines.length, id);
        const open = this.expanded.has(id);
        const start = lines.length;
        lines.push(...renderToolResponse(tool, width, open, this.selected === id, { cwd, codeExpanded: this.codeViews.get(id) ?? true }));
        for (let y = start; y < lines.length; y++) this.hits.set(y, id);
        if (open && tool.images?.length) lines.push(...this.images.render(tool.images, `tool:${tool.id}`, Math.max(1, width)));
        lines.push("");
        continue;
      }
      if (message.role === "user") {
        if (!message.source) this.prompts.set(lines.length, message.text);
        const answers = !message.source && question && answeredQuestions(message.text, question);
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
        if (message.source) lines.push(...wrapTextWithAnsi(dim(message.source.kind === "notification" ? "Orchestration" : `From ${oneLine(message.source.title)} (agent)`), Math.max(1, width)));
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
    checkpoints.push({ index: messages.length, line: lines.length, ids: this.ids.length, question });
    for (let i = prefixLines; i < lines.length; i++) lines[i] = fit(lines[i]!, width);
    return { lines, checkpoints };
  }

  private renderStatus(session: Session, width: number): string[] {
    const lines: string[] = [];
    const compacting = compactionLabel(session);
    if (compacting) lines.push(...wrapTextWithAnsi(accent(oneLine(compacting)), Math.max(1, width)), "");
    if (session.compactionFailure) lines.push(...wrapTextWithAnsi(warning(oneLine(`Compaction failed (${session.compactionFailure.reason}): ${session.compactionFailure.error}`)), Math.max(1, width)), "");
    const queued = session.queuedInputs ?? [];
    for (const agent of [false, true]) {
      const inputs = queued.filter(input => !!input.source === agent);
      if (!inputs.length) continue;
      const modes = new Set(inputs.map((input) => input.mode ?? "followUp"));
      const label = agent ? "Queued agent messages" : modes.size > 1 ? "Queued messages" : modes.has("steer") ? "Queued steering" : "Queued follow-ups";
      lines.push(...wrapTextWithAnsi(accent(`${label} (${inputs.length})`), Math.max(1, width)));
      for (const [index, input] of inputs.entries()) {
        if (input.source) lines.push(...wrapTextWithAnsi(dim(`From ${oneLine(input.source.title)} (agent ${input.source.kind})`), Math.max(1, width)));
        const mode = agent || modes.size > 1 ? `[${input.mode === "steer" ? "steer" : "follow-up"}] ` : "";
        for (const [lineIndex, source] of plain(`${input.text}${input.imageCount ? ` [${input.imageCount} image${input.imageCount === 1 ? "" : "s"}]` : ""}`).split("\n").entries()) {
          const prefix = lineIndex === 0 ? `${index + 1}. ${mode}` : "   ";
          lines.push(...wrapTextWithAnsi(`${prefix}${source}`, Math.max(1, width)).map((line) => dim(line)));
        }
      }
      lines.push("");
    }
    const updates = session.workerUpdates ?? [];
    if (updates.length) {
      lines.push(...wrapTextWithAnsi(accent(`Worker updates (${updates.length})`), Math.max(1, width)));
      if (updates.length > 10) lines.push(...wrapTextWithAnsi(dim(`Showing latest 10 of ${updates.length} cached updates; older reports remain in durable history.`), Math.max(1, width)));
      for (const update of updates.slice(-10)) {
        const title = Array.from(oneLine(update.title));
        const heading = `${title.length > 60 ? title.slice(0, 57).join("") + "..." : title.join("")} - ${update.kind} (${update.delivery})`;
        const content = Array.from(`${heading}: ${oneLine(update.message).trim()}`);
        const hint = "... [truncated; session_read for details]";
        const preview = content.length > 240 ? content.slice(0, 240 - hint.length).join("") + hint : content.join("");
        lines.push(...wrapTextWithAnsi(update.kind === "blocker" ? warning(preview) : dim(preview), Math.max(1, width)));
      }
      lines.push("");
    }
    const status = session.status !== "working" && (!this.receiptAnchor || lastReplyMessage(session)?.role === "shell") ? undefined : workLabel(session);
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

  invalidate(): void {
    this.historyCache = undefined;
    for (const cached of this.cache) cached?.renderer.invalidate();
    this.images.invalidate();
  }
}
