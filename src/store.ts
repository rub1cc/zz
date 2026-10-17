import type { CompactionFailure, CompactionStatus } from "@earendil-works/pi-durable";
import type { Usage } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { compactionPolicy, compactionSettingsError } from "./compaction-settings.js";
import { join, resolve } from "node:path";
import { isReplyBehavior, isThinkingLevel, type ShellResponse, type ImageAttachment, type AppSettings, type AgentSettings, type PendingInput, type PreparedInput, type Project, type State, type ToolActivity } from "./model.js";

export function directory(value: string): string {
  const expanded = value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
  const path = realpathSync(resolve(expanded));
  if (!statSync(path).isDirectory()) throw new Error("Choose a directory, not a file.");
  return path;
}

export function displayPath(path: string): string {
  const home = homedir();
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function isState(value: unknown): value is State {
  if (!value || typeof value !== "object") return false;
  const state = value as State;
  return state.version === 1 && Array.isArray(state.projects) && Array.isArray(state.sessions)
    && (state.defaults === undefined || isAgentSettings(state.defaults))
    && (state.settings === undefined || !!state.settings && isReplyBehavior(state.settings.replyBehavior)
      && (state.settings.showThinking === undefined || typeof state.settings.showThinking === "boolean")
      && (state.settings.compaction === undefined || compactionSettingsError(state.settings.compaction) === undefined))
    && state.projects.every((p) => typeof p.id === "string" && typeof p.path === "string"
      && (p.sessionOrder === undefined || Array.isArray(p.sessionOrder)
        && p.sessionOrder.every((id) => typeof id === "string") && new Set(p.sessionOrder).size === p.sessionOrder.length))
    && state.sessions.every((s) => typeof s.id === "string" && typeof s.projectId === "string"
      && (s.conversationId === undefined || Number.isSafeInteger(s.conversationId) && s.conversationId >= 0)
      && (s.shellResponses === undefined || Array.isArray(s.shellResponses) && s.shellResponses.every(isShellResponse)
        && new Set(s.shellResponses.map((shell) => shell.id)).size === s.shellResponses.length)
      && (s.pendingInput === undefined || isPendingInput(s.pendingInput))
      && (s.followUps === undefined || Array.isArray(s.followUps) && s.followUps.every(isPendingInput))
      && (s.queuedInputs === undefined || Array.isArray(s.queuedInputs) && s.queuedInputs.every((input) =>
        !!input && Number.isSafeInteger(input.id) && input.id >= 0 && typeof input.text === "string"
        && (input.mode === undefined || isReplyBehavior(input.mode))
        && (input.imageCount === undefined || Number.isSafeInteger(input.imageCount) && input.imageCount >= 0)))
      && typeof s.title === "string" && typeof s.preview === "string"
      && (s.titleRenamed === undefined || typeof s.titleRenamed === "boolean")
      && (s.stopped === undefined || typeof s.stopped === "boolean")
      && (s.agent === undefined || isAgentSettings(s.agent))
      && (s.compactions === undefined || Array.isArray(s.compactions) && s.compactions.every(isCompaction))
      && (s.compactionFailure === undefined || isCompactionIdentity(s.compactionFailure) && typeof s.compactionFailure.error === "string")
      && (s.usage === undefined || isUsage(s.usage))
      && (s.titleUsage === undefined || isUsage(s.titleUsage))
      && (s.context === undefined || !!s.context && nonnegative(s.context.tokens)
        && (s.context.cacheHitRate === undefined || nonnegative(s.context.cacheHitRate) && s.context.cacheHitRate <= 100))
      && ["working", "needs-input", "completed", "failed", "paused"].includes(s.status)
      && Number.isFinite(s.createdAt) && Number.isFinite(s.updatedAt)
      && (s.work === undefined || !!s.work && Number.isFinite(s.work.startedAt)
        && (s.work.finishedAt === undefined || Number.isFinite(s.work.finishedAt) && s.work.finishedAt >= s.work.startedAt))
      && Array.isArray(s.messages) && s.messages.every((m) => typeof m.text === "string"
        && ["user", "assistant", "tool", "error", "thinking"].includes(m.role) && Number.isFinite(m.timestamp)
        && (m.thinking === undefined || !!m.thinking && typeof m.thinking.id === "string"
          && (m.thinking.redacted === undefined || typeof m.thinking.redacted === "boolean"))
        && (m.images === undefined || isImages(m.images))
        && (m.tool === undefined || isToolActivity(m.tool))));
}

function isShellResponse(value: ShellResponse): boolean {
  return !!value && typeof value.id === "string" && typeof value.command === "string" && typeof value.cwd === "string"
    && typeof value.text === "string" && Number.isFinite(value.timestamp) && Number.isFinite(value.updatedAt) && value.updatedAt >= value.timestamp
    && ["running", "stopping", "done", "failed", "cancelled", "interrupted"].includes(value.status)
    && (value.exitCode === undefined || Number.isSafeInteger(value.exitCode) && value.exitCode >= 0)
    && (value.error === undefined || typeof value.error === "string")
    && Number.isSafeInteger(value.droppedBytes) && value.droppedBytes >= 0 && Number.isSafeInteger(value.droppedLines) && value.droppedLines >= 0;
}

function isCompactionIdentity(value: CompactionStatus | CompactionFailure): boolean {
  return !!value && Number.isSafeInteger(value.taskId) && value.taskId >= 0
    && ["manual", "threshold", "overflow"].includes(value.reason);
}

function isCompaction(value: CompactionStatus): boolean {
  return isCompactionIdentity(value) && typeof value.blocking === "boolean" && Number.isSafeInteger(value.attempt) && value.attempt > 0
    && (value.retry === undefined || !!value.retry && nonnegative(value.retry.at) && typeof value.retry.error === "string");
}

function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isUsage(value: Usage): boolean {
  return !!value && [value.input, value.output, value.cacheRead, value.cacheWrite, value.totalTokens].every(nonnegative)
    && !!value.cost && [value.cost.input, value.cost.output, value.cost.cacheRead, value.cost.cacheWrite, value.cost.total].every(nonnegative);
}

function isAgentSettings(value: AgentSettings): boolean {
  return !!value && isThinkingLevel(value.thinkingLevel)
    && (value.model === undefined || !!value.model && typeof value.model.provider === "string" && typeof value.model.modelId === "string");
}

export function isImages(value: unknown): value is ImageAttachment[] {
  return Array.isArray(value) && value.length <= 8 && value.every((image) => !!image && image.type === "image"
    && ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(image.mimeType)
    && typeof image.data === "string" && image.data.length > 0 && image.data.length <= 4.5 * 1024 * 1024
    && image.data.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(image.data)
    && (image.name === undefined || typeof image.name === "string"));
}

function isToolActivity(value: ToolActivity): boolean {
  return !!value && typeof value.id === "string" && typeof value.name === "string"
    && !!value.arguments && typeof value.arguments === "object" && !Array.isArray(value.arguments)
    && (value.images === undefined || isImages(value.images))
    && typeof value.output === "string" && ["pending", "running", "done", "error", "interrupted"].includes(value.status);
}

function isPendingInput(value: PendingInput): boolean {
  return !!value && typeof value.requestId === "string" && typeof value.prompt === "string"
    && (value.images === undefined || isImages(value.images))
    && (value.whenBusy === undefined || isReplyBehavior(value.whenBusy))
    && (value.prepared === undefined || isPreparedInput(value.prepared));
}

function isPreparedInput(value: PreparedInput): boolean {
  return !!value && typeof value.content === "string" && (value.skill === undefined || !!value.skill
    && typeof value.skill.name === "string" && typeof value.skill.filePath === "string" && typeof value.skill.text === "string");
}

export class Store {
  readonly state: State;
  readonly file: string;

  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.file = join(root, "state.json");
    if (existsSync(this.file)) {
      const value: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      if (!isState(value)) throw new Error(`Invalid zz state: ${this.file}. Restore it from a backup; it has not been overwritten.`);
      this.state = value;
    } else {
      this.state = { version: 1, projects: [], sessions: [] };
    }
  }

  get settings(): AppSettings {
    return { replyBehavior: this.state.settings?.replyBehavior ?? "followUp",
      ...(this.state.settings?.showThinking === undefined ? {} : { showThinking: this.state.settings.showThinking }),
      ...(this.state.settings?.compaction === undefined ? {} : { compaction: { ...this.state.settings.compaction } }) };
  }

  get compaction() { return compactionPolicy(this.state.settings?.compaction); }

  addProject(value: string): Project {
    const path = directory(value);
    let project = this.state.projects.find((p) => p.path === path);
    if (!project) {
      // Directory identity also reconnects sessions when a removed project is re-added.
      project = { id: path, path };
      this.state.projects.push(project);
    }
    this.state.selectedProjectId = project.id;
    this.save();
    return project;
  }

  save(): void {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.file);
  }
}
