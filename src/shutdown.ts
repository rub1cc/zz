export interface ShutdownOptions {
  prepare(): void;
  close(): Promise<void>;
  restoreTerminal(): void;
  release(): Promise<void>;
  report(error: unknown): void;
  exit(code: number): void;
  timeoutMs?: number;
}

/** A CLI must exit even when an SDK transport retains handles after clean shutdown. */
export function createShutdown(options: ShutdownOptions) {
  let closing: Promise<void> | undefined;
  let finished = false;
  let restored = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;

  const restore = () => {
    if (restored) return;
    options.restoreTerminal();
    restored = true;
  };
  const finish = (code: number, error?: unknown) => {
    if (finished) return;
    finished = true;
    if (deadline) clearTimeout(deadline);
    try { restore(); } catch (failure) { options.report(failure); code = 1; }
    if (error !== undefined) options.report(error);
    options.exit(code);
  };

  return {
    get isClosing() { return closing !== undefined; },
    get done() { return closing; },
    request(code = 0, error?: unknown): void {
      if (finished) return;
      if (closing) {
        // Do not release a live database's lock; process exit owns forced cleanup.
        finish(130, new Error("Forced exit. Unfinished durable work will recover next time."));
        return;
      }
      deadline = setTimeout(() => finish(130, new Error("Shutdown timed out. Unfinished durable work will recover next time.")), options.timeoutMs ?? 5000);
      closing = Promise.resolve().then(async () => {
        let exitCode = code;
        let failure = error;
        try { options.prepare(); } catch (cause) { exitCode = 1; failure = cause; }
        try { restore(); } catch (cause) { exitCode = 1; failure = cause; }
        try {
          await options.close();
          if (!finished) await options.release();
        } catch (cause) { exitCode = 1; failure = cause; }
        finally { finish(exitCode, failure); }
      });
    },
  };
}

/** Best-effort non-durable work must not hold durable checkpoint shutdown hostage. */
export async function settleWithin(work: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([work, new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); })]);
  } finally { if (timer) clearTimeout(timer); }
}
