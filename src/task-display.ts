import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { amber, black, bold, dim, fit, green, oneLine, plain } from "./format.js";
import type { Session } from "./model.js";
import type { ChecklistTask } from "./tasks.js";

export const TASK_RECENT_COMPLETION_MS = 30_000;

export interface TaskDisplayClock {
  now(): number;
  schedule(delay: number, callback: () => void): () => void;
}
const displayClock: TaskDisplayClock = {
  now: () => Date.now(),
  schedule: (delay, callback) => {
    const timer = setTimeout(callback, Math.min(2_147_483_647, Math.max(0, delay)));
    timer.unref();
    return () => clearTimeout(timer);
  },
};

type CompletionTimes = ReadonlyMap<string, number | null>;
type TaskSession = Pick<Session, "id" | "conversationId" | "tasks">;
type DisplayState = { completedAt: Map<string, number | null>; timer?: { deadline: number; cancel?: () => void } };
const scope = (session: TaskSession) => JSON.stringify([session.id, session.conversationId]);
const byId = (a: ChecklistTask, b: ChecklistTask) => Number(a.id) - Number(b.id);

export function taskVisibleLimit(rows: number): number {
  return rows <= 10 ? 0 : Math.min(5, Math.max(3, rows - 14));
}

export function taskProgress(tasks: readonly ChecklistTask[] | undefined): string | undefined {
  if (!tasks?.length) return;
  const done = tasks.filter((task) => task.status === "completed").length;
  const inProgress = tasks.filter((task) => task.status === "in_progress").length;
  return `${tasks.length} task${tasks.length === 1 ? "" : "s"} (${done} done, ${inProgress} in progress, ${tasks.length - done - inProgress} open)`;
}

function orderedTasks(tasks: readonly ChecklistTask[], count: number, completedAt: CompletionTimes, now: number): ChecklistTask[] {
  if (tasks.length <= count) return [...tasks].sort(byId);
  const unfinished = new Set(tasks.filter((task) => task.status !== "completed").map((task) => task.id));
  const priority = (task: ChecklistTask): number => {
    if (task.status === "completed") {
      const at = completedAt.get(task.id);
      return typeof at === "number" && now - at < TASK_RECENT_COMPLETION_MS ? 0 : 4;
    }
    if (task.status === "in_progress") return 1;
    return task.blockedBy.some((id) => unfinished.has(id)) ? 3 : 2;
  };
  return [...tasks].sort((a, b) => priority(a) - priority(b) || byId(a, b));
}

/** Dependencies affect overflow priority but are deliberately absent from the UI. */
export function taskChecklist(tasks: readonly ChecklistTask[] | undefined, width: number, maxLines = 7,
  options: { limit?: number; completedAt?: CompletionTimes; now?: number } = {}): string[] {
  const progress = taskProgress(tasks);
  if (!progress || !tasks || maxLines < 1) return [];
  const lines = [fit(bold(progress) + dim(" (/tasks)"), width)];
  const limit = Math.max(0, options.limit ?? 5);
  const capacity = Math.min(limit, Math.max(0, maxLines - 1));
  const count = tasks.length <= capacity ? capacity : Math.min(limit, Math.max(0, maxLines - 2));
  const ordered = orderedTasks(tasks, count, options.completedAt ?? new Map(), options.now ?? Date.now());
  for (const task of ordered.slice(0, count)) {
    const label = task.status === "in_progress" ? task.activeForm ?? task.subject : task.subject;
    const text = oneLine(label);
    const row = task.status === "in_progress" ? `  ${amber("\u25a0")} ${bold(black(text))}`
      : (task.status === "completed" ? green : dim)(`  ${task.status === "completed" ? "\u2612" : "\u2610"} ${text}`);
    lines.push(fit(row, width));
  }
  const hidden = ordered.slice(count);
  if (count > 0 && hidden.length) {
    const counts = ([["in_progress", "in progress"], ["pending", "pending"], ["completed", "completed"]] as const)
      .map(([status, label]) => [hidden.filter((task) => task.status === status).length, label] as const)
      .filter(([total]) => total > 0).map(([total, label]) => `${total} ${label}`);
    lines.push(fit(dim(`  \u2026 +${counts.join(", ")}`), width));
  }
  return lines;
}

/** Completion recency is presentation-only, scoped to each conversation and shared by session/peek views. */
export class TaskDisplay {
  private states = new Map<string, DisplayState>();
  private closed = false;

  constructor(private readonly changed: () => void, private readonly clock: TaskDisplayClock = displayClock) {}

  sync(sessions: readonly TaskSession[]): void {
    if (this.closed) return;
    const live = new Set(sessions.filter((session) => session.tasks?.length).map(scope));
    for (const key of this.states.keys()) if (!live.has(key)) this.forget(key);
    for (const session of sessions) this.observe(session);
  }

  render(session: TaskSession | undefined, width: number, maxLines: number, rows: number): string[] {
    if (this.closed || !session) return [];
    const state = this.observe(session);
    return taskChecklist(session.tasks, width, maxLines, {
      limit: taskVisibleLimit(rows), completedAt: state?.completedAt, now: this.clock.now(),
    });
  }

  private observe(session: TaskSession): DisplayState | undefined {
    const key = scope(session);
    if (!session.tasks?.length) { this.forget(key); return; }
    let state = this.states.get(key);
    if (!state) {
      // Already-completed tasks on initial load are not newly finished work.
      state = { completedAt: new Map(session.tasks.filter((task) => task.status === "completed").map((task) => [task.id, null])) };
      this.states.set(key, state);
    }
    const done = new Set(session.tasks.filter((task) => task.status === "completed").map((task) => task.id));
    for (const id of state.completedAt.keys()) if (!done.has(id)) state.completedAt.delete(id);
    for (const id of done) if (!state.completedAt.has(id)) state.completedAt.set(id, this.clock.now());
    this.arm(key, state);
    return state;
  }

  private arm(key: string, state: DisplayState): void {
    const now = this.clock.now();
    const deadlines = [...state.completedAt.values()].filter((at): at is number => typeof at === "number")
      .map((at) => at + TASK_RECENT_COMPLETION_MS).filter((deadline) => deadline > now);
    const deadline = deadlines.length ? Math.min(...deadlines) : undefined;
    if (state.timer?.deadline === deadline) return;
    state.timer?.cancel?.(); state.timer = undefined;
    if (deadline === undefined) return;
    const timer: NonNullable<DisplayState["timer"]> = { deadline };
    state.timer = timer;
    timer.cancel = this.clock.schedule(deadline - now, () => {
      if (this.closed || this.states.get(key) !== state || state.timer !== timer) return;
      state.timer = undefined;
      this.arm(key, state);
      this.changed();
    });
  }

  private forget(key: string): void {
    this.states.get(key)?.timer?.cancel?.(); this.states.delete(key);
  }

  close(): void {
    this.closed = true;
    for (const key of this.states.keys()) this.forget(key);
  }
}

export function taskDetails(tasks: readonly ChecklistTask[] | undefined, width: number): string[] {
  if (!tasks?.length) return ["No checklist tasks in this session."];
  return [...tasks].sort(byId).flatMap((task) => [
    ...wrapTextWithAnsi(bold(oneLine(task.subject)), Math.max(1, width)),
    ...wrapTextWithAnsi(dim(task.status === "in_progress" ? "In progress" : task.status === "completed" ? "Completed" : "Pending"), Math.max(1, width)),
    ...(task.description ? wrapTextWithAnsi(plain(task.description), Math.max(1, width)) : []),
    "",
  ]);
}
