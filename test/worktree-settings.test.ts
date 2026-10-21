import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { TuiAltScreen, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { Controller } from "../src/controller.js";
import { Store } from "../src/store.js";
import { SettingsPage } from "../src/settings-page.js";
import { DEFAULT_WORKTREE_NAMING_INSTRUCTIONS } from "../src/worktree-name.js";
import { FakeEngine, FakeTerminal, temporary } from "./helpers.js";

test("worktree naming instructions are optional, persist and reject malformed saved values", () => {
  const temp = temporary();
  try {
    const store = new Store(temp.root);
    assert.equal(store.settings.worktreeNamingInstructions, undefined);
    for (const worktreeNamingInstructions of ["Name branches after the task", "x".repeat(4000), ""]) {
      store.state.settings = { replyBehavior: "steer", showThinking: false, compaction: { enabled: false }, worktreeNamingInstructions };
      store.save();
      assert.deepEqual(new Store(temp.root).settings, store.settings);
    }
    for (const worktreeNamingInstructions of [null, false, 3, [], {}, "x".repeat(4001)]) {
      const text = JSON.stringify({ ...store.state, settings: { replyBehavior: "followUp", worktreeNamingInstructions } });
      writeFileSync(store.file, text);
      assert.throws(() => new Store(temp.root), /Invalid zz state/);
      assert.equal(readFileSync(store.file, "utf8"), text);
    }
  } finally { temp.cleanup(); }
});

test("worktree naming edits preserve preferences, reset defaults, roll back failed saves and stop at shutdown", async (t) => {
  const temp = temporary(); const store = new Store(temp.root);
  const engine = new FakeEngine(); engine.listModels = async () => assert.fail("No model lookup needed");
  const c = new Controller(store, engine);
  try {
    c.setReplyBehavior("steer"); c.toggleThinking(); c.setCompaction({ enabled: false });
    const before = structuredClone(store.settings);
    const defaults = c.configuration;
    assert.equal(c.setWorktreeNamingInstructions("  Describe the task in a short slug.  "), true);
    assert.deepEqual(new Store(temp.root).settings, { ...before, worktreeNamingInstructions: "Describe the task in a short slug." });
    const saved = structuredClone(store.state);
    assert.equal(c.setWorktreeNamingInstructions("x".repeat(4001)), false);
    assert.match(c.notice, /4000/); assert.deepEqual(store.state, saved);
    assert.equal(c.setWorktreeNamingInstructions(null as never), false);
    assert.match(c.notice, /must be text/); assert.deepEqual(store.state, saved);
    const save = t.mock.method(store, "save", () => { throw new Error("Disk full"); });
    for (const value of ["New instructions", ""]) {
      assert.equal(c.setWorktreeNamingInstructions(value), false);
      assert.match(c.notice, /Disk full/); assert.deepEqual(store.state, saved);
    }
    save.mock.restore();
    assert.equal(c.setWorktreeNamingInstructions(" \t "), true);
    assert.equal(Object.hasOwn(store.state.settings!, "worktreeNamingInstructions"), false);
    assert.deepEqual(new Store(temp.root).settings, before);
    assert.deepEqual(c.configuration, defaults); assert.equal(engine.calls.length, 0);
    await c.close();
    assert.equal(c.setWorktreeNamingInstructions("After close"), false);
    assert.deepEqual(store.settings, before);
  } finally { await c.close(); temp.cleanup(); }
});

test("worktree naming settings edit, validate, cancel and reset in narrow and short terminals", async () => {
  const temp = temporary(); const store = new Store(temp.root); const c = new Controller(store, new FakeEngine());
  const terminal = new FakeTerminal(); const tui = new TuiAltScreen(terminal);
  try {
    c.showSettings("worktreeNamingInstructions");
    const page = new SettingsPage(c, tui, c.dialog as Extract<NonNullable<typeof c.dialog>, { kind: "settings" }>);
    page.focused = true;
    const screen = () => page.render(100).map(stripTerminalSequences).join("\n");
    assert.match(screen(), /Worktree naming instructions\s+Default/);
    page.handleInput("\r");
    assert.match(screen(), /blank resets default/);
    page.handleInput("\x15"); page.handleInput("My task name rules");
    for (const rows of [12, 18, 24, 32]) {
      terminal.rows = rows;
      for (const width of [1, 8, 24, 100]) {
        const lines = page.render(width);
        assert.ok(lines.every((line) => visibleWidth(line) <= width));
        assert.ok(lines.length <= Math.floor(rows * 0.85), `${rows} rows: ${lines.length} lines`);
        if (width === 100) assert.match(lines.map(stripTerminalSequences).join("\n"), /My task name rules/);
      }
    }
    assert.equal(store.settings.worktreeNamingInstructions, undefined);
    terminal.rows = 32;
    page.handleInput("\r");
    assert.match(screen(), /Worktree naming instructions\s+Custom/);
    assert.equal(new Store(temp.root).settings.worktreeNamingInstructions, "My task name rules");
    page.handleInput("\r"); page.handleInput("\x15"); page.handleInput("x".repeat(4001)); page.handleInput("\r");
    assert.match(screen(), /at most 4000/);
    assert.equal(store.settings.worktreeNamingInstructions, "My task name rules");
    page.handleInput("\x1b"); assert.equal(c.dialog?.kind, "settings");
    page.handleInput("\r"); page.handleInput("\x15"); page.handleInput("Cancelled edit"); page.handleInput("\x1b");
    assert.equal(store.settings.worktreeNamingInstructions, "My task name rules");
    page.handleInput("\r"); page.handleInput("\x15"); page.handleInput("\r");
    assert.equal(store.settings.worktreeNamingInstructions, undefined);
    assert.equal(Object.hasOwn(new Store(temp.root).state.settings!, "worktreeNamingInstructions"), false);
    assert.match(screen(), /Worktree naming instructions\s+Default/);
    page.handleInput("\r"); page.handleInput("\r");
    assert.equal(store.settings.worktreeNamingInstructions, DEFAULT_WORKTREE_NAMING_INSTRUCTIONS);
    page.handleInput("\x1b"); assert.equal(c.dialog, undefined);
  } finally { await c.close(); temp.cleanup(); }
});
