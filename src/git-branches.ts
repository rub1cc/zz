import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function readGitBranch(path: string, signal?: AbortSignal): Promise<string | undefined> {
  const options = { timeout: 1500, maxBuffer: 4096, signal };
  try {
    const { stdout } = await exec("git", ["-C", path, "symbolic-ref", "--quiet", "--short", "HEAD"], options);
    return stdout.trim() || undefined;
  } catch {
    if (signal?.aborted) return;
    try {
      const { stdout } = await exec("git", ["-C", path, "rev-parse", "--short", "HEAD"], options);
      return stdout.trim() ? `detached ${stdout.trim()}` : undefined;
    } catch { return; }
  }
}

interface BranchState {
  branch?: string;
  request?: Promise<void>;
}

/** Keep Git subprocesses out of rendering, including during rapid agent updates. */
export class GitBranches {
  private readonly projects = new Map<string, BranchState>();
  private readonly abort = new AbortController();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly changed: () => void, private readonly read = readGitBranch) {
    this.timer = setInterval(() => { void this.refresh(); }, 5000);
    this.timer.unref();
  }

  value(path: string): string | undefined { return this.projects.get(path)?.branch; }

  sync(paths: string[]): void {
    if (this.abort.signal.aborted) return;
    const active = new Set(paths);
    for (const path of this.projects.keys()) if (!active.has(path)) this.projects.delete(path);
    for (const path of active) {
      if (this.projects.has(path)) continue;
      const state: BranchState = {};
      this.projects.set(path, state);
      void this.refreshProject(path, state);
    }
  }

  async refresh(): Promise<void> {
    await Promise.all([...this.projects].map(([path, state]) => this.refreshProject(path, state)));
  }

  private refreshProject(path: string, state: BranchState): Promise<void> {
    return state.request ??= this.read(path, this.abort.signal).catch(() => undefined).then((branch) => {
      if (this.abort.signal.aborted || this.projects.get(path) !== state) return;
      if (state.branch !== branch) {
        state.branch = branch;
        this.changed();
      }
    }).finally(() => { state.request = undefined; });
  }

  close(): void {
    clearInterval(this.timer);
    this.abort.abort();
    this.projects.clear();
  }
}
