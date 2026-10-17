import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { stripTerminalSequences, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { Controller } from "../src/controller.js";
import { rows, type Session } from "../src/model.js";
import { Store } from "../src/store.js";
import { Dashboard } from "../src/ui.js";
import { FakeEngine, FakeTerminal, temporary } from "./helpers.js";

function setup() {
  const temp = temporary();
  const store = new Store(join(temp.root, "data"));
  const alphaPath = join(temp.root, "alpha"); const betaPath = join(temp.root, "beta");
  mkdirSync(alphaPath); mkdirSync(betaPath);
  const alpha = store.addProject(alphaPath); const beta = store.addProject(betaPath);
  const engine = new FakeEngine();
  const controller = new Controller(store, engine);
  const terminal = new FakeTerminal();
  const tui = new TuiAltScreen(terminal, false);
  const app = new Dashboard(controller, tui, () => {});
  tui.setLayoutRoot(app); tui.setFocus(app); tui.start(); app.sync();
  const add = (id: string, projectId = alpha.id, status: Session["status"] = "completed", createdAt = 1) => {
    const session: Session = { id, projectId, title: id, status, createdAt, updatedAt: createdAt, preview: "Done", messages: [] };
    store.state.sessions.push(session);
    controller.changed();
    return session;
  };
  const ids = () => controller.currentRows.flatMap((row) => row.kind === "session" && row.project.id === alpha.id ? [row.session.id] : []);
  const command = (text: string) => { app.composer.setValue(text); terminal.onInput("\r"); };
  return { ...temp, store, alpha, beta, engine, controller, terminal, tui, app, add, ids, command,
    async cleanup() { await controller.close(); tui.stop(); temp.cleanup(); } };
}

test("/projects replaces Ctrl+O from dashboard and open session, without creating agent work", async () => {
  const f = setup();
  try {
    f.app.composer.setValue("unsent task");
    f.terminal.onInput("\x0f");
    assert.equal(f.controller.mode, "sessions");
    assert.equal(f.app.composer.getValue(), "unsent task");
    f.command("/projects");
    assert.equal(f.controller.mode, "projects");
    assert.equal(f.controller.project?.id, f.beta.id);
    f.tui.renderNow();
    const screen = f.tui.getScreenLines().map(stripTerminalSequences).join("\n");
    assert.match(screen, /esc back/);
    assert.doesNotMatch(screen, /ctrl\+o/);
    f.terminal.onInput("\x1b");
    assert.equal(f.controller.mode, "sessions");
    const session = f.add("open session");
    f.controller.select(`session:${session.id}`); f.controller.open();
    f.terminal.onInput("\x0f");
    assert.equal(f.controller.mode, "session");
    f.command("/projects");
    assert.equal(f.controller.mode, "projects");
    assert.equal(f.controller.project?.id, f.alpha.id);
    f.terminal.onInput("\r");
    assert.equal(f.controller.mode, "sessions");
    assert.equal(f.engine.calls.length, 0);
  } finally { await f.cleanup(); }
});

test("autocomplete Enter runs a command immediately while Tab only fills the dashboard composer", async () => {
  const f = setup();
  try {
    f.terminal.onInput("/he"); await delay(20);
    assert.equal(f.app.composer.showingSuggestions, true);
    f.terminal.onInput("\r");
    assert.equal(f.controller.dialog?.kind, "help");
    assert.equal(f.app.composer.getValue(), "");
    f.terminal.onInput("\x1b");
    assert.equal(f.controller.dialog, undefined);
    f.terminal.onInput("/he"); await delay(20);
    f.terminal.onInput("\t");
    assert.equal(f.app.composer.getValue(), "/help ");
    assert.equal(f.controller.dialog, undefined);
    f.terminal.onInput("\r");
    assert.equal((f.controller as Controller).dialog?.kind, "help");
    assert.equal(f.engine.calls.length, 0);
  } finally { await f.cleanup(); }
});

test("/projects works with no configured projects and offers adding a directory", async () => {
  const f = setup();
  try {
    f.store.state.projects = []; f.controller.selection = undefined; f.controller.changed();
    f.command("/projects");
    assert.equal(f.controller.mode, "projects");
    f.terminal.onInput("a");
    assert.equal(f.controller.dialog?.kind, "add-project");
    f.terminal.onInput(f.alpha.path); f.terminal.onInput("\r");
    assert.equal(f.controller.dialog, undefined);
    assert.equal(f.store.state.projects.length, 1);
    assert.equal(f.engine.calls.length, 0);
  } finally { await f.cleanup(); }
});

test("Shift+Up/Down moves the selected dashboard session, preserves drafts and saves stable order", async () => {
  const f = setup();
  try {
    const first = f.add("first", f.alpha.id, "working", 3);
    f.add("second", f.alpha.id, "failed", 2);
    f.add("third", f.alpha.id, "completed", 1);
    f.add("other", f.beta.id);
    f.controller.select("session:second");
    f.app.composer.setValue("unsent\nmultiline draft");
    f.terminal.onInput("\x1b[1;2A");
    assert.deepEqual(f.ids(), ["second", "first", "third"]);
    assert.equal(f.controller.selection, "session:second");
    f.terminal.onInput("\x1b[1;2A");
    assert.deepEqual(f.ids(), ["second", "first", "third"], "Top boundary does not cross projects");
    f.terminal.onInput("\x1b[1;2B"); f.terminal.onInput("\x1b[1;2B");
    assert.deepEqual(f.ids(), ["first", "third", "second"]);
    f.terminal.onInput("\x1b[1;2B");
    assert.deepEqual(f.ids(), ["first", "third", "second"], "Bottom boundary does not cross projects");
    assert.equal(f.app.composer.getValue(), "unsent\nmultiline draft");
    assert.equal(f.beta.sessionOrder, undefined);
    first.status = "completed"; f.controller.changed();
    assert.deepEqual(f.ids(), ["first", "third", "second"], "Status updates cannot undo manual ordering");
    const restored = new Store(f.store.root);
    assert.deepEqual(rows(restored.state).flatMap((row) => row.kind === "session" && row.project.id === f.alpha.id ? [row.session.id] : []), f.ids());
    f.add("new session", f.alpha.id, "completed", 4);
    assert.deepEqual(f.ids(), ["new session", "first", "third", "second"]);
    assert.equal(first.createdAt, 3);
    assert.equal(first.updatedAt, 3);
  } finally { await f.cleanup(); }
});

test("session management shortcuts ignore headings, project management and open sessions", async () => {
  const f = setup();
  try {
    const session = f.add("task"); f.add("another");
    const unchanged = () => {
      f.terminal.onInput("\x1b[1;2A"); f.terminal.onInput("\x1b[1;2B"); f.terminal.onInput("\x12");
      assert.equal(f.alpha.sessionOrder, undefined);
      assert.equal(f.controller.dialog, undefined);
      assert.equal(session.title, "task");
    };
    f.controller.select(`project:${f.alpha.id}`); unchanged();
    f.command("/projects"); unchanged();
    f.terminal.onInput("\x1b");
    f.controller.select(`session:${session.id}`); f.controller.open(); unchanged();
  } finally { await f.cleanup(); }
});

test("Ctrl+R edits the session name inline at the end, saves on Enter, and preserves the task draft", async () => {
  const f = setup();
  try {
    const session = f.add("Original name");
    f.controller.select(`session:${session.id}`);
    f.app.composer.setValue("unsent task");
    f.terminal.onInput("\x12");
    assert.equal(f.controller.dialog?.kind, "rename-session");
    assert.equal(f.tui.hasOverlay(), false);
    assert.equal(f.app.composer.focused, false);
    const lines = f.app.body.render(120);
    const row = f.app.body.positions.get(`session:${session.id}`)!;
    assert.match(lines[row]!, /Original name\x1b_pi:c/);
    assert.match(stripTerminalSequences(lines[row + 1]!), /enter save \/ esc cancel/);
    assert.equal([...lines, ...f.app.composer.render(120)].join("").split("\x1b_pi:c").length - 1, 1);
    for (const width of [12, 40, 120]) {
      f.terminal.columns = width; f.terminal.onResize(); f.tui.renderNow();
      assert.ok(f.tui.getScreenLines().every((line) => visibleWidth(line) <= width));
    }
    f.terminal.onInput(" updated"); f.terminal.onInput("\r");
    assert.equal(session.title, "Original name updated");
    assert.equal(session.titleRenamed, true);
    assert.equal(f.controller.dialog, undefined);
    assert.equal(f.controller.selection, `session:${session.id}`);
    assert.equal(f.app.composer.getValue(), "unsent task");
    assert.equal(f.app.composer.focused, true);
    assert.equal(f.app.body.rename, undefined);
    assert.equal(session.updatedAt, 1, "Renaming must not pretend to be agent activity");
    assert.equal(new Store(f.store.root).state.sessions[0]?.title, "Original name updated");
    assert.equal(f.engine.calls.length, 0);
  } finally { await f.cleanup(); }
});

test("rename rejects blank names, allows correction, and Escape cancels without changing the session", async () => {
  const f = setup();
  try {
    const session = f.add("Original name"); f.controller.select(`session:${session.id}`);
    f.terminal.onInput("\x12");
    f.terminal.onInput("\x05"); f.terminal.onInput("\x15"); f.terminal.onInput("  "); f.terminal.onInput("\r");
    assert.equal(f.controller.dialog?.kind, "rename-session");
    assert.match(f.controller.notice, /nonempty/);
    assert.equal(f.tui.hasOverlay(), false);
    const lines = f.app.body.render(120);
    const row = f.app.body.positions.get(`session:${session.id}`)!;
    assert.match(stripTerminalSequences(lines[row + 1]!), /nonempty/);
    assert.equal(f.app.composer.focused, false);
    assert.equal(session.title, "Original name");
    f.terminal.onInput("New name"); f.terminal.onInput("\x1b");
    assert.equal(f.controller.dialog, undefined);
    assert.equal(session.title, "Original name");
    assert.equal(session.titleRenamed, undefined);
    f.terminal.onInput("\x12"); f.terminal.onInput("\x05"); f.terminal.onInput("\x15");
    f.terminal.onInput("  New   name  "); f.terminal.onInput("\r");
    assert.equal(session.title, "New name");
  } finally { await f.cleanup(); }
});

test("failed saves roll back ordering and renames, leaving the inline editor open for retry", async (t) => {
  const f = setup();
  try {
    const session = f.add("task"); f.add("another");
    f.controller.select(`session:${session.id}`);
    const before = f.ids();
    const save = t.mock.method(f.store, "save", () => { throw new Error("Disk full"); });
    f.terminal.onInput("\x1b[1;2B");
    assert.deepEqual(f.ids(), before);
    assert.equal(f.alpha.sessionOrder, undefined);
    assert.match(f.controller.notice, /Disk full/);
    f.terminal.onInput("\x12");
    f.terminal.onInput("\x05"); f.terminal.onInput(" updated"); f.terminal.onInput("\r");
    assert.equal(session.title, "task");
    assert.equal(session.titleRenamed, undefined);
    assert.equal(f.controller.dialog?.kind, "rename-session");
    assert.match(f.controller.notice, /Disk full/);
    assert.equal(f.tui.hasOverlay(), false);
    const lines = f.app.body.render(120);
    const row = f.app.body.positions.get(`session:${session.id}`)!;
    assert.match(stripTerminalSequences(lines[row]!), /task updated/);
    assert.match(stripTerminalSequences(lines[row + 1]!), /Disk full/);
    save.mock.restore();
    f.terminal.onInput("\r");
    assert.equal(session.title, "task updated");
  } finally { await f.cleanup(); }
});

test("inline rename owns editing keys and keeps its draft and cursor across background refreshes", async () => {
  const f = setup();
  try {
    const session = f.add("Original name"); f.add("another");
    f.controller.select(`session:${session.id}`);
    f.app.composer.setValue("unsent task");
    f.terminal.onInput("\x12");
    f.terminal.onInput("\x1b[D"); f.terminal.onInput("!");
    for (const key of ["\x1b[A", "\x1b[B", "\x1b[1;2A", "\x1b[1;2B", "\x10", "\x0e", "\x18", "\x12"]) {
      f.terminal.onInput(key);
    }
    f.controller.changed();
    f.terminal.onInput("?");
    assert.equal(f.app.body.rename?.input.getValue(), "Original nam!?e");
    assert.equal(f.controller.selection, `session:${session.id}`);
    assert.equal(f.controller.pendingDelete, undefined);
    assert.equal(f.alpha.sessionOrder, undefined);
    assert.equal(f.app.composer.getValue(), "unsent task");
    assert.equal(session.title, "Original name");
    assert.equal(f.tui.hasOverlay(), false);
    f.terminal.onInput("\x1b");
    assert.equal(f.app.body.rename, undefined);
    assert.equal(f.app.composer.focused, true);
    assert.equal(session.title, "Original name");
    assert.equal(f.engine.calls.length, 0);
  } finally { await f.cleanup(); }
});

test("long Unicode inline names keep the end cursor visible at narrow widths and scroll into view", async () => {
  const f = setup();
  try {
    for (let i = 0; i < 30; i++) f.add(`task ${i}`);
    const session = f.add("target");
    session.title = "\u754c\u9762 \ud83d\ude00 ".repeat(20) + "end";
    f.controller.select(`session:${session.id}`);
    f.terminal.onInput("\x12");
    for (const width of [5, 6, 12, 40, 120]) {
      f.terminal.columns = width; f.terminal.onResize(); f.tui.renderNow();
      const lines = f.app.body.render(Math.max(1, width - 1));
      const row = f.app.body.positions.get(`session:${session.id}`)!;
      assert.ok(lines[row]!.includes("\x1b_pi:c"));
      assert.ok(lines.every((line) => visibleWidth(line) <= width - 1));
      assert.ok(f.tui.getScreenLines().every((line) => visibleWidth(line) <= width));
    }
    f.terminal.columns = 80; f.terminal.rows = 12; f.terminal.onResize();
    f.tui.renderNow();
    const lines = f.tui.getScreenLines().map(stripTerminalSequences);
    assert.ok(lines.some((line) => line.includes("end")), "The end of the name stays in the list viewport");
    assert.ok(lines.some((line) => line.includes("enter save / esc cancel")));
    f.terminal.onInput(" appended"); f.terminal.onInput("\r");
    assert.ok(session.title.endsWith("end appended"));
    assert.equal(f.engine.calls.length, 0);
  } finally { await f.cleanup(); }
});
