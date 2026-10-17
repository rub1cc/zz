import type { ConversationId, Harness } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { TASK_COMPLETION_GRACE_MS, TasksDoc, type TaskState } from "./tasks.js";
import { UndoDoc } from "./undo.js";

export interface TaskCleanupClock {
  now(): number;
  /** Schedule asynchronously; return a cancellation function. */
  schedule(delay: number, callback: () => void | Promise<void>): () => void;
}

export const taskCleanupClock: TaskCleanupClock = {
  now: () => Date.now(),
  schedule: (delay, callback) => {
    const timer = setTimeout(callback, Math.min(2_147_483_647, Math.max(0, delay)));
    timer.unref();
    return () => clearTimeout(timer);
  },
};

type Registration = { id: ConversationId; deadline: number; blocked: () => boolean; cancel?: () => void };

/** Timers are disposable; the deadline and the atomic reset live in durable conversation state. */
export class TaskCleanup {
  private registrations = new Map<ConversationId, Registration>();
  private pending = new Set<Promise<void>>();
  private closed = false;

  constructor(private readonly harness: Harness, private readonly report: (error: unknown) => void,
    readonly clock: TaskCleanupClock = taskCleanupClock) {}

  watch(id: ConversationId, state: Readonly<TaskState> | null, blocked: () => boolean): void {
    if (this.closed) return;
    if (!state?.items.length || state.completedAt === undefined || state.items.some((task) => task.status !== "completed")) {
      this.forget(id);
      return;
    }
    const deadline = state.completedAt + TASK_COMPLETION_GRACE_MS;
    if (this.registrations.get(id)?.deadline === deadline) return;
    this.forget(id);
    const registration = { id, deadline, blocked };
    this.registrations.set(id, registration);
    this.arm(registration, deadline - this.clock.now());
  }

  forget(id: ConversationId): void {
    this.registrations.get(id)?.cancel?.();
    this.registrations.delete(id);
  }

  private current(registration: Registration): boolean {
    return !this.closed && this.registrations.get(registration.id) === registration;
  }

  private arm(registration: Registration, delay: number): void {
    registration.cancel = this.clock.schedule(Math.max(0, delay), () => {
      registration.cancel = undefined;
      const work = this.clear(registration).catch((error: unknown) => {
        if (this.current(registration)) this.forget(registration.id);
        if (!this.closed) this.report(error);
      }).finally(() => { this.pending.delete(work); });
      this.pending.add(work);
      return work;
    });
  }

  private async clear(registration: Registration): Promise<void> {
    if (!this.current(registration)) return;
    let retry = false;
    await this.harness.commit(async (tx) => {
      if (!this.current(registration)) return;
      const state = await tx.doc(TasksDoc, registration.id);
      const undo = await tx.doc(UndoDoc, registration.id);
      if (!this.current(registration)) return;
      if (registration.blocked() || undo.restoring) { retry = true; return; }
      if (!state.items.length || state.completedAt === undefined
        || state.completedAt + TASK_COMPLETION_GRACE_MS !== registration.deadline
        || state.items.some((task) => task.status !== "completed")) return;
      const now = this.clock.now();
      if (now < registration.deadline) { retry = true; return; }
      const count = state.items.length;
      const completedAt = state.completedAt;
      state.items = [];
      delete state.completedAt;
      // An entry in the same commit anchors this background change for the next /undo checkpoint.
      await tx.appendEntry(registration.id, { kind: "zz.tasks_cleared", data: { count, completedAt, timestamp: now } });
    }, BACKGROUND_CONTEXT);
    if (!this.current(registration)) return;
    if (retry) this.arm(registration, Math.max(1000, registration.deadline - this.clock.now()));
    else this.forget(registration.id);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const id of this.registrations.keys()) this.forget(id);
    await Promise.allSettled([...this.pending]);
  }
}
