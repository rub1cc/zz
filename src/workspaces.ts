import { execFile } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
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

  ensure(session: Session, project: Project, changed: () => void, signal?: AbortSignal): Promise<Workspace> {
    const workspace = this.store.workspace(session) ?? this.store.assignWorkspace(session, project, { kind: "main" });
    const running = this.pending.get(workspace.id);
    if (running) return running;
    const promise = this.prepare(session, project, workspace, changed, signal).finally(() => this.pending.delete(workspace.id));
    this.pending.set(workspace.id, promise);
    return promise;
  }

  private async prepare(session: Session, project: Project, workspace: Workspace, changed: () => void, signal?: AbortSignal): Promise<Workspace> {
    if (workspace.status === "ready") {
      directory(workspace.path);
      return workspace;
    }
    if (!workspace.managed || !workspace.checkoutPath || !workspace.branch || !workspace.baseRef) {
      throw new Error("Workspace preparation metadata is incomplete. Choose another workspace for a new session.");
    }
    workspace.status = "pending";
    delete workspace.error;
    session.preview = "Preparing workspace...";
    this.store.save(); changed();
    try {
      const root = await repositoryRoot(project.path, signal);
      if (!root) {
        if (workspace.repositoryRoot) throw new Error("The Git repository used for this launch is unavailable; refusing to switch to the main directory.");
        const main = this.store.mainWorkspace(project);
        session.workspaceId = main.id;
        this.store.state.workspaces = this.store.workspaces.filter((w) => w.id !== workspace.id);
        this.store.save(); changed();
        return main;
      }
      if (workspace.repositoryRoot && workspace.repositoryRoot !== root) throw new Error("The project now resolves to a different repository root; inspect it before retrying.");
      workspace.repositoryRoot = root;
      this.store.save();
      const base = workspace.baseRef;
      if (base.startsWith("-") || !base.trim() || /[\r\n\0]/.test(base)) throw new Error("Choose a valid Git base ref (for example HEAD or main).");
      // Pin the base before creating anything so a retried launch cannot move with HEAD.
      workspace.baseCommit ??= await git(root, ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`], signal);
      workspace.path = join(workspace.checkoutPath, relative(root, directory(project.path)));
      this.store.save();
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
      this.store.save(); changed();
      return workspace;
    } catch (error) {
      workspace.status = "failed";
      workspace.error = error instanceof Error ? error.message : String(error);
      this.store.save(); changed();
      throw new Error(`Workspace preparation failed: ${workspace.error}`, { cause: error });
    }
  }

  async import(project: Project, value: string): Promise<Workspace> {
    const path = directory(value);
    const root = await repositoryRoot(project.path);
    if (!root) throw new Error("Existing worktrees require a Git project.");
    const listed = await listedWorktrees(root);
    const candidateRoot = await repositoryRoot(path);
    if (!candidateRoot || !listed.has(candidateRoot)) throw new Error("Choose a Git worktree belonging to this project.");
    const expected = directory(join(candidateRoot, relative(root, directory(project.path))));
    if (path !== candidateRoot && path !== expected) throw new Error("Choose the worktree root or this project's directory within it.");
    const existing = this.store.workspaces.find((w) => w.projectId === project.id && w.path === expected);
    if (existing) return existing;
    const workspace: Workspace = { id: randomUUID(), projectId: project.id, projectPath: project.path, path: expected,
      checkoutPath: candidateRoot, branch: listed.get(candidateRoot)?.branch, kind: "worktree", managed: false, status: "ready" };
    this.store.workspaces.push(workspace);
    try { this.store.save(); }
    catch (error) { this.store.state.workspaces = this.store.workspaces.filter((w) => w !== workspace); throw error; }
    return workspace;
  }
}
