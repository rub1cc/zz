import type { Usage } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isThinkingLevel, type AgentSettings, type PreparedInput, type Project, type State, type ToolActivity } from "./model.js";

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
    && state.projects.every((p) => typeof p.id === "string" && typeof p.path === "string")
    && state.sessions.every((s) => typeof s.id === "string" && typeof s.projectId === "string"
      && (s.conversationId === undefined || Number.isSafeInteger(s.conversationId) && s.conversationId >= 0)
      && (s.pendingInput === undefined || typeof s.pendingInput?.requestId === "string" && typeof s.pendingInput?.prompt === "string")
      && (s.pendingInput?.prepared === undefined || isPreparedInput(s.pendingInput.prepared))
      && typeof s.title === "string" && typeof s.preview === "string"
      && (s.stopped === undefined || typeof s.stopped === "boolean")
      && (s.agent === undefined || isAgentSettings(s.agent))
      && (s.usage === undefined || isUsage(s.usage))
      && (s.titleUsage === undefined || isUsage(s.titleUsage))
      && (s.context === undefined || !!s.context && nonnegative(s.context.tokens)
        && (s.context.cacheHitRate === undefined || nonnegative(s.context.cacheHitRate) && s.context.cacheHitRate <= 100))
      && ["working", "needs-input", "completed", "failed", "paused"].includes(s.status)
      && Number.isFinite(s.createdAt) && Number.isFinite(s.updatedAt)
      && (s.work === undefined || !!s.work && Number.isFinite(s.work.startedAt)
        && (s.work.finishedAt === undefined || Number.isFinite(s.work.finishedAt) && s.work.finishedAt >= s.work.startedAt))
      && Array.isArray(s.messages) && s.messages.every((m) => typeof m.text === "string"
        && ["user", "assistant", "tool", "error"].includes(m.role) && Number.isFinite(m.timestamp)
        && (m.tool === undefined || isToolActivity(m.tool))));
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

function isToolActivity(value: ToolActivity): boolean {
  return !!value && typeof value.id === "string" && typeof value.name === "string"
    && !!value.arguments && typeof value.arguments === "object" && !Array.isArray(value.arguments)
    && typeof value.output === "string" && ["pending", "running", "done", "error", "interrupted"].includes(value.status);
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
