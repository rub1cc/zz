import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Store } from "../src/store.js";
import { Workspaces } from "../src/workspaces.js";
import type { Project, Session } from "../src/model.js";
import { temporary } from "./helpers.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();
}
function repository(root: string): string {
  const path = join(root, "repo"); mkdirSync(path);
  git(path, "init", "-b", "main");
  git(path, "config", "user.name", "Test"); git(path, "config", "user.email", "test@example.test");
  writeFileSync(join(path, "file.txt"), "base\n");
  mkdirSync(join(path, "pkg")); writeFileSync(join(path, "pkg", "source.txt"), "source\n");
  git(path, "add", "."); git(path, "commit", "-qm", "Initial"); return path;
}
function session(project: Project, id: string): Session {
  return { id, projectId: project.id, title: id, status: "working", preview: "", createdAt: 1, updatedAt: 1, messages: [] };
}

test("legacy projects migrate to stable identities and main workspaces, including removed projects", () => {
  const f = temporary();
  try {
    const data = join(f.root, "data"); mkdirSync(data);
    const removed = join(f.root, "removed"); mkdirSync(removed);
    const legacy = { id: f.root, path: f.root };
    writeFileSync(join(data, "state.json"), JSON.stringify({ version: 1, projects: [legacy],
      selectedProjectId: legacy.id, sessions: [session(legacy, "a"), session({ id: removed, path: removed }, "b")] }));
    const store = new Store(data);
    const project = store.state.projects[0]!;
    assert.notEqual(project.id, project.path);
    assert.equal(store.state.version, 2);
    assert.equal(JSON.parse(readFileSync(join(data, "state.v1.backup.json"), "utf8")).projects[0].id, legacy.id);
    assert.equal(store.state.selectedProjectId, project.id);
    assert.equal(store.sessionPath(store.state.sessions[0]!), f.root);
    const restored = store.addProject(removed);
    assert.equal(store.state.sessions[1]!.projectId, restored.id);
    const reopened = new Store(data);
    assert.equal(reopened.state.projects[0]!.id, project.id);
    assert.equal(reopened.sessionPath(reopened.state.sessions[1]!), removed);
  } finally { f.cleanup(); }
});

test("new workspaces isolate tracked files, preserve dirty main files, and replay creation", async () => {
  const f = temporary();
  try {
    const path = repository(f.root); const store = new Store(join(f.root, "data"));
    const project = store.addProject(path); const task = session(project, "Fix auth"); store.state.sessions.push(task);
    const workspace = store.assignWorkspace(task, project); store.save();
    writeFileSync(join(path, "file.txt"), "dirty main\n");
    const manager = new Workspaces(store);
    await manager.ensure(task, project, () => {});
    assert.equal(readFileSync(join(workspace.path, "file.txt"), "utf8"), "base\n");
    writeFileSync(join(workspace.path, "file.txt"), "isolated\n");
    assert.equal(readFileSync(join(path, "file.txt"), "utf8"), "dirty main\n");
    workspace.status = "pending"; store.save();
    const restored = new Store(store.root);
    await new Workspaces(restored).ensure(restored.state.sessions[0]!, restored.state.projects[0]!, () => {});
    assert.equal(readFileSync(join(workspace.path, "file.txt"), "utf8"), "isolated\n");
    assert.equal(git(path, "branch", "--show-current"), "main");
  } finally { f.cleanup(); }
});

test("subdirectory projects retain their relative cwd and can import a shared worktree", async () => {
  const f = temporary();
  try {
    const root = repository(f.root); const store = new Store(join(f.root, "data"));
    const project = store.addProject(join(root, "pkg")); const task = session(project, "subdir");
    const workspace = store.assignWorkspace(task, project);
    const manager = new Workspaces(store); await manager.ensure(task, project, () => {});
    assert.equal(readFileSync(join(workspace.path, "source.txt"), "utf8"), "source\n");
    assert.equal(workspace.path, join(workspace.checkoutPath!, "pkg"));
    assert.equal((await manager.import(project, workspace.checkoutPath!)).id, workspace.id);
    const external = join(f.root, "external"); git(root, "worktree", "add", "-b", "external", external);
    const imported = await manager.import(project, external);
    assert.equal(imported.path, join(external, "pkg")); assert.equal(imported.managed, false);
    const other = session(project, "review"); store.assignWorkspace(other, project, { kind: "existing", workspaceId: imported.id });
    assert.equal(store.workspaceKey(other), imported.path);
    await assert.rejects(manager.import(project, f.root), /belonging/);
  } finally { f.cleanup(); }
});

test("failed worktree preparation is retained, retryable, and never falls back to the main checkout", async () => {
  const f = temporary();
  try {
    const path = repository(f.root); const store = new Store(join(f.root, "data")); const project = store.addProject(path);
    const task = session(project, "bad base"); const workspace = store.assignWorkspace(task, project, { kind: "new", baseRef: "missing" });
    const manager = new Workspaces(store);
    await assert.rejects(manager.ensure(task, project, () => {}), /Workspace preparation failed/);
    assert.equal(workspace.status, "failed"); assert.equal(store.workspace(task), workspace);
    assert.notEqual(workspace.path, path); assert.equal(existsSync(workspace.path), false);
    workspace.baseRef = "main";
    await manager.ensure(task, project, () => {}); assert.equal(workspace.status, "ready");
    store.state.projects = []; store.save(); assert.equal(store.addProject(path).id, project.id);
  } finally { f.cleanup(); }
});


test("non-Git tasks use the main directory and explicit main selection creates no checkout", async () => {
  const f = temporary();
  try {
    const store = new Store(join(f.root, "data")); const project = store.addProject(f.root);
    const task = session(project, "ordinary directory"); store.state.sessions.push(task);
    store.assignWorkspace(task, project);
    const workspace = await new Workspaces(store).ensure(task, project, () => {});
    assert.equal(workspace.kind, "main"); assert.equal(store.sessionPath(task), f.root);
    assert.equal(store.workspaces.length, 1); assert.equal(existsSync(join(store.root, "worktrees")), false);
    const path = repository(f.root); const gitProject = store.addProject(path);
    const direct = session(gitProject, "main task"); store.assignWorkspace(direct, gitProject, { kind: "main" });
    assert.equal((await new Workspaces(store).ensure(direct, gitProject, () => {})).path, path);
    assert.equal(existsSync(join(store.root, "worktrees")), false);
  } finally { f.cleanup(); }
});

test("workspace bases are pinned before checkout creation and concurrent retries share one preparation", async () => {
  const f = temporary();
  try {
    const path = repository(f.root); const store = new Store(join(f.root, "data")); const project = store.addProject(path);
    const task = session(project, "pinned"); const workspace = store.assignWorkspace(task, project);
    workspace.baseCommit = git(path, "rev-parse", "HEAD");
    writeFileSync(join(path, "file.txt"), "new main commit"); git(path, "add", "."); git(path, "commit", "-qm", "Advance main");
    const manager = new Workspaces(store);
    const a = manager.ensure(task, project, () => {}); const b = manager.ensure(task, project, () => {});
    assert.equal(a, b); await Promise.all([a, b]);
    assert.equal(readFileSync(join(workspace.path, "file.txt"), "utf8"), "base\n");
    assert.equal(git(workspace.path, "rev-parse", "HEAD"), workspace.baseCommit);
  } finally { f.cleanup(); }
});

test("missing established checkouts and conflicting interrupted checkouts never silently fall back", async () => {
  const f = temporary();
  try {
    const path = repository(f.root); const store = new Store(join(f.root, "data")); const project = store.addProject(path);
    const task = session(project, "missing"); const workspace = store.assignWorkspace(task, project);
    const manager = new Workspaces(store); await manager.ensure(task, project, () => {});
    git(workspace.path, "branch", "-m", "manually-renamed"); workspace.status = "pending";
    await assert.rejects(manager.ensure(task, project, () => {}), /different branch/);
    assert.equal(git(path, "branch", "--show-current"), "main");
    workspace.status = "ready"; rmSync(workspace.path, { recursive: true, force: true });
    await assert.rejects(manager.ensure(task, project, () => {}), /ENOENT/);
    assert.equal(store.workspace(task), workspace);
  } finally { f.cleanup(); }
});

test("aborted provisioning records its state without creating a checkout", async () => {
  const f = temporary();
  try {
    const path = repository(f.root); const store = new Store(join(f.root, "data")); const project = store.addProject(path);
    const task = session(project, "cancelled"); const workspace = store.assignWorkspace(task, project);
    const abort = new AbortController(); abort.abort();
    await assert.rejects(new Workspaces(store).ensure(task, project, () => {}, abort.signal), /Workspace preparation failed/);
    assert.equal(workspace.status, "failed"); assert.equal(existsSync(workspace.path), false);
  } finally { f.cleanup(); }
});


test("a failed Git launch cannot turn into a main-directory launch if its repository disappears", async () => {
  const f = temporary();
  try {
    const path = repository(f.root); const store = new Store(join(f.root, "data")); const project = store.addProject(path);
    const task = session(project, "known Git"); const workspace = store.assignWorkspace(task, project, { kind: "new", baseRef: "missing" });
    const manager = new Workspaces(store); await assert.rejects(manager.ensure(task, project, () => {}));
    assert.equal(workspace.repositoryRoot, path);
    renameSync(join(path, ".git"), join(path, "saved-git"));
    await assert.rejects(manager.ensure(task, project, () => {}), /refusing to switch/);
    assert.equal(task.workspaceId, workspace.id); assert.notEqual(store.sessionPath(task), path);
  } finally { f.cleanup(); }
});

test("interrupted initialization locks are not mistaken for completed worktrees", async () => {
  const f = temporary();
  try {
    const path = repository(f.root); const store = new Store(join(f.root, "data")); const project = store.addProject(path);
    const task = session(project, "locked setup"); const workspace = store.assignWorkspace(task, project);
    const manager = new Workspaces(store); await manager.ensure(task, project, () => {});
    git(path, "worktree", "lock", "--reason", "initializing", workspace.checkoutPath!);
    workspace.status = "pending";
    await assert.rejects(manager.ensure(task, project, () => {}), /checkout is locked/);
    git(path, "worktree", "unlock", workspace.checkoutPath!);
    await manager.ensure(task, project, () => {}); assert.equal(workspace.status, "ready");
  } finally { f.cleanup(); }
});


test("invalid workspace records and cross-project defaults are refused without rewriting the index", () => {
  const f = temporary();
  try {
    const store = new Store(join(f.root, "data")); const project = store.addProject(f.root); store.save();
    const initial = readFileSync(store.file, "utf8");
    const malformed = [
      (state: typeof store.state) => { state.workspaces![0]!.status = "broken" as "ready"; },
      (state: typeof store.state) => { state.projects[0]!.workspaceDefault = { kind: "existing", workspaceId: "missing" }; },
      (state: typeof store.state) => { state.workspaces![0]!.path = "relative/path"; },
      (state: typeof store.state) => { state.workspaces!.push({ ...state.workspaces![0]! }); },
      (state: typeof store.state) => { state.sessions.push({ ...session(project, "bad"), workspaceId: "missing" }); },
    ];
    for (const corrupt of malformed) {
      const state = JSON.parse(initial) as typeof store.state; corrupt(state);
      const contents = JSON.stringify(state); writeFileSync(store.file, contents);
      assert.throws(() => new Store(store.root), /Invalid zz state/);
      assert.equal(readFileSync(store.file, "utf8"), contents);
    }
  } finally { f.cleanup(); }
});
