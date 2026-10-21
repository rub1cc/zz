import { execFile } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import type { Project, Session, Workspace } from "./model.js";
import { directory, Store } from "./store.js";

const exec = promisify(execFile);

async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  try {
    const { stdout } = await exec("git", ["-C", cwd, ...args], { signal, timeout: 120_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } });
    return stdout.replace(/\r?\n$/, "");
  } catch (error) {
    const cause = error as Error & { stderr?: string; code?: string | number };
    if (cause.name === "AbortError") throw error;
    throw new Error(cause.stderr?.trim() || cause.message, { cause });
  }
}

async function repositoryRoot(path: string, signal?: AbortSignal): Promise<string | undefined> {
  try { return await realpath(await git(path, ["rev-parse", "--show-toplevel"], signal)); }
  catch (error) {
    const cause = error as Error & { cause?: { code?: string } };
    if (cause.cause?.code === "ENOENT") {
      let ancestor = path;
      while (true) {
        if (existsSync(join(ancestor, ".git"))) throw new Error("Git is unavailable; this Git project cannot prepare a worktree.", { cause: error });
        const parent = dirname(ancestor);
        if (parent === ancestor) return;
        ancestor = parent;
      }
    }
    if (/not a git repository/i.test(cause.message)) return;
    throw error;
  }
}

async function listedWorktrees(path: string, signal?: AbortSignal): Promise<Map<string, { branch?: string; locked?: boolean }>> {
  const output = await git(path, ["worktree", "list", "--porcelain", "-z"], signal);
  const result = new Map<string, { branch?: string; locked?: boolean }>();
  let current: string | undefined;
  for (const field of output.split("\0")) {
    if (field.startsWith("worktree ")) { current = field.slice(9); result.set(current, {}); }
    else if (current && field.startsWith("branch refs/heads/")) result.get(current)!.branch = field.slice(18);
    else if (current && (field === "locked" || field.startsWith("locked "))) result.get(current)!.locked = true;
  }
  return result;
}

/** Checkout creation is replayable; session deletion never owns filesystem deletion. */
export class Workspaces {
  private readonly pending = new Map<string, Promise<Workspace>>();
  constructor(private readonly store: Store) {}

  ensure(session: Session, project: Project, changed: () => void, signal?: AbortSignal, allowMainFallback = true, checkpoint?: (workspace: Workspace) => Promise<void>): Promise<Workspace> {
    const workspace = this.store.workspace(session) ?? this.store.assignWorkspace(session, project, { kind: "main" });
    const key = JSON.stringify([workspace.projectId, workspace.id]);
    const running = this.pending.get(key);
    if (running) return running;
    const promise = this.prepare(session, project, workspace, changed, signal, allowMainFallback, checkpoint).finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }

  private async prepare(session: Session, project: Project, workspace: Workspace, changed: () => void, signal: AbortSignal | undefined, allowMainFallback: boolean, checkpoint?: (workspace: Workspace) => Promise<void>): Promise<Workspace> {
    if (workspace.status === "ready") {
      await this.validateExisting(project, workspace, signal);
      await this.store.saveAsync();
      return workspace;
    }
    if (!workspace.managed || !workspace.checkoutPath || !workspace.branch || !workspace.baseRef) {
      throw new Error("Workspace preparation metadata is incomplete. Choose another workspace for a new session.");
    }
    const save = async () => { await this.store.saveAsync(); await checkpoint?.(workspace); changed(); };
    workspace.status = "pending";
    delete workspace.error;
    session.preview = "Preparing workspace...";
    await save();
    try {
      const root = await repositoryRoot(project.path, signal);
      if (!root) {
        if (workspace.repositoryRoot || !allowMainFallback) throw new Error("The Git repository used for this launch is unavailable; refusing to switch to the main directory.");
        const main = this.store.mainWorkspace(project);
        session.workspace = main;
        await this.store.saveAsync(); changed();
        return main;
      }
      if (workspace.repositoryRoot && workspace.repositoryRoot !== root) throw new Error("The project now resolves to a different repository root; inspect it before retrying.");
      workspace.repositoryRoot = root;
      await save();
      const base = workspace.baseRef;
      if (base.startsWith("-") || !base.trim() || /[\r\n\0]/.test(base)) throw new Error("Choose a valid Git base ref (for example HEAD or main).");
      // Pin the base before creating anything so a retried launch cannot move with HEAD.
      workspace.baseCommit ??= await git(root, ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`], signal);
      workspace.path = join(workspace.checkoutPath, relative(root, directory(project.path)));
      await save();
      await mkdir(dirname(workspace.checkoutPath), { recursive: true });
      const listed = await listedWorktrees(root, signal);
      const registered = listed.has(workspace.checkoutPath);
      if (registered) {
        if (listed.get(workspace.checkoutPath)?.branch !== workspace.branch) throw new Error("Prepared checkout has a different branch; refusing to reuse it.");
        if (listed.get(workspace.checkoutPath)?.locked) throw new Error("Prepared checkout is locked, possibly by an interrupted checkout. Inspect and unlock it before retrying.");
        directory(workspace.checkoutPath);
      } else {
        if (existsSync(workspace.checkoutPath)) throw new Error("Workspace directory already exists but Git does not register it. Inspect it before retrying.");
        const branchRef = `refs/heads/${workspace.branch}`;
        const refs = (await git(root, ["for-each-ref", "--format=%(refname)", branchRef], signal)).split("\n");
        if (refs.includes(branchRef)) {
          const commit = await git(root, ["rev-parse", "--verify", branchRef], signal);
          if (commit !== workspace.baseCommit) throw new Error("Prepared branch has changed; refusing to recreate its checkout automatically.");
          await git(root, ["worktree", "add", "--", workspace.checkoutPath, workspace.branch], signal);
        } else {
          await git(root, ["worktree", "add", "-b", workspace.branch, "--", workspace.checkoutPath, workspace.baseCommit], signal);
        }
      }
      workspace.path = directory(workspace.path);
      workspace.status = "ready";
      await save();
      return workspace;
    } catch (error) {
      workspace.status = "failed";
      workspace.error = error instanceof Error ? error.message : String(error);
      await save();
      throw new Error(`Workspace preparation failed: ${workspace.error}`, { cause: error });
    }
  }

  async committedHead(session: Session, signal?: AbortSignal): Promise<string> {
    const path = this.store.sessionPath(session);
    if (!await repositoryRoot(path, signal)) throw new Error("Worktree isolation requires a Git project; use shared explicitly for non-Git projects.");
    return git(path, ["rev-parse", "--verify", "HEAD^{commit}"], signal);
  }

  async validateNew(project: Project, baseRef: string, branch?: string, signal?: AbortSignal): Promise<void> {
    const root = await repositoryRoot(project.path, signal);
    if (!root) throw new Error("Creating a worktree requires a Git project.");
    if (!baseRef.trim() || baseRef.startsWith("-") || /[\r\n\0]/.test(baseRef)) throw new Error("Choose a valid Git base ref.");
    await git(root, ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`], signal);
    if (branch !== undefined) {
      if (branch.startsWith("-") || /[\r\n\0]/.test(branch)) throw new Error("Choose a valid new branch name.");
      await git(root, ["check-ref-format", "--branch", branch], signal);
      const ref = `refs/heads/${branch}`;
      if ((await git(root, ["for-each-ref", "--format=%(refname)", ref], signal)).split("\n").includes(ref)) throw new Error("The requested branch already exists. Choose another name or enter its existing worktree.");
    }
  }

  async validateExisting(project: Project, workspace: Workspace, signal?: AbortSignal): Promise<void> {
    if (directory(workspace.path) !== workspace.path) throw new Error("Workspace path now resolves elsewhere; inspect it before entering.");
    if (workspace.kind === "main") {
      if (workspace.path !== project.path) throw new Error("Main workspace no longer matches the project's directory.");
      return;
    }
    const root = await repositoryRoot(project.path, signal);
    const target = await repositoryRoot(workspace.path, signal);
    const listed = root ? await listedWorktrees(root, signal) : undefined;
    if (!root || !target || !listed?.has(target)) throw new Error("The destination is no longer a worktree of this project.");
    const expected = directory(join(target, relative(root, directory(project.path))));
    if (workspace.path !== expected) throw new Error("Destination no longer matches this project's relative directory.");
    workspace.checkoutPath = target;
    workspace.branch = listed.get(target)?.branch;
  }

  async describe(workspace: Workspace, signal?: AbortSignal): Promise<{ available: boolean; isGit?: boolean; branch?: string; hasLocalChanges?: boolean; error?: string }> {
    try {
      directory(workspace.path);
      const root = await repositoryRoot(workspace.path, signal);
      if (!root) return { available: true, isGit: false };
      let branch: string;
      try { branch = await git(workspace.path, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal); }
      catch { branch = `detached ${await git(workspace.path, ["rev-parse", "--short", "HEAD"], signal)}`; }
      return { available: true, isGit: true, branch, hasLocalChanges: !!(await git(workspace.path, ["status", "--porcelain", "-z", "--untracked-files=normal"], signal)) };
    } catch (error) {
      signal?.throwIfAborted();
      return { available: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Git owns the checkout inventory; listing never registers or persists anything. */
  async discover(project: Project, signal?: AbortSignal): Promise<Workspace[]> {
    const main = this.store.mainWorkspace(project);
    const root = await repositoryRoot(project.path, signal);
    if (!root) return [main];
    const listed = await listedWorktrees(root, signal);
    const result: Workspace[] = [main];
    const bindings = this.store.boundWorkspaces;
    const subdir = relative(root, directory(project.path));
    for (const [checkoutPath, details] of listed) {
      if (checkoutPath === root) continue;
      const path = join(checkoutPath, subdir);
      try {
        // Prunable Git entries and checkouts without this project's subdirectory are not destinations.
        if (directory(path) !== path) continue;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") continue;
        throw error;
      }
      const binding = bindings.find((w) => w.projectId === project.id && w.path === path);
      result.push({ ...binding, id: binding?.id ?? path, projectId: project.id, projectPath: project.path,
        path, checkoutPath, kind: "worktree", managed: binding?.managed ?? false, status: binding?.status ?? "ready", branch: details.branch });
    }
    return result;
  }

  async resolve(project: Project, value: string, signal?: AbortSignal): Promise<Workspace> {
    const discovered = await this.discover(project, signal);
    const byId = discovered.find((w) => w.id === value);
    if (byId) return byId;
    let path: string;
    try { path = directory(value); }
    catch { throw new Error("Choose a Git worktree belonging to this project from workspace_list."); }
    const workspace = discovered.find((w) => w.path === path || w.checkoutPath === path);
    if (!workspace) throw new Error("Choose a Git worktree belonging to this project from workspace_list.");
    return workspace;
  }
}
