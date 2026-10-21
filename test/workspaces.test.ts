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
function session(project: { id: string; path?: string }, id: string): Session {
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
    assert.equal(store.state.version, 3);
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

test("subdirectory projects retain their relative cwd and discover shared worktrees through Git", async () => {
  const f = temporary();
  try {
    const root = repository(f.root); const store = new Store(join(f.root, "data"));
    const project = store.addProject(join(root, "pkg")); const task = session(project, "subdir"); store.state.sessions.push(task);
    const workspace = store.assignWorkspace(task, project);
    const manager = new Workspaces(store); await manager.ensure(task, project, () => {});
    assert.equal(readFileSync(join(workspace.path, "source.txt"), "utf8"), "source\n");
    assert.equal(workspace.path, join(workspace.checkoutPath!, "pkg"));
    assert.equal((await manager.resolve(project, workspace.checkoutPath!)).id, workspace.id);
    const external = join(f.root, "external"); git(root, "worktree", "add", "-b", "external", external);
    const imported = await manager.resolve(project, external);
    assert.equal(imported.path, join(external, "pkg")); assert.equal(imported.managed, false);
    const other = session(project, "review"); store.assignWorkspace(other, project, { kind: "existing", path: imported.path });
    assert.equal(store.workspaceKey(other), imported.path);
    await assert.rejects(manager.resolve(project, f.root), /belonging/);
    rmSync(join(external, "pkg"), { recursive: true });
    assert.equal((await manager.discover(project)).some((w) => w.checkoutPath === external), false);
  } finally { f.cleanup(); }
});

test("failed worktree preparation is retained, retryable, and never falls back to the main checkout", async () => {
  const f = temporary();
  try {
    const path = repository(f.root); const store = new Store(join(f.root, "data")); const project = store.addProject(path);
    const task = session(project, "bad base"); store.state.sessions.push(task); const workspace = store.assignWorkspace(task, project, { kind: "new", baseRef: "missing" });
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
    assert.equal(store.boundWorkspaces.length, 1); assert.equal(existsSync(join(store.root, "worktrees")), false);
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
    assert.equal(task.workspace?.id, workspace.id); assert.notEqual(store.sessionPath(task), path);
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


test("invalid session workspace bindings and defaults are refused without rewriting the index", () => {
  const f = temporary();
  try {
    const store = new Store(join(f.root, "data")); const project = store.addProject(f.root);
    const task = session(project, "bound"); store.state.sessions.push(task);
    store.assignWorkspace(task, project, { kind: "main" }); store.save();
    const initial = readFileSync(store.file, "utf8");
    const malformed = [
      (state: typeof store.state) => { state.sessions[0]!.workspace!.status = "broken" as "ready"; },
      (state: typeof store.state) => { state.projects[0]!.workspaceDefault = { kind: "existing", path: "relative/path" }; },
      (state: typeof store.state) => { state.sessions[0]!.workspace!.path = "relative/path"; },
      (state: typeof store.state) => { state.sessions[0]!.workspace!.projectId = "foreign-project"; },
      (state: typeof store.state) => { state.sessions[0]!.workspaceId = "legacy-binding"; },
      (state: typeof store.state) => { state.sessions.push({ ...state.sessions[0]!, id: "conflict",
        workspace: { ...state.sessions[0]!.workspace!, path: join(f.root, "another-directory") } }); },
      (state: typeof store.state) => { state.workspaces = []; },
    ];
    for (const corrupt of malformed) {
      const state = JSON.parse(initial) as typeof store.state; corrupt(state);
      const contents = JSON.stringify(state); writeFileSync(store.file, contents);
      assert.throws(() => new Store(store.root), /Invalid zz state/);
      assert.equal(readFileSync(store.file, "utf8"), contents);
    }
  } finally { f.cleanup(); }
});

test("Git discovers external, detached, and unreferenced worktrees without persisting an inventory", async () => {
  const f = temporary();
  try {
    const root = repository(f.root); const store = new Store(join(f.root, "data")); const project = store.addProject(root);
    const manager = new Workspaces(store); const before = readFileSync(store.file, "utf8");
    const external = join(f.root, "external with spaces\nand newline");
    git(root, "worktree", "add", "-b", "review", external);
    const detached = join(f.root, "detached"); git(root, "worktree", "add", "--detach", detached);
    let listed = await manager.discover(project);
    assert.deepEqual(listed.map((w) => w.path).sort(), [root, external, detached].sort());
    assert.equal(listed.find((w) => w.path === external)!.branch, "review");
    assert.equal(listed.find((w) => w.path === detached)!.branch, undefined);
    assert.equal((await manager.resolve(project, external)).path, external);
    assert.equal(readFileSync(store.file, "utf8"), before);
    assert.equal(store.boundWorkspaces.length, 0);
    assert.equal(store.state.workspaces, undefined);
    git(external, "branch", "-m", "renamed-review");
    assert.equal((await manager.discover(project)).find((w) => w.path === external)!.branch, "renamed-review");
    git(root, "worktree", "remove", detached);
    rmSync(external, { recursive: true });
    listed = await manager.discover(project); assert.deepEqual(listed.map((w) => w.path), [root]);
    git(root, "worktree", "prune");
    assert.deepEqual((await manager.discover(project)).map((w) => w.path), [root]);
    assert.equal(readFileSync(store.file, "utf8"), before);
  } finally { f.cleanup(); }
});

test("format 2 migrates bindings and defaults, drops orphan registrations, and retains missing checkout identities", async () => {
  const f = temporary();
  try {
    const root = repository(f.root); const data = join(f.root, "data"); mkdirSync(data);
    const project = { id: "project", path: root, workspaceDefault: { kind: "existing", workspaceId: "default" } };
    const missing = { id: "bound", projectId: project.id, projectPath: root, path: join(f.root, "missing"),
      checkoutPath: join(f.root, "missing"), branch: "in-progress", baseRef: "main", baseCommit: git(root, "rev-parse", "HEAD"),
      kind: "worktree", managed: true, status: "ready" };
    const interrupted = { ...missing, id: "interrupted", path: join(f.root, "interrupted"),
      checkoutPath: join(f.root, "interrupted"), status: "failed", error: "interrupted creation" };
    const original = JSON.stringify({ version: 2, projects: [project], sessions: [
      { ...session(project, "bound session"), workspaceId: missing.id },
      { ...session(project, "shared session"), workspaceId: missing.id },
      { ...session(project, "interrupted session"), workspaceId: interrupted.id },
    ], workspaces: [missing, interrupted, { ...missing, id: "orphan", path: join(f.root, "orphan") },
      { ...missing, id: "default", path: join(f.root, "saved-default") }] });
    writeFileSync(join(data, "state.json"), original);
    const store = new Store(data);
    assert.equal(store.state.version, 3); assert.equal(store.state.workspaces, undefined);
    assert.equal(readFileSync(join(data, "state.v2.backup.json"), "utf8"), original);
    assert.deepEqual(store.state.projects[0]!.workspaceDefault, { kind: "existing", path: join(f.root, "saved-default") });
    const task = store.state.sessions[0]!;
    assert.deepEqual(task.workspace, missing); assert.equal(task.workspaceId, undefined);
    assert.equal(task.workspace, store.state.sessions[1]!.workspace);
    assert.equal(store.boundWorkspaces.length, 2);
    assert.deepEqual(store.state.sessions[2]!.workspace, interrupted);
    assert.equal(store.sessionPath(task), missing.path);
    await assert.rejects(new Workspaces(store).ensure(task, store.state.projects[0]!, () => {}), /ENOENT/);
    assert.equal(store.sessionPath(task), missing.path);
    assert.equal(readFileSync(join(root, "file.txt"), "utf8"), "base\n");
    assert.equal(new Store(data).state.sessions[0]!.workspace!.id, missing.id);
  } finally { f.cleanup(); }
});

test("Git worktree moves discover the new path without moving an existing session binding", async () => {
  const f = temporary();
  try {
    const root = repository(f.root); const store = new Store(join(f.root, "data")); const project = store.addProject(root);
    const external = join(f.root, "old"); const moved = join(f.root, "moved");
    git(root, "worktree", "add", "-b", "movable", external);
    const task = session(project, "stays bound"); store.state.sessions.push(task);
    store.assignWorkspace(task, project, { kind: "existing", path: external }); store.save();
    git(root, "worktree", "move", external, moved);
    const manager = new Workspaces(store);
    assert.deepEqual((await manager.discover(project)).map((w) => w.path).sort(), [root, moved].sort());
    assert.equal(store.sessionPath(task), external);
    assert.equal((await manager.describe(task.workspace!)).available, false);
    await assert.rejects(manager.ensure(task, project, () => {}), /ENOENT/);
    assert.equal(store.sessionPath(new Store(store.root).state.sessions[0]!), external);
  } finally { f.cleanup(); }
});

test("creation metadata can checkpoint to a handoff journal without a workspace inventory", async () => {
  const f = temporary();
  try {
    const root = repository(f.root); const store = new Store(join(f.root, "data")); const project = store.addProject(root);
    const candidate = session(project, "handoff target");
    const target = store.assignWorkspace(candidate, project);
    const snapshots: NonNullable<Session["workspace"]>[] = [];
    await new Workspaces(store).ensure(candidate, project, () => {}, undefined, false, async (workspace) => {
      snapshots.push(structuredClone(workspace));
      if (workspace.baseCommit && workspace.status === "pending") assert.equal(existsSync(workspace.checkoutPath!), false);
    });
    assert.ok(snapshots.some((w) => w.baseCommit && w.status === "pending"));
    assert.equal(snapshots.at(-1)!.status, "ready");
    assert.equal(snapshots.at(-1)!.baseCommit, git(target.path, "rev-parse", "HEAD"));
    assert.equal(new Store(store.root).boundWorkspaces.length, 0);
    assert.equal((await new Workspaces(store).discover(project)).some((w) => w.path === target.path), true);
  } finally { f.cleanup(); }
});

test("project-scoped bindings stay distinct when another project's main directory is the same worktree", async () => {
  const f = temporary();
  try {
    const root = repository(f.root); const store = new Store(join(f.root, "data")); const project = store.addProject(root);
    const external = join(f.root, "external"); git(root, "worktree", "add", "-b", "shared", external);
    const otherProject = store.addProject(external);
    const first = session(project, "external binding"); const second = session(otherProject, "main binding");
    store.state.sessions.push(first, second);
    store.assignWorkspace(first, project, { kind: "existing", path: external });
    store.assignWorkspace(second, otherProject, { kind: "main" }); store.save();
    const restored = new Store(store.root);
    assert.equal(restored.boundWorkspaces.length, 2);
    assert.equal(restored.state.sessions[0]!.workspace!.kind, "worktree");
    assert.equal(restored.state.sessions[1]!.workspace!.kind, "main");
    assert.equal(restored.state.sessions[0]!.workspace!.projectId, project.id);
    assert.equal(restored.state.sessions[1]!.workspace!.projectId, otherProject.id);
    const manager = new Workspaces(restored);
    const [a, b] = await Promise.all(restored.state.sessions.map((task) => manager.ensure(task,
      restored.state.projects.find((p) => p.id === task.projectId)!, () => {})));
    assert.equal(a!.projectId, project.id); assert.equal(b!.projectId, otherProject.id);
  } finally { f.cleanup(); }
});

test("new checkouts use the repository basename and generated branch, then retain that choice on retries", async () => {
  const f = temporary();
  try {
    const root = repository(f.root); const store = new Store(join(f.root, "data"));
    const project = store.addProject(join(root, "pkg")); const task = session(project, "Fix auth"); store.state.sessions.push(task);
    const workspace = store.assignWorkspace(task, project);
    let calls = 0;
    const manager = new Workspaces(store, async () => { calls++; return "feature/Fix-Auth"; });
    await manager.ensure(task, project, () => {});
    assert.equal(workspace.branch, `feature/Fix-Auth-${workspace.id.slice(0, 8)}`);
    assert.equal(workspace.checkoutPath, join(store.root, "worktrees", "repo", `feature-fix-auth-${workspace.id.slice(0, 8)}`));
    assert.equal(workspace.path, join(workspace.checkoutPath!, "pkg"));
    assert.equal(git(workspace.path, "branch", "--show-current"), workspace.branch);
    workspace.status = "pending"; task.title = "A later title"; store.save();
    const reopened = new Store(store.root);
    await new Workspaces(reopened, async () => assert.fail("Do not regenerate persisted names"))
      .ensure(reopened.state.sessions[0]!, reopened.state.projects[0]!, () => {});
    assert.equal(calls, 1);
    assert.equal(reopened.state.sessions[0]!.workspace!.path, workspace.path);
    assert.equal(workspace.namingPending, false);
  } finally { f.cleanup(); }
});

test("explicit branch names bypass generation and still use the repository directory", async () => {
  const f = temporary();
  try {
    const root = repository(f.root); const store = new Store(join(f.root, "data"));
    const project = store.addProject(join(root, "pkg")); const task = session(project, "manual");
    const workspace = store.assignWorkspace(task, project, { kind: "new", baseRef: "main" }, "custom/ABC-42");
    await new Workspaces(store, async () => assert.fail("Explicit names bypass the LLM")).ensure(task, project, () => {});
    assert.equal(workspace.branch, "custom/ABC-42");
    assert.equal(workspace.checkoutPath, join(store.root, "worktrees", "repo", "custom-abc-42"));
  } finally { f.cleanup(); }
});

test("unavailable naming retains the deterministic fallback and separate sessions remain unique", async () => {
  const f = temporary();
  try {
    const root = repository(f.root); const store = new Store(join(f.root, "data")); const project = store.addProject(root);
    const a = session(project, "Same task"); const b = session(project, "Same task");
    const first = store.assignWorkspace(a, project); const second = store.assignWorkspace(b, project);
    const original = first.branch;
    const manager = new Workspaces(store, async () => undefined);
    await manager.ensure(a, project, () => {});
    assert.equal(first.branch, original);
    assert.equal(first.checkoutPath, join(store.root, "worktrees", "repo", `zz-same-task-${first.id.slice(0, 8)}`));
    assert.notEqual(first.path, second.path); assert.notEqual(first.branch, second.branch);
  } finally { f.cleanup(); }
});

test("legacy pending checkout paths and branches do not participate in new naming", async () => {
  const f = temporary();
  try {
    const root = repository(f.root); const store = new Store(join(f.root, "data")); const project = store.addProject(root);
    const task = session(project, "old task"); const workspace = store.assignWorkspace(task, project);
    delete workspace.namingPending;
    workspace.checkoutPath = join(store.root, "worktrees", project.id, workspace.id); workspace.path = workspace.checkoutPath;
    const original = { path: workspace.path, branch: workspace.branch };
    await new Workspaces(store, async () => assert.fail("Do not rename legacy checkouts")).ensure(task, project, () => {});
    assert.equal(workspace.path, original.path); assert.equal(workspace.branch, original.branch);
  } finally { f.cleanup(); }
});

test("cancellation during naming creates neither a branch nor a directory", async () => {
  const f = temporary();
  try {
    const root = repository(f.root); const store = new Store(join(f.root, "data")); const project = store.addProject(root);
    const task = session(project, "cancel naming"); const workspace = store.assignWorkspace(task, project);
    const abort = new AbortController();
    const manager = new Workspaces(store, async () => { abort.abort(); return undefined; });
    await assert.rejects(manager.ensure(task, project, () => {}, abort.signal), /Workspace preparation failed/);
    assert.equal(existsSync(workspace.path), false);
    assert.equal(git(root, "branch", "--list", workspace.branch!), "");
    assert.equal(workspace.namingPending, true);
  } finally { f.cleanup(); }
});
