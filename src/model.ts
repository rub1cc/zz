import type { ModelThinkingLevel, Usage } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";

export const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export function isThinkingLevel(value: unknown): value is ModelThinkingLevel {
  return thinkingLevels.includes(value as ModelThinkingLevel);
}

export interface AgentSettings {
  model?: ModelRef;
  thinkingLevel: ModelThinkingLevel;
}

export interface ModelOption extends ModelRef {
  name: string;
  thinkingLevels: ModelThinkingLevel[];
}

export interface ToolActivity {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  output: string;
  status: "pending" | "running" | "done" | "error" | "interrupted";
  durationMs?: number;
  details?: unknown;
}

export interface SkillOption {
  name: string;
  description: string;
  filePath: string;
}

export interface PreparedInput {
  content: string;
  skill?: { name: string; filePath: string; text: string };
}

export type SessionStatus = "working" | "needs-input" | "completed" | "failed" | "paused";

export interface Project {
  id: string;
  path: string;
}

export interface Message {
  role: "user" | "assistant" | "tool" | "error";
  text: string;
  timestamp: number;
  tool?: ToolActivity;
}

export interface ContextEstimate {
  tokens: number;
  cacheHitRate?: number;
}

export interface SessionStats {
  usage?: Usage;
  titleUsage?: Usage;
  context?: ContextEstimate;
  contextWindow?: number;
}

export interface Session {
  /** Cached presentation of the durable usage ledger, separate from title overhead. */
  usage?: Usage;
  titleUsage?: Usage;
  context?: ContextEstimate;
  id: string;
  conversationId?: number;
  pendingInput?: { requestId: string; prompt: string; prepared?: PreparedInput };
  agent?: AgentSettings;
  projectId: string;
  title: string;
  status: SessionStatus;
  /** Explicit cancellation is not checkpoint recovery: wait for the user's next reply. */
  stopped?: boolean;
  preview: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
  work?: { startedAt: number; finishedAt?: number };
}

export function finishWork(session: Session, now = Date.now()): void {
  if (session.work && session.work.finishedAt === undefined && session.status !== "working" && session.status !== "paused") {
    session.work.finishedAt = Math.max(session.work.startedAt, now);
  }
}

export function markStopped(session: Session, now = Date.now()): void {
  session.stopped = true;
  session.status = "paused";
  session.preview = "Stopped. Reply to continue.";
  session.updatedAt = now;
  delete session.pendingInput;
  if (session.work && session.work.finishedAt === undefined) session.work.finishedAt = Math.max(session.work.startedAt, now);
}

export interface State {
  version: 1;
  projects: Project[];
  sessions: Session[];
  selectedProjectId?: string;
  defaults?: AgentSettings;
}

export type Row =
  | { kind: "project"; project: Project }
  | { kind: "session"; project: Project; session: Session };

const order: Record<SessionStatus, number> = {
  "needs-input": 0, working: 1, failed: 2, paused: 3, completed: 4,
};

export function rows(state: State, projectsOnly = false): Row[] {
  return state.projects.flatMap((project): Row[] => [
    { kind: "project", project },
    ...(projectsOnly ? [] : state.sessions
      .filter((session) => session.projectId === project.id)
      .sort((a, b) => order[a.status] - order[b.status] || b.createdAt - a.createdAt)
      .map((session): Row => ({ kind: "session", project, session }))),
  ]);
}

export function rowId(row: Row): string {
  return row.kind === "project" ? `project:${row.project.id}` : `session:${row.session.id}`;
}

export function lastReply(session: Session): string {
  return session.messages.findLast((message) => message.role === "assistant" || message.role === "error")?.text
    || (session.status === "working" ? "The agent is working. No reply yet." : "No agent reply yet.");
}

export function age(timestamp: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  return minutes < 1 ? "now" : minutes < 60 ? `${minutes}m`
    : minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`;
}
