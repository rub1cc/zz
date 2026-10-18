import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth, type SelectItem } from "@earendil-works/pi-tui";
import { DirectoryInput, directorySuggestions } from "../src/directory-input.js";
import { temporary, tick } from "./helpers.js";

const values = async (path: string, cwd: string, home = cwd) =>
  (await directorySuggestions(path, cwd, home)).map((item) => item.value);
const text = (input: DirectoryInput, width = 80) => input.render(width).map(stripTerminalSequences).join("\n");

test("directory completion browses relative, absolute, parent and home paths without quoting spaces", async () => {
  const f = temporary();
  try {
    mkdirSync(join(f.root, "alpha")); mkdirSync(join(f.root, "source dir"));
    mkdirSync(join(f.root, "source dir", "nested")); mkdirSync(join(f.root, ".hidden"));
    writeFileSync(join(f.root, "a-file"), "");
    assert.deepEqual(await values("", f.root), ["alpha/", "source dir/"]);
    assert.deepEqual(await values("a", f.root), ["alpha/"]);
    assert.deepEqual(await values("./a", f.root), ["./alpha/"]);
    assert.deepEqual(await values(`${f.root}/a`, f.root), [`${f.root}/alpha/`]);
    assert.deepEqual(await values("../a", join(f.root, "source dir")), ["../alpha/"]);
    assert.deepEqual(await values("source dir/", f.root), ["source dir/nested/"]);
    assert.deepEqual(await values("~", "/", f.root), ["~/alpha/", "~/source dir/"]);
    assert.deepEqual(await values("~/sou", "/", f.root), ["~/source dir/"]);
    assert.deepEqual(await values("~/source dir/", "/", f.root), ["~/source dir/nested/"]);
    assert.deepEqual(await values(".", f.root), [".hidden/"]);
    assert.deepEqual(await values("missing/", f.root), []);
    assert.deepEqual(await values("a-file/", f.root), []);
  } finally { f.cleanup(); }
});

test("directory completion follows directory symlinks, excludes files and unsafe terminal names", async () => {
  const f = temporary();
  try {
    mkdirSync(join(f.root, "folder"));
    mkdirSync(join(f.root, "unsafe\x1b[31m"));
    writeFileSync(join(f.root, "file"), "");
    symlinkSync(join(f.root, "folder"), join(f.root, "linked-dir"));
    symlinkSync(join(f.root, "file"), join(f.root, "linked-file"));
    symlinkSync(join(f.root, "missing"), join(f.root, "broken"));
    assert.deepEqual(await values("", f.root), ["folder/", "linked-dir/"]);
  } finally { f.cleanup(); }
});

const items = (names: string[]): SelectItem[] => names.map((value) => ({ value, label: value }));

test("directory input selects with arrows and ctrl+n/p, Tab fills, Enter submits the exact path", async () => {
  let renders = 0;
  const input = new DirectoryInput(() => { renders++; }, "/", async (value) =>
    value.includes("/") ? [] : items(["alpha/", "source dir/"]));
  await tick();
  input.handleInput("\x1b[B"); input.handleInput("\x10"); input.handleInput("\x0e");
  input.handleInput("\t");
  assert.equal(input.getValue(), "source dir/");
  input.handleInput("nested");
  assert.equal(input.getValue(), "source dir/nested", "Typing continues after the slash");
  let submitted = "";
  input.onSubmit = (value) => { submitted = value; };
  input.handleInput("\r");
  assert.equal(submitted, "source dir/nested");
  assert.ok(renders > 0);
  await tick();
});

test("Enter does not silently select a completion and Escape dismisses the menu first", async () => {
  const input = new DirectoryInput(() => {}, "/", async () => items(["alpha/", "beta/"]));
  await tick();
  input.handleInput("a"); await tick();
  let submitted = "";
  input.onSubmit = (value) => { submitted = value; };
  input.handleInput("\r");
  assert.equal(submitted, "a");
  assert.equal(input.dismissSuggestions("\x1b"), true);
  assert.equal(input.dismissSuggestions("\x1b"), false);
  assert.equal(input.getValue(), "a");
  input.handleInput("\t"); await tick();
  assert.match(text(input), /alpha\//, "Tab reopens dismissed suggestions");
});

test("directory input ignores stale lookups, clears menus on edits and bounds its suggestion list", async () => {
  const pending: ((items: SelectItem[]) => void)[] = [];
  const input = new DirectoryInput(() => {}, "/", () => new Promise((resolve) => pending.push(resolve)));
  input.handleInput("a");
  pending[1]!(items(["a-new/"])); await tick();
  pending[0]!(items(["stale/"])); await tick();
  assert.match(text(input), /a-new/); assert.doesNotMatch(text(input), /stale/);
  input.handleInput("b");
  assert.doesNotMatch(text(input), /a-new/);
  input.handleInput("\x7f");
  pending[2]!(items(["ab-stale/"])); await tick();
  assert.doesNotMatch(text(input), /ab-stale/);
  pending[3]!(items(Array.from({ length: 20 }, (_, i) => `a-directory-${i}/`))); await tick();
  for (const width of [8, 24, 80]) {
    const lines = input.render(width);
    assert.ok(lines.length <= 7, "One input row, five suggestions and a scroll indicator");
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
  }
  input.handleInput("\x1b[A"); input.handleInput("\t");
  assert.equal(input.getValue(), "a-directory-19/", "Up wraps to the last suggestion");
  pending[4]!([]); await tick();
});

test("completion failures leave manual input usable", async () => {
  const input = new DirectoryInput(() => {}, "/", async () => { throw new Error("unreadable"); });
  await tick();
  input.handleInput("/manual/path"); await tick();
  assert.equal(input.getValue(), "/manual/path");
  assert.equal(input.render(80).length, 1);
});
