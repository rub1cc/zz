import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { stripTerminalSequences, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { Composer } from "../src/composer.js";
import { cancelExternalEditor, editExternally, editorCommand, isExternalEditorOpen } from "../src/external-editor.js";
import { FakeTerminal, temporary } from "./helpers.js";

function composer(edit?: (text: string) => Promise<string>) {
  const tui = new TuiAltScreen(new FakeTerminal());
  const errors: unknown[] = [];
  const input = new Composer(tui, "describe a task", (error) => errors.push(error), edit);
  return { tui, input, errors };
}

test("Ctrl+J inserts a newline at the cursor; Enter submits; rejected drafts survive", () => {
  const { input } = composer();
  const sent: string[] = [];
  input.onSubmit = (text) => { sent.push(text); return true; };
  input.handleInput("first line");
  input.handleInput("\x0a");
  input.handleInput("second line 日本語 🧑‍💻");
  assert.equal(input.getValue(), "first line\nsecond line 日本語 🧑‍💻");
  assert.deepEqual(sent, []);
  input.handleInput("\r");
  assert.deepEqual(sent, ["first line\nsecond line 日本語 🧑‍💻"]);
  assert.equal(input.getValue(), "");
  input.setValue("abcd");
  input.handleInput("\x1b[D"); input.handleInput("\x1b[D"); input.handleInput("\x0a");
  assert.equal(input.getValue(), "ab\ncd");
  input.onSubmit = () => false;
  input.setValue("  keep\n  this draft  ");
  input.handleInput("\r");
  assert.equal(input.getValue(), "  keep\n  this draft  ");
});

test("multiline paste stays intact, renders bounded lines and exposes expanded text", () => {
  const { input } = composer();
  assert.match(input.render(40).map(stripTerminalSequences).join("\n"), /describe a task/);
  const text = Array.from({ length: 30 }, (_, i) => `line ${i} 日本語 🧑‍💻`).join("\n");
  input.handleInput(`\x1b[200~${text}\x1b[201~`);
  assert.equal(input.getValue(), text);
  input.focused = true;
  for (const width of [1, 4, 10, 24, 120]) {
    const lines = input.render(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.ok(lines.length <= 12);
  }
  input.onSubmit = (submitted) => { assert.equal(submitted, text); return true; };
  input.handleInput("\r");
  assert.equal(input.getValue(), "");
});

test("Ctrl+G round-trips the draft, prevents duplicate editors, and never submits", async () => {
  let resolve!: (text: string) => void;
  const received: string[] = [];
  const { input } = composer((text) => {
    received.push(text);
    return new Promise<string>((done) => { resolve = done; });
  });
  input.setValue("original\ndraft");
  input.onSubmit = () => { assert.fail("Editing must not send a message"); };
  input.handleInput("\x07");
  assert.equal(input.editing, true);
  input.handleInput("\x07");
  input.handleInput("\r");
  assert.deepEqual(received, ["original\ndraft"]);
  resolve("edited\ndraft");
  await delay(0);
  assert.equal(input.editing, false);
  assert.equal(input.getValue(), "edited\ndraft");
});

test("editor errors keep the original draft and report the failure", async () => {
  const failure = new Error("Editor unavailable");
  const { input, errors } = composer(async () => { throw failure; });
  input.setValue("keep\nthis");
  await input.openEditor();
  assert.equal(input.getValue(), "keep\nthis");
  assert.deepEqual(errors, [failure]);
  assert.equal(input.editing, false);
});

test("external editor selection prefers VISUAL, then EDITOR, then Vim", () => {
  assert.equal(editorCommand({ VISUAL: "nvim -f", EDITOR: "nano" }), "nvim -f");
  assert.equal(editorCommand({ VISUAL: " ", EDITOR: "nano" }), "nano");
  assert.equal(editorCommand({}), "vim");
});

function externalFixture() {
  const temp = temporary();
  const directory = join(temp.root, "editor with spaces");
  mkdirSync(directory);
  const report = join(directory, "report.json");
  const script = join(directory, "fake editor.mjs");
  writeFileSync(script, `import {readFileSync, writeFileSync} from 'node:fs';
const [report, mode, file] = process.argv.slice(2);
writeFileSync(report, JSON.stringify({file, content: readFileSync(file, 'utf8')}));
if (mode === 'wait') setInterval(() => {}, 1000);
else {
  writeFileSync(file, '\\uFEFFedited\\r\\n日本語\\r\\n');
  if (mode === 'fail') process.exitCode = 3;
}
`);
  const events: string[] = [];
  const tui = { stop: () => events.push("stop"), start: () => events.push("start"),
    requestRender: (force?: boolean) => { events.push(`render:${force}`); } };
  const command = (mode: string) => `"${process.execPath}" "${script}" "${report}" ${mode}`;
  return { ...temp, events, tui, report, command };
}

test("external editor accepts quoted commands, restores the terminal, and cleans private temp files", async () => {
  const f = externalFixture();
  try {
    const result = await editExternally(f.tui, "original\ntext", f.command("success"));
    assert.equal(result, "edited\n日本語");
    const report = JSON.parse(readFileSync(f.report, "utf8"));
    assert.equal(report.content, "original\ntext");
    assert.equal(existsSync(dirname(report.file)), false);
    assert.deepEqual(f.events, ["stop", "start", "render:true"]);
    assert.equal(isExternalEditorOpen(f.tui), false);
  } finally { f.cleanup(); }
});

test("external editor failures restore the terminal and clean up, even if the editor modified the file", async () => {
  const f = externalFixture();
  try {
    await assert.rejects(editExternally(f.tui, "keep", f.command("fail")), /code 3.*Draft kept/);
    const { file } = JSON.parse(readFileSync(f.report, "utf8"));
    assert.equal(existsSync(dirname(file)), false);
    assert.deepEqual(f.events, ["stop", "start", "render:true"]);
    f.events.length = 0;
    await assert.rejects(editExternally(f.tui, "keep", "zz-no-such-editor-command"), /Draft kept/);
    assert.deepEqual(f.events, ["stop", "start", "render:true"]);
  } finally { f.cleanup(); }
});

test("shutdown cancels an open editor without restarting the dashboard", async () => {
  const f = externalFixture();
  try {
    const editing = editExternally(f.tui, "draft", f.command("wait"));
    const rejected = assert.rejects(editing);
    try {
      assert.equal(isExternalEditorOpen(f.tui), true);
      await assert.rejects(editExternally(f.tui, "duplicate", f.command("success")), /already open/);
      for (let i = 0; i < 100 && !existsSync(f.report); i++) await delay(20);
      assert.equal(existsSync(f.report), true);
      const { file } = JSON.parse(readFileSync(f.report, "utf8"));
      if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
    } finally { await cancelExternalEditor(f.tui); await rejected; }
    assert.deepEqual(f.events, ["stop"]);
    assert.equal(isExternalEditorOpen(f.tui), false);
    const { file } = JSON.parse(readFileSync(f.report, "utf8"));
    assert.equal(existsSync(dirname(file)), false);
  } finally { f.cleanup(); }
});

test("suggestions accept without submitting, dismiss without losing drafts, and fit narrow terminals", async () => {
  const { input } = composer();
  input.setDiscovery({ cwd: process.cwd(), commands: true, session: false });
  input.onSubmit = () => { assert.fail("Accepting a suggestion must not submit"); };
  input.handleInput("/th"); await delay(20);
  assert.equal(input.showingSuggestions, true);
  for (const width of [1, 4, 10, 24, 120]) {
    assert.ok(input.render(width).every((line) => visibleWidth(line) <= width));
  }
  input.handleInput("\r");
  assert.equal(input.getValue(), "/thinking ");
  assert.equal(input.showingSuggestions, false);
  input.setValue(""); input.handleInput("/mo"); await delay(20);
  assert.equal(input.showingSuggestions, true);
  assert.equal(input.handleDiscoveryInput("\x1b"), true);
  assert.equal(input.getValue(), "/mo");
  assert.equal(input.showingSuggestions, false);
  input.setValue(""); input.handleInput("/"); await delay(20);
  input.setDiscovery({ cwd: process.cwd(), commands: true, session: true });
  assert.equal(input.showingSuggestions, false, "Changing completion scope discards the old menu");
  assert.equal(input.getValue(), "/");
});

test("Escape cancels a debounced @ query before it can open a late menu", async () => {
  const { input } = composer();
  input.setDiscovery({ cwd: process.cwd(), commands: true, session: true });
  input.handleInput("@");
  assert.equal(input.showingSuggestions, false);
  assert.equal(input.handleDiscoveryInput("\x1b"), true);
  await delay(350);
  assert.equal(input.showingSuggestions, false);
  assert.equal(input.getValue(), "@");
  assert.equal(input.handleDiscoveryInput("\x1b"), false, "A second Escape belongs to the parent view");
});
