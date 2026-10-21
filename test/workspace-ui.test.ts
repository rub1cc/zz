import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { stripTerminalSequences, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { Controller } from "../src/controller.js";
import { Store } from "../src/store.js";
import { Dashboard } from "../src/ui.js";
import { WorkspaceDialog } from "../src/workspace-dialog.js";
import type { Session } from "../src/model.js";
import { FakeEngine, FakeTerminal, temporary, tick } from "./helpers.js";

function fixture() {
  const temp = temporary(); const path = join(temp.root, "project"); mkdirSync(path);
  const store = new Store(join(temp.root, "data")); const project = store.addProject(path);
  const engine = new FakeEngine(); const c = new Controller(store, engine);
  const terminal = new FakeTerminal(); const tui = new TuiAltScreen(terminal, false);
  const app = new Dashboard(c, tui, () => {}); tui.setLayoutRoot(app); tui.setFocus(app); tui.start(); app.sync();
  const task: Session = { id: "coding", projectId: project.id, title: "Fix auth", status: "completed", preview: "Done", messages: [], createdAt: 1, updatedAt: 1 };
  const workspace = store.assignWorkspace(task, project);
  mkdirSync(workspace.path, { recursive: true }); workspace.status = "ready";
  writeFileSync(join(workspace.path, "marker.txt"), "workspace only");
  store.state.sessions.push(task); store.save(); c.changed();
  return { ...temp, store, project, engine, c, terminal, tui, app, task, workspace,
    async cleanup() { app.dispose(); await c.close(); tui.stop(); temp.cleanup(); } };
}

test("workspace picker preserves the draft, saves project defaults and never moves existing sessions", async () => {
  const f = fixture();
  try {
    f.app.composer.setValue("keep my draft"); f.c.showWorkspace();
    assert.equal(f.c.dialog?.kind, "workspace");
    f.terminal.onInput("\x1b[B"); f.terminal.onInput("\x1b[B"); f.terminal.onInput("\r");
    assert.deepEqual(f.project.workspaceDefault, { kind: "main" }); assert.equal(f.c.dialog, undefined);
    assert.equal(f.app.composer.getValue(), "keep my draft"); assert.equal(f.task.workspaceId, f.workspace.id);
    assert.deepEqual(new Store(f.store.root).state.projects[0]!.workspaceDefault, { kind: "main" });
    f.app.composer.setValue("/workspace new main"); f.terminal.onInput("\r");
    assert.deepEqual(f.project.workspaceDefault, { kind: "new", baseRef: "main" });
    f.c.showWorkspace(); f.terminal.onInput("\x1b[B"); f.terminal.onInput("\r");
    f.terminal.onInput("\x01"); f.terminal.onInput("\x0b"); f.terminal.onInput("missing-ref"); f.terminal.onInput("\r");
    assert.deepEqual(f.project.workspaceDefault, { kind: "new", baseRef: "missing-ref" });
    assert.equal(f.task.workspaceId, f.workspace.id);
    assert.equal(f.engine.calls.length, 0);
  } finally { await f.cleanup(); }
});

test("workspace context renders narrow and wide, reports sharing, and routes shell and skills to the checkout", async () => {
  const f = fixture();
  try {
    const review: Session = { ...f.task, id: "review", title: "Review auth", messages: [] };
    f.store.state.sessions.push(review); f.c.select(`session:${f.task.id}`); f.c.open();
    for (const width of [12, 32, 80, 120]) {
      f.terminal.columns = width; f.terminal.onResize(); f.tui.renderNow();
      assert.ok(f.tui.getScreenLines().every((line) => visibleWidth(line) <= width));
    }
    f.terminal.columns = 120; f.terminal.onResize(); f.tui.renderNow();
    assert.match(f.tui.getScreenLines().map(stripTerminalSequences).join("\n"), /shared by 2 sessions/);
    f.c.showWorkspace();
    const dialog = new WorkspaceDialog(f.c, f.tui, { kind: "workspace", projectId: f.project.id, sessionId: f.task.id });
    for (const width of [1, 12, 40, 120]) assert.ok(dialog.render(width).every((line) => visibleWidth(line) <= width));
    assert.match(dialog.render(120).map(stripTerminalSequences).join("\n"), /2 sessions/);
    f.c.dialog = undefined;
    let skillsCwd = ""; f.engine.listSkills = async (project) => { skillsCwd = project.path; return []; };
    await f.c.skills(); assert.equal(skillsCwd, f.workspace.path); f.c.dialog = undefined;
    assert.equal(f.c.runShell("pwd"), true); await f.c.shellRun!.done; await tick();
    assert.equal(f.task.shellResponses?.at(-1)?.cwd, f.workspace.path);
    assert.equal(f.task.shellResponses?.at(-1)?.text.trim(), f.workspace.path);
    assert.equal(f.c.selectWorkspace({ kind: "existing", workspaceId: f.workspace.id }), true);
    f.c.back(); assert.equal(f.c.executionProject()?.path, f.workspace.path);
    assert.equal(f.c.send("start another conversation"), true); await tick();
    assert.equal(f.task.workspaceId, f.workspace.id);
    f.c.select(`session:${f.task.id}`); f.c.requestDelete(); await f.c.confirmDelete();
    assert.equal(f.store.state.sessions.some((s) => s.id === f.task.id), false);
    assert.equal(existsSync(f.workspace.path), true); assert.equal(readFileSync(join(f.workspace.path, "marker.txt"), "utf8"), "workspace only");
  } finally { await f.cleanup(); }
});

test("workspace undo locks shared directories and permits independent checkouts", async () => {
  const f = fixture(); let finish!: () => void;
  try {
    const other: Session = { ...f.task, id: "other", title: "Other", messages: [] };
    f.store.assignWorkspace(other, f.project, { kind: "main" }); f.store.state.sessions.push(other);
    f.c.select(`session:${f.task.id}`); f.c.open();
    other.status = "working";
    await f.c.showUndo(); assert.equal(f.c.dialog?.kind, "undo");
    f.engine.undo = async () => { await new Promise<void>((resolve) => { finish = resolve; }); return { prompt: "restore", files: 0, shell: false }; };
    const undo = f.c.undo("latest", f.task.id);
    assert.equal(f.c.send("same checkout", f.task.id), false);
    assert.equal(f.c.send("independent checkout", other.id), true);
    finish(); await undo;
    other.workspaceId = f.task.workspaceId; other.status = "working";
    await f.c.showUndo(); assert.match(f.c.notice, /workspace's sessions/);
  } finally { finish?.(); await f.cleanup(); }
});


test("external workspace approval controls preserve drafts, reject stale decisions, and guard replies and shell", async () => {
  const f = fixture(); const decisions: { id: string; approved: boolean }[] = [];
  try {
    f.c.select(`session:${f.task.id}`); f.c.open();
    f.app.composer.setValue("unsent draft");
    f.task.workspaceSwitch = { id: "request-1", phase: "approval", workspaceId: "destination", path: "/external/checkout" };
    f.task.status = "needs-input";
    f.c.engine.approveWorkspace = async (session, id, approved) => { decisions.push({ id, approved }); delete session.workspaceSwitch; };
    f.c.showWorkspace();
    const stale = new WorkspaceDialog(f.c, f.tui, { kind: "workspace", projectId: f.project.id, sessionId: f.task.id });
    for (const width of [12, 24, 80, 120]) assert.ok(stale.render(width).every((line) => visibleWidth(line) <= width));
    assert.match(stale.render(120).map(stripTerminalSequences).join("\n"), /external\/checkout/);
    assert.equal(f.c.send("yes"), false); assert.match(f.c.notice, /Approve or deny/);
    assert.equal(f.c.runShell("pwd"), false); assert.match(f.c.notice, /workspace handoff/);
    f.task.workspaceSwitch!.id = "request-2";
    stale.handleInput("\r"); await tick(); assert.equal(decisions.length, 0); assert.match(f.c.notice, /approval changed/);
    f.c.showWorkspace(); f.terminal.onInput("\x1b[B"); f.terminal.onInput("\r"); await tick();
    assert.deepEqual(decisions, [{ id: "request-2", approved: false }]);
    assert.equal(f.app.composer.getValue(), "unsent draft"); assert.equal(f.task.workspaceId, f.workspace.id);
    assert.match(f.c.notice, /denied/);
    f.task.workspaceSwitch = { id: "request-3", phase: "approval", workspaceId: "destination", path: "/external/checkout" };
    f.app.composer.setValue("/workspace approve"); f.terminal.onInput("\r"); await tick();
    assert.deepEqual(decisions.at(-1), { id: "request-3", approved: true });
  } finally { await f.cleanup(); }
});
