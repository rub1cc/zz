import type { TaskCleanupClock } from "../src/task-cleanup.js";

export class ManualTaskClock implements TaskCleanupClock {
  time = 0;
  private nextId = 1;
  private jobs = new Map<number, { at: number; callback: () => void | Promise<void> }>();
  now(): number { return this.time; }
  get scheduled(): number { return this.jobs.size; }
  schedule(delay: number, callback: () => void | Promise<void>): () => void {
    const id = this.nextId++;
    this.jobs.set(id, { at: this.time + Math.max(0, delay), callback });
    return () => { this.jobs.delete(id); };
  }
  async advance(milliseconds: number): Promise<void> { await this.advanceTo(this.time + milliseconds); }
  async advanceTo(time: number): Promise<void> {
    let count = 0;
    while (true) {
      const next = [...this.jobs].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > time) break;
      if (++count > 10000) throw new Error("Timer did not settle");
      this.time = Math.max(this.time, next[1].at);
      this.jobs.delete(next[0]);
      await next[1].callback();
    }
    this.time = time;
  }
}
