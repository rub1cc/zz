import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { OutputBuffer } from "@earendil-works/chord/output";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { plain } from "./format.js";

export const SHELL_OUTPUT_BYTES = 256 * 1024;
export const SHELL_OUTPUT_LINES = 2000;

/** One shell execution; callers publish its bounded output into local response history, not model context. */
export class ShellRun {
  phase: "running" | "stopping" | "done" | "failed" | "cancelled" = "running";
  exitCode?: number;
  error?: string;
  done: Promise<void> = Promise.resolve();
  private started = false;
  private readonly abort = new AbortController();
  private readonly env: NodeExecutionEnv;
  private readonly buffer = new OutputBuffer({ maxBytes: SHELL_OUTPUT_BYTES, maxLines: SHELL_OUTPUT_LINES, retain: "tail" });
  private renderTimer?: ReturnType<typeof setTimeout>;
  get running(): boolean { return this.phase === "running" || this.phase === "stopping"; }
  get output() { return this.buffer.snapshot(); }

  constructor(readonly cwd: string, readonly command: string, readonly changed: () => void) {
    this.env = new NodeExecutionEnv({ cwd });
  }

  start(): Promise<void> {
    if (this.started) return this.done;
    this.started = true;
    this.done = this.execute();
    return this.done;
  }

  cancel(): void {
    if (!this.running || this.abort.signal.aborted) return;
    this.phase = "stopping";
    this.abort.abort();
    this.changed();
  }

  private async execute(): Promise<void> {
    try {
      const result = await this.env.exec(this.command, { onOutput: (text) => {
        // Never pass process output through as terminal commands (OSC 52, cursor controls, images, etc.).
        this.buffer.push(plain(text).replace(/[\x80-\x9f\ufff9-\ufffb]/g, "").replace(/\r\n?/g, "\n"));
        if (!this.renderTimer) this.renderTimer = setTimeout(() => { this.renderTimer = undefined; this.changed(); }, 50);
      } }, withAbortSignal(this.abort.signal, BACKGROUND_CONTEXT));
      if (result.ok) {
        this.exitCode = result.value.exitCode;
        this.phase = this.abort.signal.aborted ? "cancelled" : this.exitCode === 0 ? "done" : "failed";
      } else {
        this.phase = this.abort.signal.aborted || result.error.code === "aborted" ? "cancelled" : "failed";
        if (this.phase === "failed") this.error = result.error.message;
      }
    } catch (error) {
      this.phase = this.abort.signal.aborted ? "cancelled" : "failed";
      if (this.phase === "failed") this.error = error instanceof Error ? error.message : String(error);
    } finally {
      try { await this.env.cleanup(BACKGROUND_CONTEXT); }
      catch (error) {
        this.phase = "failed";
        this.error = `Shell cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        this.buffer.end();
        if (this.renderTimer) clearTimeout(this.renderTimer);
        this.renderTimer = undefined;
        this.changed();
      }
    }
  }
}
