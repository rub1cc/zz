import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { DEFAULT_COMPACTION_POLICY } from "@earendil-works/pi-durable";
import { TuiAltScreen, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { Controller } from "../src/controller.js";
import { Store } from "../src/store.js";
import { SettingsPage } from "../src/settings-page.js";
import { FakeEngine, FakeTerminal, temporary } from "./helpers.js";

// No network, provider configuration, or model is needed to configure run policy.
test("auto-compaction defaults follow the SDK and optional saved fields round-trip independently", () => {
  const temp = temporary();
  try {
    const store = new Store(temp.root);
    assert.deepEqual(store.compaction, DEFAULT_COMPACTION_POLICY);
    assert.deepEqual(store.settings, { replyBehavior: "followUp" });
    const copy = store.compaction; copy.enabled = false;
    assert.equal(store.compaction.enabled, true);
    for (const compaction of [{}, { enabled: false }, { backgroundTokens: 0 },
      { reserveTokens: 2, keepRecentTokens: 0, backgroundTokens: 0, enabled: false }]) {
      store.state.settings = { replyBehavior: "steer", showThinking: false, compaction };
      store.save();
      const restored = new Store(temp.root);
      assert.deepEqual(restored.settings, store.settings);
      assert.deepEqual(restored.compaction, { ...DEFAULT_COMPACTION_POLICY, ...compaction });
    }
  } finally { temp.cleanup(); }
});

test("malformed auto-compaction settings are refused without overwriting the saved history", () => {
  const temp = temporary();
  try {
    const store = new Store(temp.root);
    for (const compaction of [null, [], true, { enabled: "yes" }, { reserveTokens: 0 }, { reserveTokens: 1 },
      { reserveTokens: -1 }, { reserveTokens: 12.5 }, { keepRecentTokens: -1 }, { keepRecentTokens: "100" },
      { backgroundTokens: -1 }, { backgroundTokens: 1.5 }, { reserveTokens: null },
      { backgroundTokens: Number.MAX_SAFE_INTEGER }, { reserveTokens: Number.MAX_SAFE_INTEGER + 1 }, { threshold: 80 }]) {
      const text = JSON.stringify({ ...store.state, settings: { replyBehavior: "followUp", compaction } });
      writeFileSync(store.file, text);
      assert.throws(() => new Store(temp.root), /Invalid zz state/, JSON.stringify(compaction));
      assert.equal(readFileSync(store.file, "utf8"), text);
    }
  } finally { temp.cleanup(); }
});

test("compaction edits preserve other preferences, roll back failed saves and are blocked during shutdown", async (t) => {
  const temp = temporary(); const store = new Store(temp.root);
  const engine = new FakeEngine(); engine.listModels = async () => assert.fail("No model lookup needed");
  const c = new Controller(store, engine);
  try {
    const defaults = c.configuration;
    assert.equal(c.setCompaction({ enabled: false, backgroundTokens: 0 }), true);
    c.toggleThinking(); c.setReplyBehavior("steer");
    assert.equal(store.compaction.enabled, false); assert.equal(store.compaction.backgroundTokens, 0);
    assert.equal(store.settings.showThinking, false); assert.equal(store.settings.replyBehavior, "steer");
    const before = structuredClone(store.state);
    for (const change of [{ reserveTokens: 1 }, { keepRecentTokens: -1 }, { enabled: "true" as never }]) {
      assert.equal(c.setCompaction(change), false);
      assert.deepEqual(store.state, before);
    }
    const save = t.mock.method(store, "save", () => { throw new Error("Disk full"); });
    assert.equal(c.setCompaction({ reserveTokens: 30000 }), false);
    assert.match(c.notice, /Disk full/); assert.deepEqual(store.state, before);
    save.mock.restore();
    assert.deepEqual(new Store(temp.root).state, before);
    assert.equal(c.setCompaction({ reserveTokens: 30000 }), true);
    assert.equal(new Store(temp.root).compaction.reserveTokens, 30000);
    assert.deepEqual(c.configuration, defaults); assert.equal(engine.calls.length, 0);
    await c.close();
    assert.equal(c.setCompaction({ enabled: true }), false);
    assert.equal(store.compaction.enabled, false);
  } finally { await c.close(); temp.cleanup(); }
});

test("compaction settings and numeric editing fit narrow/short terminals and preserve unsaved input", async () => {
  const temp = temporary(); const store = new Store(temp.root); const c = new Controller(store, new FakeEngine());
  const terminal = new FakeTerminal(); const tui = new TuiAltScreen(terminal);
  try {
    c.showSettings("reserveTokens");
    const page = new SettingsPage(c, tui, c.dialog as Extract<NonNullable<typeof c.dialog>, { kind: "settings" }>);
    page.focused = true;
    for (const rows of [12, 18, 24, 32]) {
      terminal.rows = rows;
      for (const width of [1, 8, 24, 80]) {
        const lines = page.render(width);
        assert.ok(lines.every((line) => visibleWidth(line) <= width));
        assert.ok(lines.length <= Math.floor(rows * 0.85), `${rows} rows: ${lines.length} lines`);
      }
    }
    page.handleInput("\r"); page.handleInput("\x15"); page.handleInput("12345");
    for (const rows of [12, 18, 24, 32]) {
      terminal.rows = rows;
      for (const width of [1, 8, 24, 80]) {
        const lines = page.render(width);
        assert.ok(lines.every((line) => visibleWidth(line) <= width));
        assert.ok(lines.length <= Math.floor(rows * 0.85), `${rows} rows: ${lines.length} edit lines`);
        if (width === 80) assert.match(lines.map(stripTerminalSequences).join("\n"), /12345/);
      }
    }
    assert.equal(store.compaction.reserveTokens, DEFAULT_COMPACTION_POLICY.reserveTokens);
    page.handleInput("\x1b"); assert.equal(c.dialog?.kind, "settings");
    page.handleInput("\x1b"); assert.equal(c.dialog, undefined);
    assert.equal(store.compaction.reserveTokens, DEFAULT_COMPACTION_POLICY.reserveTokens);
  } finally { await c.close(); temp.cleanup(); }
});
