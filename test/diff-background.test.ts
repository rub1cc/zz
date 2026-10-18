import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { getCapabilities, setCapabilities, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { setDiffBackground, shadeDiffRow } from "../src/diff-background.js";
import { renderToolResponse } from "../src/tool-response.js";
import type { ToolActivity } from "../src/model.js";

function setup(t: TestContext) {
  const capabilities = getCapabilities();
  const noColor = process.env.NO_COLOR;
  delete process.env.NO_COLOR;
  setCapabilities({ ...capabilities, trueColor: true });
  setDiffBackground(undefined);
  t.after(() => {
    setDiffBackground(undefined);
    setCapabilities(capabilities);
    if (noColor === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = noColor;
  });
}

test("diff fills blend faintly into light and dark terminal backgrounds", (t) => {
  setup(t);
  for (const [base, added, removed] of [
    [{ r: 255, g: 255, b: 255 }, "229;244;234", "250;232;233"],
    [{ r: 0, g: 0, b: 0 }, "5;19;10", "25;8;9"],
  ] as const) {
    assert.equal(setDiffBackground(base), true);
    assert.equal(setDiffBackground({ ...base }), false, "Repeated terminal reports need no redraw");
    for (const [change, color] of [["added", added], ["removed", removed]] as const) {
      const row = shadeDiffRow("+1 code", 20, change);
      assert.ok(row.startsWith(`\x1b[48;2;${color}m`));
      assert.equal(visibleWidth(row), 20);
      assert.equal(stripTerminalSequences(row), "+1 code" + " ".repeat(13));
      assert.ok(row.endsWith("\x1b[0m"));
    }
  }
  setCapabilities({ ...getCapabilities(), trueColor: false });
  assert.match(shadeDiffRow("+1 code", 20, "added"), /\x1b\[48;5;\d+m/);
});

test("unknown terminal colors, no-color mode and context lines retain their existing styling", (t) => {
  setup(t);
  assert.doesNotMatch(shadeDiffRow("+1 code", 20, "added"), /\x1b\[48;/);
  setDiffBackground({ r: 255, g: 255, b: 255 });
  assert.doesNotMatch(shadeDiffRow(" 1 context", 20), /\x1b\[48;/);
  process.env.NO_COLOR = "1";
  assert.doesNotMatch(shadeDiffRow("+1 code", 20, "added"), /\x1b\[48;/);
  assert.equal(visibleWidth(shadeDiffRow("+1 code", 20, "added")), 7);
});

test("diff padding ends inverse word styling before filling the rest of the row", (t) => {
  setup(t);
  setDiffBackground({ r: 255, g: 255, b: 255 });
  const row = shadeDiffRow("\x1b[32m+1 \x1b[7mword", 15, "added");
  assert.ok(row.includes("\x1b[7mword\x1b[27m\x1b[48;2;229;244;234m"));
  assert.equal(visibleWidth(row), 15);
  assert.ok(row.endsWith("        \x1b[0m"));
});

test("only successful changed diff rows receive fills, including wrapped rows and narrow widths", (t) => {
  setup(t);
  setDiffBackground({ r: 255, g: 255, b: 255 });
  const diff = ' 1 context\n-2 const value = "' + "OLD".repeat(30) + '";\n+2 const value = "' + "NEW".repeat(30) + '";\n 3 after';
  const tool: ToolActivity = { id: "diff", name: "edit", status: "done", arguments: { path: "file.ts" }, output: "", details: { result: { diff } } };
  for (const expanded of [false, true]) {
    for (const width of [1, 2, 4, 8, 24, 80, 200]) {
      const rows = renderToolResponse(tool, width, expanded, false);
      const shaded = rows.filter((row) => row.includes("\x1b[48;"));
      assert.ok(shaded.length >= 2);
      assert.ok(rows.every((row) => visibleWidth(row) <= width));
      assert.ok(shaded.every((row) => visibleWidth(row) === width && row.endsWith("\x1b[0m")));
      assert.ok(shaded.every((row) => width <= 4 || row.startsWith("    \x1b[48;")), "Transcript indent stays unpainted");
      assert.ok(rows.slice(0, 2).every((row) => !row.includes("\x1b[48;")));
    }
    const wide = renderToolResponse(tool, 200, expanded, false);
    assert.ok(wide.filter((row) => /context|after/.test(stripTerminalSequences(row))).every((row) => !row.includes("\x1b[48;")));
    if (expanded) {
      const args = wide.findIndex((row) => stripTerminalSequences(row).trim() === "Arguments");
      assert.ok(wide.slice(args).every((row) => !row.includes("\x1b[48;")), "Raw sections keep the terminal background");
    }
  }
  for (const status of ["pending", "running", "error", "interrupted"] as const) {
    assert.ok(renderToolResponse({ ...tool, status }, 80, false, false).every((row) => !row.includes("\x1b[48;")));
  }
  assert.ok(renderToolResponse({ ...tool, name: "write", arguments: { content: "new content" } }, 80, false, false)
    .every((row) => !row.includes("\x1b[48;")));
});
