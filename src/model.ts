import type { ImageContent, ModelThinkingLevel, Usage } from "@earendil-works/pi-ai";
import type { CompactionFailure, CompactionStatus, CompactionPolicy, ModelRef } from "@earendil-works/pi-durable";

export type CompactResult = "compacted" | "unchanged" | "stale" | "aborted";
export interface UndoResult { prompt: string; files: number; shell: boolean }
export interface UndoCheckpoint {
  id: string;
  prompt: string;
  turn: number;
  timestamp?: number;
  /** Includes the selected turn and every later turn. */
  turns: number;
  files: number;
  shell: boolean;
  pending?: boolean;
}

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

export interface ImageAttachment extends ImageContent { name?: string }

export interface ToolActivity {
  images?: ImageAttachment[];
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

export type ReplyBehavior = "followUp" | "steer";
export function isReplyBehavior(value: unknown): value is ReplyBehavior {
  return value === "followUp" || value === "steer";
}

export interface AppSettings {
  replyBehavior: ReplyBehavior;
  showThinking?: boolean;
  compaction?: Partial<CompactionPolicy>;
}

export type SettingsSelection = "replyBehavior" | "model" | "thinking" | "showThinking" | "autoCompaction"
  | "reserveTokens" | "keepRecentTokens" | "backgroundTokens";

export interface PendingInput {
  images?: ImageAttachment[];
  requestId: string;
  prompt: string;
  prepared?: PreparedInput;
  /** Captured at send time; changing settings never retimes an accepted message. */
  whenBusy?: ReplyBehavior;
}

export type SessionStatus = "working" | "needs-input" | "completed" | "failed" | "paused";

export interface Project {
  id: string;
  path: string;
  /** Manual dashboard order; newly created sessions appear before these IDs. */
  sessionOrder?: string[];
}

export interface Message {
  role: "user" | "assistant" | "tool" | "error" | "thinking";
  thinking?: { id: string; redacted?: boolean };
  images?: ImageAttachment[];
  text: string;
  timestamp: number;
  tool?: ToolActivity;
}

export interface ShellResponse {
  id: string;
  command: string;
  cwd: string;
  text: string;
  timestamp: number;
  updatedAt: number;
  status: "running" | "stopping" | "done" | "failed" | "cancelled" | "interrupted";
  exitCode?: number;
  error?: string;
  droppedBytes: number;
  droppedLines: number;
}

export type TranscriptMessage = Message | { role: "shell"; text: string; timestamp: number; shell: ShellResponse };

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
  /** Local display history, never submitted to the model or replayed as commands. */
  shellResponses?: ShellResponse[];
  /** Cached durable activity, refreshed from pi.live on restore. Independent of the agent run. */
  compactions?: CompactionStatus[];
  compactionFailure?: CompactionFailure;
  /** Cached presentation of the durable usage ledger, separate from title overhead. */
  usage?: Usage;
  titleUsage?: Usage;
  context?: ContextEstimate;
  id: string;
  conversationId?: number;
  /** Oldest outstanding submission; retained for compatibility with existing checkpoints. */
  pendingInput?: PendingInput;
  /** Additional outstanding submissions, including inputs awaiting durable admission. */
  followUps?: PendingInput[];
  /** Presentation cache of native pi.inbox inputs, rebuilt from the durable view. */
  queuedInputs?: { id: number; text: string; mode?: ReplyBehavior; imageCount?: number }[];
  agent?: AgentSettings;
  projectId: string;
  title: string;
  /** Protects explicitly saved names from pending automatic title generation. */
  titleRenamed?: boolean;
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
  delete session.followUps;
  delete session.queuedInputs;
  if (session.work && session.work.finishedAt === undefined) session.work.finishedAt = Math.max(session.work.startedAt, now);
}

export interface State {
  version: 1;
  projects: Project[];
  sessions: Session[];
  selectedProjectId?: string;
  defaults?: AgentSettings;
  settings?: AppSettings;
}

export type Row =
  | { kind: "project"; project: Project }
  | { kind: "session"; project: Project; session: Session };

const order: Record<SessionStatus, number> = {
  "needs-input": 0, working: 1, failed: 2, paused: 3, completed: 4,
};

export function rows(state: State, projectsOnly = false): Row[] {
  return state.projects.flatMap((project): Row[] => {
    const manual = new Map(project.sessionOrder?.map((id, index) => [id, index]));
    return [
      { kind: "project", project },
      ...(projectsOnly ? [] : state.sessions
        .filter((session) => session.projectId === project.id)
        .sort((a, b) => (manual.get(a.id) ?? -1) - (manual.get(b.id) ?? -1)
          || order[displayStatus(a)] - order[displayStatus(b)] || b.createdAt - a.createdAt)
        .map((session): Row => ({ kind: "session", project, session }))),
    ];
  });
}

export function rowId(row: Row): string {
  return row.kind === "project" ? `project:${row.project.id}` : `session:${row.session.id}`;
}

function shellMessage(shell: ShellResponse): TranscriptMessage {
  return { role: "shell", text: shell.text, timestamp: shell.timestamp, shell };
}

/** Merge local responses without changing the durable transcript's native message ordering. */
export function transcriptMessages(session: Session): TranscriptMessage[] {
  if (!session.shellResponses?.length) return session.messages;
  const shells = [...session.shellResponses].sort((a, b) => a.timestamp - b.timestamp);
  const merged: TranscriptMessage[] = [];
  let next = 0;
  for (const message of session.messages) {
    while (next < shells.length && shells[next]!.timestamp < message.timestamp) merged.push(shellMessage(shells[next++]!));
    merged.push(message);
  }
  while (next < shells.length) merged.push(shellMessage(shells[next++]!));
  return merged;
}

export function lastReplyMessage(session: Session): TranscriptMessage | undefined {
  const reply = session.messages.findLast((message) => message.role === "assistant" || message.role === "error");
  const shell = session.shellResponses?.at(-1);
  return shell && (!reply || shell.timestamp >= reply.timestamp) ? shellMessage(shell) : reply;
}

export function lastReply(session: Session): string {
  const reply = lastReplyMessage(session);
  if (reply?.role === "shell") return reply.text || reply.shell.error
    || (reply.shell.status === "running" || reply.shell.status === "stopping" ? "Running shell command..."
      : reply.shell.status === "interrupted" ? "Shell command interrupted; not restarted."
      : reply.shell.status === "cancelled" ? "Shell command cancelled." : "No output.");
  return reply?.text || (session.status === "working" ? "The agent is working. No reply yet." : "No agent reply yet.");
}

export function displayStatus(session: Session): SessionStatus {
  if (session.status === "working" || session.shellResponses?.some((shell) => shell.status === "running" || shell.status === "stopping")) return "working";
  const reply = lastReplyMessage(session);
  if (reply?.role !== "shell") return session.status;
  return reply.shell.status === "failed" ? "failed" : reply.shell.status === "cancelled" || reply.shell.status === "interrupted" ? "paused" : "completed";
}

export function activityTimestamp(session: Session): number {
  return Math.max(session.updatedAt, session.shellResponses?.at(-1)?.updatedAt ?? 0);
}

export function sessionPreview(session: Session): string {
  if (session.status === "working" || session.compactions?.length) return session.preview;
  const reply = lastReplyMessage(session);
  return reply?.role === "shell" ? `!${reply.shell.command.trim()} / ${lastReply(session)}`.replace(/\s+/g, " ").slice(0, 250) : session.preview;
}

export function age(timestamp: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  return minutes < 1 ? "now" : minutes < 60 ? `${minutes}m`
    : minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`;
}

/** Shared by dashboard previews and the transcript; compaction is not an agent reply. */
export function compactionLabel(session: Session): string | undefined {
  const current = session.compactions?.[0];
  if (!current) return;
  const reason = current.reason === "manual" ? "manual" : current.reason === "overflow" ? "auto / overflow" : "auto";
  return `Compacting context (${reason}${current.blocking ? " / blocking" : ""})${current.retry
    ? ` / retry ${current.attempt}: ${current.retry.error}` : "..."}`;
}
