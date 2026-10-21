import { randomUUID } from "node:crypto";
import { renameSync } from "node:fs";
import { rm } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import type { State } from "./model.js";

export type PrepareSnapshot = (state: State, temporary: string) => Promise<void>;

// Keep the worker self-contained so source checkouts and compiled installs use the same code.
const workerSource = `
  const { parentPort } = require("node:worker_threads");
  const { writeFile } = require("node:fs/promises");
  parentPort.on("message", async ({ state, temporary }) => {
    try {
      await writeFile(temporary, JSON.stringify(state, null, 2) + "\\n", { mode: 0o600, flag: "wx" });
      parentPort.postMessage({});
    } catch (error) {
      parentPort.postMessage({ error: { message: error.message, code: error.code } });
    }
  });
`;

/** One writer, one in-flight snapshot, and at most one coalesced successor. */
export class StateWriter {
  private revision = 0;
  private dirty = false;
  private active?: Promise<void>;
  private worker?: Worker;

  constructor(private readonly file: string, private readonly snapshot: () => State,
    private readonly prepare: PrepareSnapshot = (state, temporary) => this.prepareInWorker(state, temporary)) {}

  save(): Promise<void> {
    this.revision++;
    this.dirty = true;
    if (!this.active) this.start();
    return this.flush();
  }

  /** A synchronous recovery checkpoint supersedes all older background snapshots. */
  invalidate(): void {
    this.revision++;
    this.dirty = false;
  }

  async flush(): Promise<void> {
    while (this.active) await this.active;
  }

  async close(): Promise<void> {
    try { await this.flush(); }
    finally {
      const worker = this.worker;
      this.worker = undefined;
      await worker?.terminate();
    }
  }

  private start(): void {
    this.active = Promise.resolve().then(async () => {
      while (this.dirty) {
        this.dirty = false;
        const revision = this.revision;
        const temporary = `${this.file}.${randomUUID()}.tmp`;
        try {
          await this.prepare(this.snapshot(), temporary);
          // No await between the version check and publication: a synchronous checkpoint
          // cannot be overtaken by an older worker result. Only this tiny rename stays on-thread.
          if (revision === this.revision) renameSync(temporary, this.file);
        } finally { await rm(temporary, { force: true }); }
      }
    }).catch((error: unknown) => { this.dirty = false; throw error; }).finally(() => {
      this.active = undefined;
      if (this.dirty) this.start();
    });
  }

  private prepareInWorker(state: State, temporary: string): Promise<void> {
    if (!this.worker) {
      const worker = new Worker(workerSource, { eval: true, execArgv: [] });
      // Retire a failed idle worker as well as one serving a request.
      const retire = () => { if (this.worker === worker) this.worker = undefined; };
      worker.on("error", retire); worker.on("exit", retire);
      this.worker = worker;
    }
    const worker = this.worker;
    worker.ref();
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        worker.off("message", message); worker.off("error", failure); worker.off("exit", exit);
        worker.unref();
      };
      const message = (result: { error?: { message: string; code?: string } }) => {
        cleanup();
        if (result.error) reject(Object.assign(new Error(result.error.message), { code: result.error.code }));
        else resolve();
      };
      const failure = (error: Error) => { cleanup(); this.worker = undefined; reject(error); };
      const exit = (code: number) => failure(new Error(`State writer exited before saving (code ${code}).`));
      worker.once("message", message); worker.once("error", failure); worker.once("exit", exit);
      try { worker.postMessage({ state, temporary }); }
      catch (error) { cleanup(); reject(error); }
    });
  }
}
