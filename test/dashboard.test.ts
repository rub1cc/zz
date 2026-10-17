import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { CompactionResult as DurableCompactionResult, TaskId } from "@earendil-works/pi-durable";
import { stripTerminalSequences, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { Controller } from "../src/controller.js";
import { Composer } from "../src/composer.js";
import { rows, rowId, type CompactResult } from "../src/model.js";
import { Store } from "../src/store.js";
import { Dashboard, scrollToEndIndicator } from "../src/ui.js";
import { UndoDialog } from "../src/undo-dialog.js";
import { QuestionComposer } from "../src/question-composer.js";
import { pendingQuestion } from "../src/questions.js";
import { waitingSession } from "./question-fixtures.js";
import { FakeEngine, FakeTerminal, temporary, tick } from "./helpers.js";

function setup(writeClipboard?: (text: string) => Promise<void>) {
  const temp = temporary();
  const a = join(temp.root, "alpha"); const b = join(temp.root, "beta");
  mkdirSync(a); mkdirSync(b);
  const store = new Store(join(temp.root, "data"));
  const pa = store.addProject(a); const pb = store.addProject(b);
  const engine = new FakeEngine();
  const c = new Controller(store, engine, undefined, writeClipboard);
  const terminal = new FakeTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { scrollToEndIndicator });
  const app = new Dashboard(c, tui, () => {});
  tui.setLayoutRoot(app); tui.setFocus(app); tui.start(); app.sync(); tui.renderNow();
  return { ...temp, store, pa, pb, engine, c, terminal, tui, app,
    async cleanup() { await c.close(); tui.stop(); temp.cleanup(); } };
}

function assertFullyHighlighted(line: string, width: number): void {
  assert.equal(visibleWidth(line), width);
  let highlighted = false;
  assert.ok(!line.includes("\x1b[7m"), "Selection must not use inverse video");
  assert.ok(line.includes("\x1b[38;5;236m"), "Selection must use readable dark text");
  for (const match of line.matchAll(/\x1b\[([\d;]*)m|([^\x1b]+)/g)) {
    if (match[1] !== undefined) {
      if (match[1] === "0" || match[1] === "49") highlighted = false;
      else if (match[1] === "48;5;254") highlighted = true;
    } else {
      assert.ok(highlighted, `Unhighlighted text: ${JSON.stringify(match[2])}`);
    }
  }
  assert.equal(highlighted, false, "Highlight must not leak into the next row");
  assert.ok(line.endsWith("\x1b[39m\x1b[49m"), "Selection must restore default colors");
}

test("dashboard uses terminal edges for headers, composer and footer in every view", async () => {
  const f = setup();
  try {
    f.c.send("Edge-to-edge layout"); await tick();
    const session = f.store.state.sessions[0]!;
    for (const mode of ["sessions", "projects", "session"] as const) {
      f.c.mode = mode;
      f.c.openedSessionId = mode === "session" ? session.id : undefined;
      f.c.changed();
      for (const width of [12, 24, 80, 120]) {
        for (const height of [12, 24, 32]) {
          f.terminal.columns = width; f.terminal.rows = height;
          f.terminal.onResize(); f.tui.renderNow();
          const lines = f.tui.getScreenLines().map(stripTerminalSequences);
          assert.equal(lines.length, height);
          assert.ok(lines.every((line) => visibleWidth(line) <= width));
          const heading = mode === "projects" ? "Projects" : mode === "session" ? session.title : "0 awaiting";
          assert.ok(lines[0]!.startsWith(heading.slice(0, 8)), `${mode} ${width}x${height}: ${JSON.stringify(lines[0])}`);
          assert.ok(lines.at(-1)!.startsWith(mode === "projects" ? "Ctrl+x" : "test/mock"), `${mode} ${width}x${height}: ${JSON.stringify(lines.at(-1))}`);
          const border = mode === "projects" ? "-".repeat(width)
            : stripTerminalSequences(f.app.composer.render(width)[0]!);
          assert.equal(visibleWidth(border), width);
          assert.ok(lines.includes(border), "Divider must span the full terminal width");
        }
      }
    }
  } finally { await f.cleanup(); }
});

test("session titles stay complete and selected rows stay highlighted through wrapping and preview truncation", async () => {
  const f = setup();
  try {
    f.c.send("task"); await tick();
    const session = f.store.state.sessions[0]!;
    f.c.select(`session:${session.id}`);
    for (const width of [18, 40, 80, 120, 200]) {
      for (const title of ["short title", "a long title that exceeds the title column", "unbroken".repeat(20), "界面 😀 ".repeat(12)]) {
        for (const preview of ["Done", "a long preview ".repeat(30)]) {
          session.title = title; session.preview = preview;
          const lines = f.app.body.render(width);
          const start = f.app.body.positions.get(`session:${session.id}`)!;
          const end = [...f.app.body.positions.values()].find((position) => position > start) ?? lines.length;
          const titleLines = lines.slice(start, end);
          for (const line of titleLines) assertFullyHighlighted(line, width);
          assert.match(titleLines[0]!, /\x1b\[32m/, "Status color must be preserved");
          const text = titleLines.map((line) => stripTerminalSequences(line).slice(4)).join("").replace(/\s/g, "");
          assert.ok(text.startsWith(title.replace(/\s/g, "")), "The entire title must be visible without ellipsis");
          assert.ok([...lines.slice(0, start), ...lines.slice(end)].every((line) => !line.includes("\x1b[48;5;254m")));
        }
      }
    }
  } finally { await f.cleanup(); }
});

test("session title columns align within each project using terminal cell widths and update after renames", async () => {
  const f = setup();
  try {
    const titles = ["short", "a much longer title", "\u754c\u9762 \ud83d\ude00 ".repeat(4)];
    for (const title of titles) { f.c.select(`project:${f.pa.id}`); f.c.send(title); await tick(); }
    for (const title of ["one", "two"]) { f.c.select(`project:${f.pb.id}`); f.c.send(title); await tick(); }
    const sessions = f.store.state.sessions;
    const alpha = sessions.filter((s) => s.projectId === f.pa.id);
    const beta = sessions.filter((s) => s.projectId === f.pb.id);
    for (const session of sessions) session.preview = "latest message ".repeat(30);
    const check = (width: number) => {
      const lines = f.app.body.render(width);
      const stateColumn = (session: typeof sessions[number]) => {
        const line = lines[f.app.body.positions.get(`session:${session.id}`)!]!;
        const text = stripTerminalSequences(line);
        assert.match(text, /Done \u00b7 latest message/);
        assert.match(text, /  now\s*$/);
        assert.ok(visibleWidth(line) <= width);
        return visibleWidth(text.slice(0, text.indexOf("Done \u00b7")));
      };
      const alphaColumn = 6 + Math.max(...alpha.map((s) => visibleWidth(s.title)));
      for (const session of alpha) assert.equal(stateColumn(session), alphaColumn);
      for (const session of beta) assert.equal(stateColumn(session), 9, "Other projects use their own longest title");
    };
    for (const width of [100, 180]) check(width);
    alpha[2]!.title = "renamed";
    check(100);
    alpha[0]!.title = "An even longer title after renaming the shortest session";
    check(100);
  } finally { await f.cleanup(); }
});

test("session rows show a readable state followed by a middot and the latest preview", async () => {
  const f = setup();
  try {
    f.c.send("task"); await tick();
    const session = f.store.state.sessions[0]!;
    session.preview = "Latest reply\ncontinued";
    for (const [status, label] of [["completed", "Done"], ["working", "Working"], ["needs-input", "Needs input"],
      ["failed", "Failed"], ["paused", "Paused"]] as const) {
      session.status = status;
      const lines = f.app.body.render(100);
      const line = lines[f.app.body.positions.get(`session:${session.id}`)!]!;
      assert.ok(stripTerminalSequences(line).includes(`${label} \u00b7 Latest reply continued`));
      assertFullyHighlighted(line, 100);
    }
    f.c.pendingDelete = `session:${session.id}`;
    const lines = f.app.body.render(100);
    assert.match(stripTerminalSequences(lines[f.app.body.positions.get(`session:${session.id}`)!]!), /Paused \u00b7 ctrl\+x again to delete/);
  } finally { await f.cleanup(); }
});

test("wrapped unselected titles keep following row positions and continuation-line mouse targets", async () => {
  const f = setup();
  try {
    f.c.select(`project:${f.pa.id}`); f.c.send("task"); await tick();
    const session = f.store.state.sessions[0]!;
    session.title = "Show the complete session title even when it needs several terminal lines";
    f.c.select(`project:${f.pa.id}`);
    const width = 24;
    const lines = f.app.body.render(width);
    const start = f.app.body.positions.get(`session:${session.id}`)!;
    const nextProject = f.app.body.positions.get(`project:${f.pb.id}`)!;
    const titleLines = lines.slice(start, nextProject).filter((line) => line.trim());
    assert.ok(titleLines.length > 1);
    assert.ok(titleLines.every((line) => visibleWidth(line) <= width && !line.includes("\x1b[48;5;254m")));
    assert.equal(titleLines.map((line) => stripTerminalSequences(line).slice(4)).join("").replace(/\s/g, ""), session.title.replace(/\s/g, ""));
    assert.ok(lines[nextProject]!.includes("\x1b[1m"), "Following project position must point to its heading");
    const event = { type: "move" as const, button: "left" as const, x: 5, y: start + 1, screenX: 5, screenY: start + 1,
      width, height: 32, shift: false, ctrl: false, alt: false };
    assert.equal(f.app.body.handleMouse(event)?.handled, true);
    assert.equal(f.c.selection, `session:${session.id}`);
    f.app.body.render(width);
    f.app.body.handleMouse({ ...event, type: "click", clickCount: 2 });
    assert.equal(f.c.openedSessionId, session.id);
  } finally { await f.cleanup(); }
});

test("dashboard loops working icons, keeps completed dots static, and respects reduced motion", async (t) => {
  const oldMotion = process.env.ZZ_REDUCED_MOTION;
  const oldColor = process.env.NO_COLOR;
  t.after(() => {
    if (oldMotion === undefined) delete process.env.ZZ_REDUCED_MOTION; else process.env.ZZ_REDUCED_MOTION = oldMotion;
    if (oldColor === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = oldColor;
  });
  delete process.env.ZZ_REDUCED_MOTION;
  delete process.env.NO_COLOR;
  const f = setup();
  try {
    f.c.send("task"); await tick();
    const session = f.store.state.sessions[0]!;
    let now = 0;
    t.mock.method(Date, "now", () => now);
    const line = (width = 120) => {
      const lines = f.app.body.render(width);
      return lines[f.app.body.positions.get(`session:${session.id}`)!]!;
    };
    session.status = "working";
    for (const [index, icon] of ["✽", "✻", "✢", "∙", "✢", "✻", "✽", "✽"].entries()) {
      now = index * 160;
      for (const width of [18, 40, 120]) {
        const rendered = line(width);
        assert.match(stripTerminalSequences(rendered), new RegExp(`^  ${icon} `));
        assertFullyHighlighted(rendered, width);
      }
    }
    for (const env of ["ZZ_REDUCED_MOTION", "NO_COLOR"]) {
      process.env[env] = "1";
      for (now of [0, 160, 480, 1120]) assert.match(stripTerminalSequences(line()), /^  ✽ /);
      delete process.env[env];
    }
    for (const [status, icon] of [["completed", "∙"], ["needs-input", "?"], ["failed", "!"], ["paused", "-"]] as const) {
      session.status = status;
      for (now of [0, 160, 320]) assert.equal(stripTerminalSequences(line()).slice(2, 3), icon);
    }
  } finally { await f.cleanup(); }
});

test("selected project headings stay highlighted when clipped", async () => {
  const f = setup();
  try {
    f.c.select(`project:${f.pa.id}`);
    for (const width of [8, 24, 120]) {
      const lines = f.app.body.render(width);
      assertFullyHighlighted(lines[f.app.body.positions.get(`project:${f.pa.id}`)!]!, width);
    }
  } finally { await f.cleanup(); }
});

test("new tasks follow the selected project header or session, never the launch cwd", async () => {
  const f = setup();
  try {
    f.c.select(`project:${f.pa.id}`); assert.equal(f.c.send("task one"), true); await tick();
    assert.equal(f.engine.calls[0]?.project.path, f.pa.path);
    f.c.select(`session:${f.store.state.sessions[0]!.id}`); f.c.send("task two"); await tick();
    assert.equal(f.engine.calls[1]?.project.path, f.pa.path);
    f.c.select(`project:${f.pb.id}`); f.c.send("task three"); await tick();
    assert.equal(f.engine.calls[2]?.project.path, f.pb.path);
    assert.equal(f.store.state.sessions.length, 3);
  } finally { await f.cleanup(); }
});

test("empty composer space peeks and replies to the same session; enter opens", async () => {
  const f = setup();
  try {
    f.c.send("first task"); await tick();
    const id = f.store.state.sessions[0]!.id;
    f.terminal.onInput(" "); assert.equal(f.c.dialog?.kind, "peek");
    f.terminal.onInput("follow up"); f.terminal.onInput("\r"); await tick();
    assert.equal(f.engine.calls.at(-1)?.session.id, id);
    assert.equal(f.store.state.sessions.length, 1);
    assert.equal(f.c.dialog, undefined);
    f.terminal.onInput("\r"); assert.equal(f.c.mode, "session");
    f.terminal.onInput("\x1b[D"); assert.equal(f.c.mode, "sessions");
    f.terminal.onInput("new task ");
    assert.equal(f.c.dialog, undefined); assert.equal(f.app.composer.getValue(), "new task ");
    f.terminal.onInput("\r"); await tick(); assert.equal(f.store.state.sessions.length, 2);
  } finally { await f.cleanup(); }
});

test("Escape triggers /stop once, preserves drafts, and Left requires an empty composer", async () => {
  const f = setup();
  try {
    f.c.send("running task"); await tick(); f.c.open();
    const session = f.c.opened!;
    session.status = "working";
    f.app.composer.setValue("keep this draft");
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    f.engine.cancel = async (id) => { f.engine.cancelled.push(id); await pending; };
    f.terminal.onInput("\x1b");
    assert.deepEqual(f.engine.cancelled, [session.id]);
    assert.equal(session.status, "working");
    assert.equal(f.app.composer.getValue(), "keep this draft");
    assert.equal(f.app.composer.onSubmit?.("/stop"), "command");
    assert.equal(f.c.mode, "session"); assert.equal(f.c.notice, "Stopping...");
    f.terminal.onInput("\x1b");
    assert.deepEqual(f.engine.cancelled, [session.id]);
    assert.equal(f.c.mode, "session");
    assert.equal(f.c.send("wait for cancellation"), false);
    finish(); await tick();
    assert.equal(f.c.mode, "session"); assert.equal(session.status, "paused");
    assert.equal(session.stopped, true); assert.equal(f.store.state.sessions.length, 1);
    assert.equal(f.app.composer.getValue(), "keep this draft");
    assert.equal(f.engine.stopped.length, 0);
    f.terminal.onInput("\x1b"); assert.equal(f.c.mode, "session");
    f.terminal.onInput("\x1b[D"); assert.equal(f.c.mode, "session");
    f.app.composer.setValue(""); f.terminal.onInput("\x1b[D"); assert.equal(f.c.mode, "sessions");
  } finally { await f.cleanup(); }
});

test("Escape dismisses session suggestions and dialogs before stopping work", async () => {
  const f = setup();
  try {
    f.c.send("running task"); await tick(); f.c.open();
    const session = f.c.opened!; session.status = "working";
    f.terminal.onInput("/he"); await delay(20);
    assert.equal(f.app.composer.showingSuggestions, true);
    f.terminal.onInput("\x1b");
    assert.equal(f.app.composer.showingSuggestions, false);
    assert.equal(f.app.composer.getValue(), "/he");
    assert.deepEqual(f.engine.cancelled, []);
    assert.equal(f.app.composer.onSubmit?.("/help"), "command");
    assert.equal(f.c.dialog?.kind, "help");
    f.terminal.onInput("\x1b");
    assert.equal(f.c.dialog, undefined);
    assert.deepEqual(f.engine.cancelled, []);
    assert.equal(session.status, "working");
    f.terminal.onInput("\x1b"); await tick();
    assert.deepEqual(f.engine.cancelled, [session.id]);
    assert.equal(f.app.composer.getValue(), "/he");
    assert.equal(f.c.mode, "session");
  } finally { await f.cleanup(); }
});

for (const [key, data] of [["Left", "\x1b[D"], ["Ctrl+H", "\x08"], ["Kitty Ctrl+H", "\x1b[104;5u"]] as const) {
  test(`${key} with an empty composer returns to the dashboard without stopping active work`, async () => {
    const f = setup();
    try {
      f.c.send("working task"); await tick(); f.c.open();
      const session = f.c.opened!; session.status = "working";
      f.terminal.onInput(data);
      assert.equal(f.c.mode, "sessions"); assert.equal(session.status, "working");
      assert.equal(f.c.selection, `session:${session.id}`);
      assert.equal(f.engine.cancelled.length, 0);
      assert.equal(f.engine.stopped.length, 0);
    } finally { await f.cleanup(); }
  });
}

test("Ctrl+H with a draft keeps editing instead of leaving the session", async () => {
  const f = setup();
  try {
    f.c.send("task"); await tick(); f.c.open();
    f.app.composer.setValue("draft");
    f.terminal.onInput("\x08");
    assert.equal(f.c.mode, "session");
    assert.equal(f.app.composer.getValue(), "draf");
  } finally { await f.cleanup(); }
});

test("/stop cancels the selected task without starting a new session or deleting it", async () => {
  const f = setup();
  try {
    f.c.send("running task"); await tick();
    const session = f.store.state.sessions[0]!; session.status = "working";
    assert.equal(f.app.composer.onSubmit?.("/stop"), "command"); await tick();
    assert.deepEqual(f.engine.cancelled, [session.id]);
    assert.equal(f.store.state.sessions.length, 1); assert.equal(f.engine.calls.length, 1);
    assert.equal(session.status, "paused");
  } finally { await f.cleanup(); }
});

test("multiline task and reply composers use Ctrl+J for newlines and Enter to send", async () => {
  const f = setup();
  try {
    f.terminal.onInput("\x0a");
    assert.equal(f.app.composer.getValue(), "\n");
    assert.equal(f.c.mode, "sessions");
    f.app.composer.setValue("first line");
    f.terminal.onInput("\x0a"); f.terminal.onInput("second line");
    assert.equal(f.store.state.sessions.length, 0);
    const selection = f.c.selection;
    f.terminal.onInput("\x1b[A");
    assert.equal(f.c.selection, selection); // Arrows edit a multiline draft, not project selection.
    assert.equal(f.app.composer.getValue(), "first line\nsecond line");
    for (const width of [10, 24, 120]) assert.ok(f.app.render(width).every((line) => visibleWidth(line) <= width));
    f.terminal.onInput("\r"); await tick();
    assert.equal(f.engine.calls.at(-1)?.prompt, "first line\nsecond line");
    assert.equal(f.app.composer.getValue(), "");
    f.c.open();
    f.terminal.onInput("\x0a");
    assert.equal(f.app.composer.getValue(), "\n");
    assert.equal(f.c.mode, "session");
    f.app.composer.setValue("");
    f.terminal.onInput("reply one"); f.terminal.onInput("\x0a"); f.terminal.onInput("reply two");
    f.c.opened!.status = "working";
    f.terminal.onInput("\r");
    assert.equal(f.app.composer.getValue(), "");
    assert.equal(f.c.notice, "");
    await tick();
    assert.equal(f.engine.calls.at(-1)?.prompt, "reply one\nreply two");
    assert.equal(f.store.state.sessions.length, 1);
  } finally { await f.cleanup(); }
});

test("Ctrl+G reaches the editor in the dashboard and peek; peek supports multiline replies", async (t) => {
  const f = setup();
  const editors: Composer[] = [];
  t.mock.method(Composer.prototype, "openEditor", async function(this: Composer) {
    editors.push(this); this.setValue(`${this.getValue()}\nedited`);
  });
  try {
    f.terminal.onInput("task"); f.terminal.onInput("\x07"); await tick();
    assert.equal(f.app.composer.getValue(), "task\nedited");
    assert.equal(f.store.state.sessions.length, 0);
    assert.equal(editors[0], f.app.composer);
    f.terminal.onInput("\r"); await tick();
    f.terminal.onInput(" ");
    assert.equal(f.c.dialog?.kind, "peek");
    f.terminal.onInput("peek reply"); f.terminal.onInput("\x0a"); f.terminal.onInput("second line");
    f.terminal.onInput("\x07"); await tick();
    assert.equal(editors.length, 2);
    assert.equal(editors[1]?.getValue(), "peek reply\nsecond line\nedited");
    assert.equal(f.engine.calls.length, 1);
    f.terminal.onInput("\r"); await tick();
    assert.equal(f.engine.calls.at(-1)?.prompt, "peek reply\nsecond line\nedited");
    assert.equal(f.store.state.sessions.length, 1);
    assert.equal(f.c.dialog, undefined);
  } finally { await f.cleanup(); }
});

test("ctrl+n and ctrl+p navigate sessions and projects without changing the composer", async () => {
  const f = setup();
  try {
    f.c.select(`project:${f.pa.id}`); f.c.send("first task"); await tick();
    f.c.select(`project:${f.pa.id}`);
    const sessionId = f.store.state.sessions[0]!.id;
    f.terminal.onInput("draft task");
    f.terminal.onInput("\x0e"); assert.equal(f.c.selection, `session:${sessionId}`);
    f.terminal.onInput("\x0e"); assert.equal(f.c.project?.id, f.pb.id);
    f.terminal.onInput("\x0e"); assert.equal(f.c.project?.id, f.pb.id);
    f.terminal.onInput("\x10"); assert.equal(f.c.selection, `session:${sessionId}`);
    f.terminal.onInput("\x10"); assert.equal(f.c.selection, `project:${f.pa.id}`);
    f.terminal.onInput("\x10"); assert.equal(f.c.selection, `project:${f.pa.id}`);
    assert.equal(f.app.composer.getValue(), "draft task");
    f.app.composer.onSubmit?.("/projects"); assert.equal(f.c.mode, "projects");
    f.terminal.onInput("\x0e"); assert.equal(f.c.project?.id, f.pb.id);
    f.terminal.onInput("\x10"); assert.equal(f.c.project?.id, f.pa.id);
    assert.equal(f.app.composer.getValue(), "draft task");
  } finally { await f.cleanup(); }
});

test("model/thinking pickers change new-session defaults or just the open session", async () => {
  const f = setup();
  const dialogKind = () => f.c.dialog?.kind;
  try {
    f.terminal.onInput("/model"); f.terminal.onInput("\r"); await tick();
    assert.equal(dialogKind(), "model"); assert.equal(f.store.state.sessions.length, 0);
    for (const width of [24, 50, 120]) {
      f.terminal.columns = width; f.terminal.onResize(); f.tui.renderNow();
      assert.ok(f.tui.getScreenLines().every((line) => visibleWidth(line) <= width));
    }
    f.terminal.onInput("reasoner"); f.terminal.onInput("\r"); await tick();
    assert.equal(f.c.configuration.model?.modelId, "reasoner");
    assert.equal(f.c.dialog, undefined);
    f.c.send("use configured model"); await tick();
    f.c.open(); f.tui.renderNow();
    f.terminal.onInput("/thinking"); f.terminal.onInput("\r"); await tick();
    assert.equal(dialogKind(), "thinking");
    f.terminal.onInput("\x10"); f.terminal.onInput("\r"); await tick(); // wrap off -> high
    assert.equal(f.c.opened?.agent?.thinkingLevel, "high");
    assert.equal(f.engine.configuration().thinkingLevel, "off");
    f.terminal.onInput("draft reply");
    assert.equal(f.app.composer.onSubmit?.("/model"), "command"); await tick();
    f.terminal.onInput("mock"); f.terminal.onInput("\r"); await tick();
    assert.equal(f.c.opened?.agent?.model?.modelId, "mock");
    assert.equal(f.engine.configuration().model?.modelId, "reasoner");
    assert.equal(f.app.composer.getValue(), "draft reply");
    f.c.opened!.status = "working";
    assert.equal(await f.c.configure({ model: { provider: "test", modelId: "reasoner" } }, f.c.opened!.id), false);
    assert.match(f.c.notice, /finish/);
  } finally { await f.cleanup(); }
});

test("removed model/thinking shortcuts do not change settings or consume drafts", async () => {
  const f = setup();
  try {
    await f.c.configure({ model: { provider: "test", modelId: "reasoner" } });
    f.c.send("start"); await tick();
    for (const mode of ["sessions", "projects", "session"] as const) {
      f.c.mode = mode;
      f.c.openedSessionId = mode === "session" ? f.store.state.sessions[0]!.id : undefined;
      if (f.c.opened) f.c.opened.status = "working";
      f.c.changed();
      f.app.composer.setValue("keep this draft");
      const configuration = structuredClone(f.c.configuration);
      for (const key of ["\x0c", "\x14", "\x1b[Z"]) {
        f.terminal.onInput(key); await tick();
        assert.deepEqual(f.c.configuration, configuration);
        assert.equal(f.app.composer.getValue(), "keep this draft");
        assert.equal(f.c.dialog, undefined);
      }
    }
  } finally { await f.cleanup(); }
});

test("skills picker fills an explicit skill command without creating a session", async () => {
  const f = setup();
  try {
    f.terminal.onInput("/skills"); f.terminal.onInput("\r"); await tick();
    assert.equal(f.c.dialog?.kind, "skills");
    f.terminal.onInput("test"); f.terminal.onInput("\r"); await tick();
    assert.equal(f.app.composer.getValue(), "$testing ");
    assert.equal(f.store.state.sessions.length, 0);
    f.terminal.onInput("check these tests"); f.terminal.onInput("\r"); await tick();
    assert.equal(f.engine.calls.at(-1)?.prompt, "$testing check these tests");
    assert.equal(f.engine.calls.at(-1)?.project.id, f.pb.id);
  } finally { await f.cleanup(); }
});

test("chat follows output only at the end and offers click and /bottom instead of Ctrl+End", async () => {
  const f = setup();
  try {
    f.c.send("long conversation"); await tick();
    const session = f.store.state.sessions[0]!;
    session.messages = [{ role: "assistant", timestamp: 1, text: Array.from({ length: 90 }, (_, i) => `Paragraph ${i}`).join("\n\n") }];
    f.c.open(); f.tui.renderNow();
    assert.equal(f.app.scroll.isFollowingEnd, true);
    const initial = f.app.scroll.scrollTop;
    assert.ok(initial > 0);
    session.messages[0]!.text += "\n\nNewest reply"; f.c.changed(); f.tui.renderNow();
    assert.ok(f.app.scroll.scrollTop > initial);
    f.terminal.onInput("\x1b[5~"); f.tui.renderNow();
    assert.equal(f.app.scroll.isFollowingEnd, false);
    const reading = f.app.scroll.scrollTop;
    session.messages[0]!.text += "\n\nMore streaming text"; f.c.changed(); f.tui.renderNow();
    assert.equal(f.app.scroll.scrollTop, reading);
    const screen = f.tui.getScreenLines().map(stripTerminalSequences);
    const row = screen.findIndex((line) => line.includes("[ Scroll to bottom"));
    assert.ok(row >= 0);
    const column = screen[row]!.indexOf("[ Scroll to bottom") + 3;
    f.terminal.onInput(`\x1b[<0;${column + 1};${row + 1}M`);
    f.terminal.onInput(`\x1b[<0;${column + 1};${row + 1}m`); f.tui.renderNow();
    assert.equal(f.app.scroll.isFollowingEnd, true);
    assert.doesNotMatch(f.tui.getScreenLines().map(stripTerminalSequences).join("\n"), /Scroll to bottom/);
    f.terminal.onInput("\x1b[<64;4;6M"); f.tui.renderNow();
    assert.equal(f.app.scroll.isFollowingEnd, false);
    const beforeRemovedShortcut = f.app.scroll.scrollTop;
    for (const key of ["\x1b[1;5F", "\x1b[70;5u"]) {
      f.terminal.onInput(key); f.tui.renderNow();
      assert.equal(f.app.scroll.scrollTop, beforeRemovedShortcut);
      assert.equal(f.app.scroll.isFollowingEnd, false);
    }
    f.app.composer.setValue("/bottom"); f.terminal.onInput("\r"); f.tui.renderNow();
    assert.equal(f.app.scroll.isFollowingEnd, true);
    f.terminal.rows = 24; f.terminal.onResize(); f.tui.renderNow();
    const resized = f.app.scroll.scrollTop;
    session.messages.push({ role: "assistant", timestamp: 2, text: "Another message\n\nFollow this too" });
    f.c.changed(); f.tui.renderNow(); assert.ok(f.app.scroll.scrollTop > resized);
    const beforeDraftGrowth = f.app.scroll.scrollTop;
    f.app.composer.setValue("A multiline draft\nwith more lines\nand another line"); f.tui.renderNow();
    assert.equal(f.app.scroll.isFollowingEnd, true);
    assert.ok(f.app.scroll.scrollTop >= beforeDraftGrowth);
    f.app.composer.setValue(""); f.tui.renderNow();
    f.terminal.onInput("\x1b[5~"); f.tui.renderNow();
    f.terminal.onInput("/bottom"); f.terminal.onInput("\r"); f.tui.renderNow();
    assert.equal(f.app.scroll.isFollowingEnd, true);
    f.terminal.onInput("\x1b[D"); f.tui.renderNow();
    assert.equal(f.app.scroll.followEnd, false);
    assert.doesNotMatch(f.tui.getScreenLines().map(stripTerminalSequences).join("\n"), /Scroll to bottom/);
  } finally { await f.cleanup(); }
});

test("transcript uses prompt and response markers, literal user text, and Markdown assistant text", async () => {
  const f = setup();
  try {
    f.c.send("inspect project"); await tick(); f.c.open();
    const session = f.c.opened!;
    session.messages = [
      { role: "user", text: "Please inspect **this project**\n\n日本語 🧑‍💻", timestamp: 1 },
      { role: "assistant", text: "Here is the **summary**.", timestamp: 2 },
      { role: "error", text: "Something failed", timestamp: 3 },
    ];
    const transcript = f.app.body.transcript;
    for (const width of [1, 4, 10, 24, 50, 120]) {
      const lines = transcript.render(width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      const background = "\x1b[48;2;238;238;238m";
      const userLines = lines.filter((line) => line.includes(background));
      assert.ok(userLines.length > 0);
      for (const line of userLines) {
        assert.ok(line.startsWith(`${background}\x1b[38;2;32;32;32m`));
        assert.ok(line.endsWith("\x1b[39m\x1b[49m"), "User styling must not leak into later rows");
        assert.equal(visibleWidth(line), width, "Background covers wrapped and blank rows to the terminal edge");
      }
      const lastUser = lines.findLastIndex((line) => line.includes(background));
      assert.ok(lines.slice(lastUser + 1).every((line) => !line.includes("\x1b[48;")), "Assistant/error rows keep the terminal background");
      if (width < 50) continue;
      const text = lines.map(stripTerminalSequences).join("\n");
      assert.match(text, /^❯ Please inspect \*\*this project\*\*/);
      assert.match(text, /● Here is the summary\./);
      assert.match(text, /● Error\n  ⎿ Something failed/);
      assert.doesNotMatch(text, /^\s*(You|Agent)\s*$/m);
    }
    session.messages[1]!.text += " More detail.";
    assert.match(transcript.render(120).map(stripTerminalSequences).join("\n"), /More detail\./);
    session.messages[0]!.role = "assistant";
    assert.ok(transcript.render(120).every((line) => !stripTerminalSequences(line).startsWith("❯") && !line.includes("\x1b[48;")));
  } finally { await f.cleanup(); }
});

test("tool previews are compact, keyboard and mouse expandable, and stable across updates", async () => {
  const f = setup();
  try {
    f.c.send("inspect project"); await tick(); f.c.open();
    const session = f.c.opened!;
    session.messages.push({ role: "tool", text: "", timestamp: Date.now(), tool: {
      id: "read-skill", name: "read", arguments: { path: "/skills/frontend-design/SKILL.md" },
      output: "skill instructions that should stay hidden", status: "running",
    } }, { role: "tool", text: "", timestamp: Date.now(), tool: {
      id: "run-tests", name: "bash", arguments: { command: "npm test" }, output: "Tests passed\n14 tests", status: "done", durationMs: 1100,
    } });
    const render = () => f.app.body.render(f.terminal.columns).map(stripTerminalSequences).join("\n");
    assert.match(render(), /● Skill frontend-design/);
    assert.match(render(), /Ran 1 shell command/);
    assert.doesNotMatch(render(), /skill instructions|Arguments|Tests passed|npm test/);
    f.terminal.onInput("\t"); f.terminal.onInput(" ");
    assert.match(render(), /skill instructions that should stay hidden/);
    // Durable replaces projected message objects on each update; the call ID owns expansion.
    session.messages = JSON.parse(JSON.stringify(session.messages));
    session.messages.at(-2)!.tool!.status = "done";
    assert.match(render(), /skill instructions that should stay hidden/);
    const transcript = f.app.body.transcript;
    const y = transcript.positions.get("run-tests")!;
    transcript.handleMouse({ type: "click", button: "left", x: 5, y, screenX: 5, screenY: y, width: 120, height: 32, shift: false, ctrl: false, alt: false });
    assert.match(render(), /Tests passed/);
    f.terminal.onInput("/collapse"); f.terminal.onInput("\r");
    assert.doesNotMatch(render(), /skill instructions|Arguments|Tests passed|npm test/);
    assert.match(render(), /Ran 1 shell command/);
    f.terminal.onInput("/expand"); f.terminal.onInput("\r");
    assert.match(render(), /Tests passed/);
    for (const width of [10, 24, 50, 120]) assert.ok(f.app.body.render(width).every((line) => visibleWidth(line) <= width));
    assert.equal(session.messages.filter((m) => m.role === "user").length, 1);
  } finally { await f.cleanup(); }
});

test("ctrl+x requires a second ctrl+x; any other key cancels without deleting files", async () => {
  const f = setup();
  try {
    writeFileSync(join(f.pb.path, "keep.txt"), "keep");
    f.c.send("delete me"); await tick();
    const id = f.store.state.sessions[0]!.id;
    const session = f.store.state.sessions[0]!;
    session.preview = "Preview replaced by delete confirmation";
    const preview = session.preview;
    f.terminal.onInput("\x18"); f.tui.renderNow();
    assert.equal(f.c.dialog, undefined);
    assert.equal(f.c.pendingDelete, `session:${id}`);
    const line = f.app.body.render(120).find((line) => line.includes("delete me"))!;
    assert.match(line, /\x1b\[31mctrl\+x again to delete/);
    assert.doesNotMatch(stripTerminalSequences(line), new RegExp(preview));
    assert.equal(session.preview, preview, "Confirmation must not overwrite the saved preview");
    assert.doesNotMatch(f.tui.getScreenLines().map(stripTerminalSequences).join("\n"), /Delete session\?|Any other key cancels/);
    f.terminal.onInput("x");
    assert.equal(f.c.pendingDelete, undefined); assert.equal(f.c.dialog, undefined); assert.equal(f.store.state.sessions.length, 1);
    assert.ok(f.app.body.render(120).some((line) => stripTerminalSequences(line).includes(preview)));
    f.terminal.onInput("\x18"); f.terminal.onInput("\x18"); await tick();
    assert.equal(f.store.state.sessions.length, 0); assert.deepEqual(f.engine.stopped, [id]);
    assert.equal(readFileSync(join(f.pb.path, "keep.txt"), "utf8"), "keep");
  } finally { await f.cleanup(); }
});

for (const position of [0, 1, 2]) {
  test(`deleting session ${position + 1} keeps the same row position, clamped at the end`, async () => {
    const f = setup();
    try {
      for (let i = 0; i < 3; i++) { f.c.send(`task ${i}`); await tick(); }
      const sessions = f.store.state.sessions;
      sessions.forEach((session, index) => { session.createdAt = index; });
      const before = f.c.currentRows;
      const target = before.filter((row) => row.kind === "session")[position]!;
      const index = before.findIndex((row) => rowId(row) === rowId(target));
      const remaining = before.filter((row) => rowId(row) !== rowId(target));
      const expected = rowId(remaining[Math.min(index, remaining.length - 1)]!);
      f.c.select(rowId(target));
      f.terminal.onInput("\x18"); f.terminal.onInput("\x18"); await tick();
      assert.equal(f.c.selection, expected);
      assert.equal(f.store.state.selectedProjectId, f.pb.id);
      assert.equal(new Store(f.store.root).state.selectedProjectId, f.pb.id);
      assert.equal(f.store.state.sessions.length, 2);
    } finally { await f.cleanup(); }
  });
}

test("deleting the final session falls back to its own project, not the first project", async () => {
  const f = setup();
  try {
    f.c.send("only task"); await tick();
    f.terminal.onInput("\x18"); f.terminal.onInput("\x18"); await tick();
    assert.equal(f.c.selection, `project:${f.pb.id}`);
    assert.equal(f.store.state.selectedProjectId, f.pb.id);
  } finally { await f.cleanup(); }
});

for (const target of ["session", "project"] as const) {
  test(`${target} deletion does not override navigation while stopping`, async () => {
    const f = setup();
    let finishStop!: () => void;
    try {
      f.c.send("delete me"); await tick();
      if (target === "project") f.c.select(`project:${f.pb.id}`);
      f.engine.stop = async () => new Promise<void>((resolve) => { finishStop = resolve; });
      f.c.requestDelete();
      const deleting = f.c.confirmDelete();
      f.c.select(`project:${f.pa.id}`);
      finishStop(); await deleting;
      assert.equal(f.c.selection, `project:${f.pa.id}`);
      assert.equal(f.store.state.selectedProjectId, f.pa.id);
      assert.equal(f.store.state.sessions.length, 0);
    } finally { finishStop?.(); await f.cleanup(); }
  });
}

test("failed session deletion retains the selected session", async () => {
  const f = setup();
  try {
    f.c.send("keep me"); await tick();
    const selection = f.c.selection;
    f.engine.stop = async () => { throw new Error("Stop failed"); };
    f.c.requestDelete(); await f.c.confirmDelete();
    assert.equal(f.c.selection, selection);
    assert.equal(f.store.state.sessions.length, 1);
    assert.match(f.c.notice, /Stop failed/);
  } finally { await f.cleanup(); }
});

test("inline delete confirmation belongs only to its row and stays bounded at narrow widths", async () => {
  const f = setup();
  try {
    f.c.send("first task"); await tick();
    const first = f.store.state.sessions[0]!;
    f.c.send("second task"); await tick();
    const second = f.store.state.sessions[1]!;
    f.c.select(`session:${first.id}`);
    f.terminal.onInput("\x18");
    first.preview = "A newer reply";
    f.c.changed();
    const lines = f.app.body.render(120);
    assert.equal(lines.filter((line) => line.includes("ctrl+x again to delete")).length, 1);
    assert.ok(lines.find((line) => line.includes("first task"))!.includes("ctrl+x again to delete"));
    assert.ok(!lines.find((line) => line.includes("second task"))!.includes("ctrl+x again to delete"));
    for (const width of [1, 4, 10, 24, 50, 120]) {
      const narrow = f.app.body.render(width);
      assert.ok(narrow.every((line) => visibleWidth(line) <= width));
      const text = narrow.map(stripTerminalSequences).join("").replace(/\s/g, "");
      assert.ok(text.includes("ctrl+xagaintodelete"));
    }
    f.c.select(`session:${second.id}`);
    assert.equal(f.c.pendingDelete, undefined);
    assert.ok(f.app.body.render(120).some((line) => stripTerminalSequences(line).includes("A newer reply")));
    f.terminal.onInput("\x18");
    assert.equal(f.c.pendingDelete, `session:${second.id}`);
    assert.equal(f.store.state.sessions.length, 2, "Changing selection must require a fresh confirmation");
    f.terminal.onInput("\x1b");
    assert.equal(f.c.pendingDelete, undefined);
    assert.equal(f.c.dialog, undefined);
    assert.equal(f.engine.stopped.length, 0);
  } finally { await f.cleanup(); }
});

for (const mode of ["sessions", "projects"] as const) {
  test(`ctrl+x on a project in ${mode} confirms inline and deletes only its sessions`, async () => {
    const f = setup();
    try {
      writeFileSync(join(f.pb.path, "keep.txt"), "keep");
      f.c.send("first task"); await tick();
      f.c.send("second task"); await tick();
      const targets = [...f.store.state.sessions];
      targets[0]!.status = "working";
      f.c.select(`project:${f.pa.id}`);
      f.c.send("other project task"); await tick();
      const other = f.store.state.sessions.at(-1)!;
      f.c.select(`project:${f.pb.id}`);
      if (mode === "projects") f.app.composer.onSubmit?.("/projects");
      assert.equal(f.c.mode, mode);
      const before = f.app.body.render(120);
      const header = before[f.app.body.positions.get(`project:${f.pb.id}`)!]!;
      f.terminal.onInput("\x18");
      assert.equal(f.c.pendingDelete, `project:${f.pb.id}`);
      assert.equal(f.c.dialog, undefined);
      const lines = f.app.body.render(120);
      assert.equal(lines[f.app.body.positions.get(`project:${f.pb.id}`)!], header,
        "The project header must stay unchanged while its sessions are marked");
      if (mode === "projects") assert.ok(lines.every((line) => !line.includes("ctrl+x again to delete")));
      if (mode === "sessions") {
        for (const session of targets) {
          assert.ok(lines.find((line) => line.includes(session.title))!.includes("\x1b[31mctrl+x again to delete"));
        }
        assert.ok(!lines.find((line) => line.includes(other.title))!.includes("ctrl+x again to delete"));
      }
      for (const width of [1, 4, 10, 24, 50, 120]) {
        assert.ok(f.app.body.render(width).every((line) => visibleWidth(line) <= width));
      }
      f.terminal.onInput("x");
      assert.equal(f.c.pendingDelete, undefined);
      assert.ok(f.app.body.render(120).every((line) => !line.includes("ctrl+x again to delete")));
      assert.equal(f.store.state.sessions.length, 3);
      assert.equal(f.engine.stopped.length, 0);
      f.terminal.onInput("\x18"); f.terminal.onInput("\x18"); await tick();
      assert.deepEqual(f.engine.stopped.sort(), targets.map((s) => s.id).sort());
      assert.deepEqual(f.store.state.sessions, [other]);
      assert.deepEqual(f.store.state.projects, [f.pa, f.pb]);
      assert.equal(readFileSync(join(f.pb.path, "keep.txt"), "utf8"), "keep");
      assert.equal(f.c.selection, `project:${f.pb.id}`);
      const cleared = f.app.body.render(120);
      const clearedHeader = cleared[f.app.body.positions.get(`project:${f.pb.id}`)!]!;
      assert.match(stripTerminalSequences(clearedHeader), /0 sessions/);
      assert.ok(!clearedHeader.includes("ctrl+x again to delete"));
      const restored = new Store(f.store.root);
      assert.deepEqual(restored.state.sessions.map((s) => s.id), [other.id]);
      assert.deepEqual(restored.state.projects, [f.pa, f.pb]);
      if (mode === "projects") f.terminal.onInput("\x1b");
      assert.equal(f.c.project?.path, f.pb.path);
      assert.equal(rows(f.store.state).filter((r) => r.kind === "session" && r.project.id === f.pb.id).length, 0);
      assert.equal(f.c.send("new task in the same project"), true); await tick();
      assert.equal(f.store.state.sessions.at(-1)!.projectId, f.pb.id);
    } finally { await f.cleanup(); }
  });
}

test("ctrl+x on an empty project is a no-op", async () => {
  const f = setup();
  try {
    f.c.select(`project:${f.pb.id}`);
    const before = f.app.body.render(120);
    f.terminal.onInput("\x18");
    assert.equal(f.c.pendingDelete, undefined);
    assert.deepEqual(f.app.body.render(120), before);
    f.terminal.onInput("\x18"); await tick();
    assert.deepEqual(f.store.state.projects, [f.pa, f.pb]);
    assert.equal(f.store.state.sessions.length, 0);
    assert.equal(f.engine.stopped.length, 0);
  } finally { await f.cleanup(); }
});

test("project deletion waits for all stops, prevents new work and retains the group on failure", async () => {
  const f = setup();
  let finishStop!: () => void;
  try {
    f.c.send("first task"); await tick();
    f.c.send("second task"); await tick();
    const targets = [...f.store.state.sessions];
    const stopped = new Promise<void>((resolve) => { finishStop = resolve; });
    f.engine.stop = async (id) => {
      f.engine.stopped.push(id);
      if (id === targets[0]!.id) throw new Error("Stop failed");
      await stopped;
    };
    f.c.select(`project:${f.pb.id}`);
    f.terminal.onInput("\x18"); f.terminal.onInput("\x18"); await tick();
    assert.equal(f.c.send("must not start"), false);
    assert.equal(f.engine.calls.length, 2);
    assert.equal(f.store.state.projects.length, 2);
    assert.equal(f.store.state.sessions.length, 2);
    f.terminal.onInput("\x18");
    assert.equal(f.c.pendingDelete, undefined, "Deletion cannot be armed again while stops are pending");
    finishStop(); await tick();
    assert.match(f.c.notice, /Stop failed/);
    assert.equal(f.store.state.projects.length, 2);
    assert.deepEqual(f.store.state.sessions, targets);
    assert.deepEqual(f.engine.stopped.sort(), targets.map((s) => s.id).sort());
    f.engine.stop = async () => {};
    f.terminal.onInput("\x18"); f.terminal.onInput("\x18"); await tick();
    assert.deepEqual(f.store.state.projects, [f.pa, f.pb]);
    assert.equal(f.c.selection, `project:${f.pb.id}`);
    assert.equal(f.store.state.sessions.length, 0);
  } finally { finishStop?.(); await f.cleanup(); }
});

test("renders bounded lines at narrow widths, with selection kept visible and dialogs usable", async () => {
  const f = setup();
  try {
    for (let i = 0; i < 50; i++) { f.c.send(`session ${i} 日本語 🧑‍💻`); await tick(); }
    for (const width of [12, 24, 40, 80, 140]) {
      f.terminal.columns = width; f.terminal.onResize(); f.tui.renderNow();
      assert.ok(f.tui.getScreenLines().every((line) => visibleWidth(line) <= width));
      assert.ok(f.app.render(width).every((line) => visibleWidth(line) <= width));
    }
    f.terminal.columns = 100; f.terminal.onResize(); f.tui.renderNow();
    f.c.select(rowId(f.c.currentRows[0]!));
    for (let i = 0; i < 45; i++) { f.terminal.onInput(i % 2 ? "\x0e" : "\x1b[B"); f.tui.renderNow(); }
    assert.ok(f.app.scroll.scrollTop > 0);
    f.terminal.onInput("\x18"); f.tui.renderNow();
    assert.match(f.tui.getScreenLines().map(stripTerminalSequences).join("\n"), /ctrl\+x again to delete/);
  } finally { await f.cleanup(); }
});

test("state persists, duplicate directories collapse, invalid state is not overwritten", () => {
  const temp = temporary();
  try {
    const store = new Store(temp.root); store.addProject(temp.root); store.addProject(join(temp.root, "."));
    assert.equal(new Store(temp.root).state.projects.length, 1);
    writeFileSync(store.file, '{"version":9}');
    assert.throws(() => new Store(temp.root), /Invalid zz state/);
    assert.equal(readFileSync(store.file, "utf8"), '{"version":9}');
  } finally { temp.cleanup(); }
});

test("session shows working status until completion and resets timing on the next reply", async () => {
  const f = setup();
  let complete!: () => void;
  f.engine.run = async (session) => {
    await new Promise<void>((resolve) => { complete = resolve; });
    session.status = "completed";
  };
  try {
    f.c.send("slow task"); f.c.open();
    const session = f.c.opened!;
    session.work!.startedAt = Date.now() - 3000;
    const render = () => f.app.body.render(120).map(stripTerminalSequences).join("\n");
    assert.match(render(), /[✽✻✢∙] Working/);
    for (const width of [1, 4, 10, 24, 50, 120]) {
      assert.ok(f.app.body.render(width).every((line) => visibleWidth(line) <= width));
    }
    complete(); await tick();
    assert.match(render(), /✻ Worked for 3s · done \d{1,2}:\d{2} [AP]M/);
    const finishedAt = session.work!.finishedAt;
    f.c.changed();
    assert.equal(session.work!.finishedAt, finishedAt);
    f.store.save();
    assert.deepEqual(new Store(f.store.root).state.sessions[0]!.work, session.work);
    f.c.send("follow up");
    assert.equal(session.work!.finishedAt, undefined);
    assert.ok(session.work!.startedAt >= finishedAt!);
    assert.match(render(), /[✽✻✢∙] Working/);
    assert.doesNotMatch(render(), /Worked for/);
    complete(); await tick();
  } finally { await f.cleanup(); }
});

test("composer menus own navigation keys, fill commands before dispatch and dismiss before leaving a session", async () => {
  const f = setup();
  try {
    f.terminal.onInput("/"); await tick();
    assert.equal(f.app.composer.showingSuggestions, true);
    const selected = f.c.selection;
    f.terminal.onInput("\x0e"); // Ctrl+N selects a command, not another project.
    assert.equal(f.c.selection, selected);
    f.terminal.onInput("\x10");
    f.terminal.onInput("\t");
    assert.equal(f.app.composer.getValue(), "/model ");
    assert.equal(f.c.dialog, undefined);
    f.terminal.onInput("\r"); await tick();
    assert.equal((f.c as Controller).dialog?.kind, "model");
    assert.equal(f.engine.calls.length, 0);
    f.terminal.onInput("\x1b");
    f.app.composer.setValue("task"); f.terminal.onInput("\r"); await tick(); f.c.open();
    f.terminal.onInput("/"); await tick();
    const menu = f.app.composer.render(120).map(stripTerminalSequences).join("\n");
    assert.match(menu, /model/);
    f.terminal.onInput("\x1b");
    assert.equal(f.c.mode, "session");
    assert.equal(f.app.composer.getValue(), "/");
    assert.equal(f.app.composer.showingSuggestions, false);
    f.terminal.onInput("\x1b");
    assert.equal(f.c.mode, "session");
    f.app.composer.setValue(""); f.terminal.onInput("\x1b[D");
    assert.equal(f.c.mode, "sessions");
  } finally { await f.cleanup(); }
});

test("command discovery follows project selection, session selection and the open view", async () => {
  const f = setup();
  const expectSuggestion = async (command: string, available: boolean) => {
    f.app.composer.setValue("");
    f.terminal.onInput(command); await tick();
    assert.equal(f.app.composer.showingSuggestions, available, `${command} in ${f.c.mode} with ${f.c.selected?.kind} selected`);
  };
  try {
    f.c.send("task"); await tick();
    const session = f.store.state.sessions[0]!;
    f.c.select(`project:${f.pb.id}`);
    for (const command of ["/session", "/compact", "/undo", "/stop", "/top", "/bottom", "/expand", "/collapse"]) await expectSuggestion(command, false);
    for (const command of ["/model", "/thinking", "/skills", "/settings", "/help"]) await expectSuggestion(command, true);
    f.c.select(`session:${session.id}`);
    assert.equal(f.app.composer.showingSuggestions, false, "Selection changes dismiss the old menu");
    for (const command of ["/session", "/compact", "/undo", "/stop"]) await expectSuggestion(command, true);
    await expectSuggestion("/bottom", false);
    f.c.open();
    for (const command of ["/session", "/compact", "/undo", "/stop", "/top", "/bottom", "/expand", "/collapse"]) await expectSuggestion(command, true);
    f.c.back();
    await expectSuggestion("/bottom", false);
    f.c.select(`project:${f.pb.id}`);
    await expectSuggestion("/compact", false);
    assert.equal(f.engine.calls.length, 1, "Discovery must never dispatch commands or tasks");
  } finally { await f.cleanup(); }
});

test("help lists only the current view's commands and explains their scope", async () => {
  const f = setup();
  const help = () => {
    f.app.composer.onSubmit?.("/help"); f.tui.renderNow();
    const text = f.tui.getScreenLines().map(stripTerminalSequences).join("\n");
    assert.doesNotMatch(text, /ctrl\+l|ctrl\+t|ctrl\+end|shift\+tab|esc\s+stop/i);
    f.terminal.onInput("\x1b");
    return text;
  };
  try {
    f.terminal.rows = 100; f.terminal.onResize();
    const project = help();
    assert.match(project, /Commands: Dashboard \(project selected\)/);
    assert.match(project, /\/model\s+Choose the model for new tasks/);
    assert.doesNotMatch(project, /\|\s*\/(session|compact|undo|stop|top|bottom|expand|collapse)\s/);
    f.c.send("task"); await tick();
    const selected = help();
    assert.match(selected, /Commands: Dashboard \(session selected\)/);
    assert.match(selected, /\/compact\s+Summarize older context in the selected session/);
    assert.match(selected, /\/undo\s+Choose a checkpoint/);
    assert.doesNotMatch(selected, /\|\s*\/(top|bottom|expand|collapse)\s/);
    f.c.open();
    const open = help();
    assert.match(open, /Commands: Open session/);
    assert.match(open, /\/model\s+Choose this session's model/);
    for (const command of ["top", "bottom", "expand", "collapse"]) assert.match(open, new RegExp(`\\|\\s*\\/${command}\\s`));
    assert.equal(f.engine.calls.length, 1);
  } finally { await f.cleanup(); }
});

test("manually entered transcript commands on the dashboard do not start agent tasks", async () => {
  const f = setup();
  try {
    for (const command of ["/top", "/bottom", "/expand", "/collapse"]) {
      f.app.composer.setValue(command); f.terminal.onInput("\r"); await tick();
      assert.match(f.c.notice, /only available in an open session/);
      assert.equal(f.app.composer.getValue(), "");
    }
    assert.equal(f.engine.calls.length, 0);
    assert.equal(f.store.state.sessions.length, 0);
  } finally { await f.cleanup(); }
});

test("path completion uses the selected project and peek session rather than the launch cwd", async () => {
  const f = setup();
  try {
    writeFileSync(join(f.pa.path, "alpha-only.txt"), "");
    writeFileSync(join(f.pb.path, "beta-only.txt"), "");
    f.c.select(`project:${f.pa.id}`);
    f.terminal.onInput("inspect ./alpha-on"); f.terminal.onInput("\t"); await tick();
    assert.equal(f.app.composer.getValue(), "inspect ./alpha-only.txt");
    assert.equal(f.engine.calls.length, 0);
    f.app.composer.setValue("task"); f.terminal.onInput("\r"); await tick();
    const id = f.store.state.sessions[0]!.id;
    f.c.select(`session:${id}`); f.terminal.onInput(" ");
    f.terminal.onInput("inspect ./alpha-on"); f.terminal.onInput("\t"); await tick();
    assert.equal(f.c.dialog?.kind, "peek");
    f.terminal.onInput("\r"); await tick();
    assert.equal(f.engine.calls.at(-1)?.prompt, "inspect ./alpha-only.txt");
    assert.equal(f.engine.calls.at(-1)?.session.id, id);
    f.c.select(`project:${f.pb.id}`);
    f.app.composer.setValue(""); f.terminal.onInput("inspect ./beta-on"); f.terminal.onInput("\t"); await tick();
    assert.equal(f.app.composer.getValue(), "inspect ./beta-only.txt");
  } finally { await f.cleanup(); }
});

test("session footer and /session expose scoped usage without sending a prompt, with scrollable narrow details", async () => {
  const f = setup();
  const screen = () => { f.tui.renderNow(); return f.tui.getScreenLines().map(stripTerminalSequences).join("\n"); };
  try {
    f.terminal.onInput("/session"); f.terminal.onInput("\r");
    assert.match(f.c.notice, /select a session/);
    assert.equal(f.engine.calls.length, 0);
    f.c.send("usage session"); await tick();
    const s = f.store.state.sessions[0]!;
    s.usage = { input: 2000, output: 100, cacheRead: 4000, cacheWrite: 50, totalTokens: 6150,
      cost: { input: 0.01, output: 0.01, cacheRead: 0.01, cacheWrite: 0.001, total: 0.031 } };
    s.titleUsage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
      cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.002 } };
    s.context = { tokens: 5000, cacheHitRate: 50 };
    f.c.open();
    assert.match(screen(), /test\/mock · off · ░░░░░░░░ ~5%\/100k · ◉ 50% · ~\$0\.033/);
    f.terminal.onInput("/session"); f.terminal.onInput("\r");
    assert.equal(f.c.dialog?.kind, "usage");
    assert.match(screen(), /Session usage/);
    assert.match(screen(), /Total tokens\s+6,165/);
    assert.match(screen(), /Title included\s+15 tokens/);
    assert.equal(f.engine.calls.length, 1);
    s.context.tokens = 95000; f.c.changed();
    assert.match(screen(), /Context used\s+~95\.0%/);
    for (const width of [12, 24, 40, 120]) {
      f.terminal.columns = width; f.terminal.rows = 24; f.terminal.onResize(); screen();
      assert.ok(f.tui.getScreenLines().every((line) => visibleWidth(line) <= width));
      f.terminal.onInput("\x1b[6~"); screen();
    }
    f.terminal.onInput("\x1b"); f.terminal.onInput("\x1b[D");
    assert.equal(f.c.mode, "sessions");
    assert.doesNotMatch(screen(), /~95%\/100k/);
    f.terminal.onInput("/session"); f.terminal.onInput("\r");
    assert.equal(f.c.dialog?.kind, "usage", "selected sessions can inspect usage without opening the chat");
    assert.equal(f.engine.calls.length, 1);
  } finally { await f.cleanup(); }
});

test("composer status always shows below the editor with no shortcut toggle or hints", async () => {
  const f = setup();
  const render = () => f.app.render(120).map(stripTerminalSequences);
  const belowComposer = () => {
    const lines = render();
    const border = stripTerminalSequences(f.app.composer.render(120).at(-1)!).trim();
    const bottom = lines.findLastIndex((line) => line.trim() === border);
    assert.ok(bottom >= 0);
    return lines.slice(bottom + 1).map((line) => line.trim()).filter(Boolean);
  };
  try {
    const idle = "test/mock · off · ?/100k · ◉ ? · cost ?";
    assert.deepEqual(belowComposer(), [idle]);
    assert.equal(render().filter((line) => line.includes("test/mock")).length, 1, "Model appears only below the composer");
    assert.doesNotMatch(render().join("\n"), /shortcuts|ctrl\+l model|shift\+tab cycle|ctrl\+j newline|New task in /);
    f.terminal.onInput("?");
    assert.equal(Boolean(f.c.dialog), false);
    assert.equal(f.app.composer.getValue(), "?", "Question marks are now ordinary draft text, even at the start");
    assert.deepEqual(belowComposer(), [idle]);
    assert.equal(f.engine.calls.length, 0);
    f.app.composer.setValue("");
    f.c.send("task"); await tick(); f.c.open();
    f.c.opened!.title = "Composer header test";
    f.c.opened!.context = { tokens: 1234 };
    f.c.opened!.agent = { model: { provider: "test", modelId: "reasoner" }, thinkingLevel: "high" };
    const active = "test/reasoner · high · ░░░░░░░░ ~1%/100k · ◉ ? · cost ?";
    assert.deepEqual(belowComposer(), [active]);
    assert.doesNotMatch(render().join("\n"), /Reply to Composer header test|Enter queues/);
    for (const width of [1, 4, 12, 24, 80, 120]) {
      assert.ok(f.app.render(width).every((line) => visibleWidth(line) <= width));
    }
    f.c.fail("This is still working");
    const lines = render();
    assert.ok(lines.findIndex((line) => line.includes("This is still working"))
      < lines.findIndex((line) => line.includes("describe a task for a new session")));
    assert.deepEqual(belowComposer(), [active], "Notices remain visible above the composer");
    f.c.notice = "";
    f.app.composer.setValue("/help"); f.terminal.onInput("\r");
    assert.equal(f.c.dialog?.kind, "help", "/help retains the full shortcut reference");
  } finally { await f.cleanup(); }
});

test("peek replies always show session-scoped status and accept question marks as text", async () => {
  const f = setup();
  const screen = () => { f.tui.renderNow(); return f.tui.getScreenLines().map(stripTerminalSequences).join("\n"); };
  try {
    f.c.send("peek task"); await tick();
    const session = f.store.state.sessions[0]!;
    session.agent = { model: { provider: "test", modelId: "reasoner" }, thinkingLevel: "high" };
    session.context = { tokens: 80_000, cacheHitRate: 99 };
    f.c.select(`session:${session.id}`);
    f.terminal.onInput(" ");
    assert.equal(f.c.dialog?.kind, "peek");
    assert.doesNotMatch(screen(), /@ files|shortcuts/);
    assert.match(screen(), /test\/reasoner · high · ██████░░ ~80%\/100k · ◉ 99%/);
    f.terminal.onInput("?");
    assert.match(screen(), /test\/reasoner · high/);
    f.terminal.onInput(" Ready"); f.terminal.onInput("?"); f.terminal.onInput("\r"); await tick();
    assert.equal(f.engine.calls.at(-1)?.prompt, "? Ready?");
    assert.equal(f.engine.calls.length, 2);
  } finally { await f.cleanup(); }
});

test("/compact targets the open or selected session, passes instructions, and never sends a prompt", async () => {
  const f = setup();
  try {
    assert.equal(f.app.composer.onSubmit?.("/compact"), "command");
    assert.match(f.c.notice, /Open or select a session/);
    assert.equal(f.engine.compactions.length, 0);
    f.c.send("first task"); await tick();
    const first = f.store.state.sessions[0]!;
    f.c.send("second task"); await tick();
    const second = f.store.state.sessions[1]!;
    const calls = f.engine.calls.length;
    f.c.select(`session:${first.id}`);
    assert.equal(f.app.composer.onSubmit?.("/compact keep exact paths\nand pending tests"), "command");
    await tick();
    assert.equal(f.engine.compactions[0]?.session.id, first.id);
    assert.equal(f.engine.compactions[0]?.instructions, "keep exact paths\nand pending tests");
    assert.match(f.c.notice, /Context compacted/);
    f.c.open();
    f.c.selection = `session:${second.id}`;
    assert.equal(f.app.composer.onSubmit?.("/compact"), "command"); await tick();
    assert.equal(f.engine.compactions[1]?.session.id, first.id, "open session takes precedence over list selection");
    assert.equal(f.engine.compactions[1]?.instructions, undefined);
    assert.equal(f.engine.calls.length, calls);
    assert.equal(f.store.state.sessions.length, 2);
  } finally { await f.cleanup(); }
});

test("Escape stops compaction without marking an idle session stopped", async () => {
  const f = setup();
  try {
    f.c.send("task"); await tick(); f.c.open();
    const session = f.c.opened!;
    let finish!: (result: CompactResult) => void;
    f.engine.compact = async () => new Promise<CompactResult>((resolve) => { finish = resolve; });
    const compacting = f.c.compact();
    await f.c.compact();
    assert.match(f.c.notice, /already compacting/);
    assert.equal(f.c.canStop(session), true);
    f.app.composer.setValue("unsent draft");
    f.terminal.onInput("\x1b"); await tick();
    assert.deepEqual(f.engine.cancelled, [session.id]);
    assert.equal(session.status, "completed");
    assert.equal(session.stopped, undefined);
    assert.equal(f.c.mode, "session");
    assert.equal(f.app.composer.getValue(), "unsent draft");
    finish("aborted"); await compacting;
    assert.match(f.c.notice, /Compaction cancelled/);
  } finally { await f.cleanup(); }
});

test("automatic compaction, retries, failures and summary cards render safely at narrow widths", async () => {
  const f = setup();
  try {
    f.c.send("task"); await tick(); f.c.open();
    const session = f.c.opened!;
    session.compactions = [{ taskId: 123 as TaskId<DurableCompactionResult>, reason: "threshold", blocking: true, attempt: 2,
      retry: { at: Date.now(), error: "Provider busy\nretrying" } }];
    session.compactionFailure = { taskId: 100 as TaskId<DurableCompactionResult>, reason: "overflow", error: "Summary failed\x1b[2J" };
    session.messages.push({ role: "tool", text: "", timestamp: Date.now(), tool: {
      id: "summary", name: "compact", arguments: { reason: "threshold" }, output: "Checkpoint summary", status: "done",
    } });
    const text = f.app.body.transcript.render(120).map(stripTerminalSequences).join("\n");
    assert.match(text, /Compacting context \(auto \/ blocking\) \/ retry 2: Provider busy/);
    assert.match(text, /Compaction failed \(overflow\): Summary failed/);
    assert.match(text, /Context compacted \(threshold\)/);
    assert.ok(!text.includes("Checkpoint summary"));
    f.app.body.transcript.toggleAll(true);
    assert.match(f.app.body.transcript.render(120).join("\n"), /Checkpoint summary/);
    for (const width of [1, 12, 40, 120]) {
      const lines = f.app.body.transcript.render(width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      assert.ok(lines.every((line) => !line.includes("\x1b[2J")));
    }
    assert.equal(f.c.canStop(session), true);
  } finally { await f.cleanup(); }
});

test("busy-session replies clear the composer, preserve work and display queued messages separately", async () => {
  const f = setup();
  const finish: (() => void)[] = [];
  f.engine.run = async (session, project, prompt) => {
    f.engine.calls.push({ session, project, prompt });
    session.status = "working";
    await new Promise<void>((resolve) => finish.push(resolve));
  };
  try {
    f.c.send("initial"); f.c.open();
    const s = f.c.opened!;
    const work = s.work;
    s.preview = "Running bash";
    for (const text of ["then raise a PR", "one more\nline two"]) {
      f.app.composer.setValue(text); f.terminal.onInput("\r");
      assert.equal(f.app.composer.getValue(), "");
      assert.equal(s.work, work); assert.equal(s.preview, "Running bash");
    }
    assert.equal(f.store.state.sessions.length, 1);
    assert.deepEqual(f.engine.calls.map((call) => call.prompt), ["initial", "then raise a PR", "one more\nline two"]);
    assert.deepEqual(s.messages.map((m) => m.text), ["initial"], "queued text is not yet part of the transcript");
    // Native inbox projection drives queue presentation, not optimistic transcript messages.
    s.queuedInputs = [{ id: 1, text: "then raise a PR" }, { id: 2, text: "one more\nline two" }];
    const transcript = f.app.body.transcript.render(120).map(stripTerminalSequences).join("\n");
    assert.match(transcript, /Queued follow-ups \(2\)/);
    assert.match(transcript, /1\. then raise a PR/); assert.match(transcript, /2\. one more/); assert.match(transcript, /line two/);
    assert.doesNotMatch(f.app.render(120).map(stripTerminalSequences).join("\n"), /Enter queues/);
    for (const width of [10, 24, 80]) assert.ok(f.app.render(width).every((line) => visibleWidth(line) <= width));
    s.status = "completed";
    finish[0]!(); await tick();
    assert.equal(f.c.canStop(s), true, "settling the first request must not clear pending follow-ups");
    assert.equal(s.work?.finishedAt, undefined);
    assert.equal(await f.c.configure({ model: { provider: "test", modelId: "reasoner" } }, s.id), false);
    finish[1]!(); await tick();
    assert.equal(f.c.canStop(s), true);
    delete s.queuedInputs;
    finish[2]!(); await tick();
    assert.equal(f.c.canStop(s), false); assert.ok(s.work?.finishedAt);
  } finally { finish.forEach((done) => done()); await tick(); await f.cleanup(); }
});

test("peek accepts follow-ups while working, but stopping or deleting a session still rejects sends", async () => {
  const f = setup();
  let release!: () => void;
  try {
    f.c.send("initial"); await tick();
    const s = f.store.state.sessions[0]!; s.status = "working";
    f.c.peek(); f.app.sync();
    s.queuedInputs = [{ id: 1, text: "existing queue" }];
    f.tui.renderNow();
    assert.match(f.tui.getScreenLines().map(stripTerminalSequences).join("\n"), /Enter queues a follow-up \/ 1 queued/);
    f.terminal.onInput("then raise a PR"); f.terminal.onInput("\r"); await tick();
    assert.equal(f.c.dialog, undefined);
    assert.equal(f.engine.calls.at(-1)?.prompt, "then raise a PR");
    assert.equal(f.engine.calls.at(-1)?.session.id, s.id);

    s.status = "working";
    f.engine.cancel = async () => new Promise<void>((resolve) => { release = resolve; });
    const stopping = f.c.cancel(s.id);
    assert.equal(f.c.send("not while stopping", s.id), false); assert.match(f.c.notice, /stopping/);
    release(); await stopping;
    f.engine.stop = async () => new Promise<void>((resolve) => { release = resolve; });
    f.c.requestDelete(); const deleting = f.c.confirmDelete();
    assert.equal(f.c.send("not while deleting", s.id), false); assert.match(f.c.notice, /stopping/);
    release(); await deleting;
    assert.equal(f.store.state.sessions.length, 0);
  } finally { release?.(); await f.cleanup(); }
});

test("a restored queue remains stoppable even if its last run failed", async () => {
  const f = setup();
  try {
    f.c.send("task"); await tick();
    const s = f.store.state.sessions[0]!;
    s.status = "failed";
    s.pendingInput = { requestId: "queued", prompt: "queued reply" };
    s.queuedInputs = [{ id: 1, text: "queued reply" }];
    assert.equal(f.c.canStop(s), true);
    await f.c.cancel(s.id);
    assert.deepEqual(f.engine.cancelled, [s.id]);
    assert.equal(s.status, "paused"); assert.equal(s.pendingInput, undefined); assert.equal(s.queuedInputs, undefined);
    assert.equal(f.c.notice, "Stopped. Reply to continue.");
  } finally { await f.cleanup(); }
});

test("/settings is a saved configuration page with busy-reply behavior and model/thinking pickers", async () => {
  const f = setup();
  const screen = () => { f.tui.renderNow(); return f.tui.getScreenLines().map(stripTerminalSequences).join("\n"); };
  const kind = () => f.c.dialog?.kind;
  try {
    f.terminal.onInput("/settings"); f.terminal.onInput("\r");
    assert.equal(kind(), "settings"); assert.equal(f.engine.calls.length, 0);
    assert.match(screen(), /Busy-session replies\s+Follow-up/);
    assert.match(screen(), /New-task model/); assert.match(screen(), /Already queued messages keep their mode/);
    f.terminal.onInput("\r");
    assert.equal(kind(), "settings"); assert.equal(f.store.settings.replyBehavior, "steer");
    assert.equal(new Store(f.store.root).settings.replyBehavior, "steer");
    assert.match(screen(), /Busy-session replies\s+Steer/);
    f.terminal.onInput("\x0e"); f.terminal.onInput("\r"); await tick();
    assert.equal(kind(), "model");
    f.terminal.onInput("reasoner"); f.terminal.onInput("\r"); await tick();
    assert.equal(kind(), "settings"); assert.equal(f.c.configuration.model?.modelId, "reasoner");
    assert.match(screen(), /New-task model\s+test\/reasoner/);
    f.terminal.onInput("\x0e"); f.terminal.onInput("\r"); await tick();
    assert.equal(kind(), "thinking");
    f.terminal.onInput("\x10"); f.terminal.onInput("\r"); await tick();
    assert.equal(kind(), "settings"); assert.equal(f.c.configuration.thinkingLevel, "high");
    f.terminal.onInput("\x1b"); assert.equal(f.c.dialog, undefined);
    f.terminal.onInput("/config"); f.terminal.onInput("\r");
    assert.equal(kind(), "settings"); assert.match(screen(), /Busy-session replies\s+Steer/);
    assert.equal(f.store.state.sessions.length, 0);
  } finally { await f.cleanup(); }
});

test("settings preserves session scope and drafts; cancelling a nested picker returns to the page", async () => {
  const f = setup();
  const kind = () => f.c.dialog?.kind;
  try {
    f.c.send("task"); await tick(); f.c.open();
    const s = f.c.opened!; s.status = "working";
    f.app.composer.setValue("keep my reply");
    f.c.showSettings();
    f.tui.renderNow();
    assert.match(f.tui.getScreenLines().map(stripTerminalSequences).join("\n"), /Session model/);
    f.terminal.onInput("\r"); // Global behavior may change even while a session works.
    assert.equal(f.store.settings.replyBehavior, "steer");
    assert.equal(s.status, "working"); assert.equal(f.engine.cancelled.length, 0);
    f.terminal.onInput("\x1b[B"); f.terminal.onInput("\r"); await tick();
    assert.equal(kind(), "model");
    f.terminal.onInput("\x1b"); assert.equal(kind(), "settings");
    assert.equal(f.app.composer.getValue(), "keep my reply");
    s.status = "completed";
    f.terminal.onInput("\r"); await tick(); // Re-open the selected model row.
    f.terminal.onInput("reasoner"); f.terminal.onInput("\r"); await tick();
    assert.equal(kind(), "settings"); assert.equal(s.agent?.model?.modelId, "reasoner");
    assert.equal(f.engine.configuration().model?.modelId, "mock", "session settings must not change new-task defaults");
    for (const width of [10, 24, 50, 120]) {
      f.terminal.columns = width; f.terminal.onResize(); f.tui.renderNow();
      assert.ok(f.tui.getScreenLines().every((line) => visibleWidth(line) <= width));
    }
    f.terminal.onInput("\x1b");
    assert.equal(f.app.composer.getValue(), "keep my reply");
    f.terminal.columns = 120; f.terminal.onResize();
    s.status = "working"; f.c.changed(); f.tui.renderNow();
    assert.doesNotMatch(f.tui.getScreenLines().map(stripTerminalSequences).join("\n"), /Enter queues steering/);
    assert.equal(f.engine.cancelled.length, 0);
  } finally { await f.cleanup(); }
});

test("settings opens without model lookup, reports save errors and never reopens a dismissed page", async (t) => {
  const f = setup();
  let release!: () => void;
  try {
    const original = f.engine.listModels.bind(f.engine);
    let lookups = 0;
    f.engine.listModels = async () => { lookups++; await new Promise<void>((resolve) => { release = resolve; }); return original(); };
    f.c.showSettings(); assert.equal(lookups, 0);
    const save = t.mock.method(f.store, "save", () => { throw new Error("Disk full"); });
    f.terminal.onInput("\r");
    assert.equal(f.store.settings.replyBehavior, "followUp"); assert.match(f.c.notice, /Disk full/);
    assert.equal(f.c.dialog?.kind, "settings");
    save.mock.restore();
    f.terminal.onInput("\x1b[B"); f.terminal.onInput("\r");
    assert.equal(lookups, 1);
    f.terminal.onInput("\x1b"); assert.equal(f.c.dialog, undefined);
    release(); await tick(); assert.equal(f.c.dialog, undefined);
  } finally { release?.(); await f.cleanup(); }
});

test("mixed queued modes retain truthful labels after changing the busy-reply setting", async () => {
  const f = setup();
  try {
    f.c.send("task"); await tick(); f.c.open();
    const s = f.c.opened!; s.status = "working";
    s.queuedInputs = [{ id: 1, text: "finish later", mode: "followUp" }, { id: 2, text: "change course", mode: "steer" }];
    f.c.setReplyBehavior("steer");
    const text = f.app.body.transcript.render(120).map(stripTerminalSequences).join("\n");
    assert.match(text, /Queued messages \(2\)/);
    assert.match(text, /1\. \[follow-up\] finish later/); assert.match(text, /2\. \[steer\] change course/);
    f.c.setReplyBehavior("followUp");
    assert.equal(f.app.body.transcript.render(120).map(stripTerminalSequences).join("\n"), text);
  } finally { await f.cleanup(); }
});

test("/undo opens a cancellable picker, restores only the chosen checkpoint, and keeps session scope", async () => {
  const f = setup();
  const kind = () => f.c.dialog?.kind;
  try {
    f.app.composer.onSubmit?.("/undo"); await tick();
    assert.match(f.c.notice, /Open or select a session/);
    assert.equal(f.engine.undos.length, 0);
    f.c.send("first task"); await tick();
    const first = f.store.state.sessions[0]!;
    f.c.send("second task"); await tick();
    const second = f.store.state.sessions[1]!;
    const calls = f.engine.calls.length;
    f.c.select(`session:${first.id}`);
    f.app.composer.onSubmit?.("/undo"); await tick();
    assert.equal(kind(), "undo");
    assert.equal(f.engine.undos.length, 0, "opening the picker must not restore anything");
    f.tui.renderNow();
    const text = f.tui.getScreenLines().map(stripTerminalSequences).join("\n");
    assert.match(text, /Restore a checkpoint/); assert.match(text, /Latest prompt/); assert.match(text, /Older prompt/);
    f.terminal.onInput("\x1b");
    assert.equal(kind(), undefined); assert.equal(f.engine.undos.length, 0, "Escape cancels without restoring");
    f.app.composer.onSubmit?.("/undo"); await tick();
    f.terminal.onInput("\x1b[B");
    assert.equal(f.engine.undos.length, 0, "browsing must not restore anything");
    f.terminal.onInput("\r"); await tick();
    assert.equal(f.engine.undos[0]?.id, first.id);
    assert.equal(f.engine.undoIds[0], "older");
    assert.equal(kind(), undefined);
    assert.equal(f.app.composer.getValue(), "", "dashboard undo must not prefill a new task");
    assert.match(f.c.notice, /conversation and 1 tracked file restored/);
    f.c.open(); f.c.selection = `session:${second.id}`;
    f.terminal.onInput("/undo"); f.terminal.onInput("\r"); await tick();
    assert.equal(f.engine.undos.length, 1);
    f.terminal.onInput("\r"); await tick();
    assert.equal(f.engine.undos[1]?.id, first.id);
    assert.equal(f.engine.undoIds[1], "latest");
    assert.equal(f.app.composer.getValue(), "Restored prompt");
    assert.equal(f.engine.calls.length, calls);
    assert.equal(f.store.state.sessions.length, 2);
    f.app.composer.onSubmit?.("/undo 2"); await tick();
    assert.match(f.c.notice, /Usage: \/undo/);
    assert.equal(f.engine.undos.length, 2);
  } finally { await f.cleanup(); }
});

test("checkpoint restore refuses busy projects, blocks sends, preserves new drafts, and reports failures", async () => {
  const f = setup();
  let finish!: (result: { prompt: string; files: number; shell: boolean }) => void;
  try {
    f.c.send("task"); await tick(); f.c.open();
    const s = f.c.opened!;
    s.status = "working";
    await f.c.showUndo(); assert.match(f.c.notice, /Wait for this project's sessions/);
    assert.equal(f.engine.undos.length, 0);
    s.status = "completed";
    f.engine.undo = async () => new Promise((resolve) => { finish = resolve; });
    f.terminal.onInput("/undo"); f.terminal.onInput("\r"); await tick();
    f.terminal.onInput("\r");
    assert.equal(f.c.send("too soon", s.id), false);
    assert.equal(f.c.send("new task in same project"), false);
    f.app.composer.setValue("new unsent draft");
    finish({ prompt: "old prompt", files: 0, shell: true }); await tick();
    assert.equal(f.app.composer.getValue(), "new unsent draft");
    assert.match(f.c.notice, /Shell-command changes were NOT undone/);
    f.engine.undo = async () => { throw new Error("file changed since the agent edited it"); };
    await f.c.showUndo();
    await f.c.undo("latest", s.id);
    assert.match(f.c.notice, /file changed since/);
    assert.equal(f.c.dialog?.kind, "undo", "a failed restore leaves the picker open for retry or cancellation");
    assert.equal(f.app.composer.getValue(), "new unsent draft");
    f.terminal.onInput("\x1b");
    assert.equal(f.c.send("now allowed", s.id), true); await tick();
  } finally { finish?.({ prompt: "", files: 0, shell: false }); await f.cleanup(); }
});

test("checkpoint picker filters prompts without restoring, and handles empty or stale results", async () => {
  const f = setup();
  try {
    f.c.send("task"); await tick(); f.c.open();
    f.terminal.onInput("/undo"); f.terminal.onInput("\r"); await tick();
    f.terminal.onInput("Older");
    assert.equal(f.engine.undos.length, 0);
    f.terminal.onInput("\r"); await tick();
    assert.deepEqual(f.engine.undoIds, ["older"]);
    f.engine.undoCheckpoints = async () => [];
    await f.c.showUndo();
    assert.match(f.c.notice, /No undo checkpoints yet/);
    assert.equal(f.c.dialog, undefined);
    let resolve!: (points: Awaited<ReturnType<typeof f.engine.undoCheckpoints>>) => void;
    const points = [{ id: "stale", turn: 1, prompt: "stale prompt", turns: 1, files: 0, shell: false }];
    f.engine.undoCheckpoints = async () => new Promise((done) => { resolve = done; });
    const loading = f.c.showUndo();
    f.c.back(); resolve(points); await loading;
    assert.equal(f.c.dialog, undefined, "late results must not open a picker in a different view");
  } finally { await f.cleanup(); }
});

test("checkpoint picker renders safely in narrow terminals and a mouse click selects without restoring", async () => {
  const f = setup();
  try {
    f.c.send("task"); await tick(); f.c.open();
    const choices = await f.engine.undoCheckpoints(f.c.opened!);
    choices[1]!.prompt = "Older prompt\x1b[2J\nwith long details 界面 😀 ".repeat(3);
    f.engine.undoCheckpoints = async () => choices;
    await f.c.showUndo();
    const dialog = f.c.dialog;
    assert.ok(dialog?.kind === "undo");
    const picker = new UndoDialog(f.c, f.tui, dialog, () => {});
    for (const rows of [24, 32]) {
      f.terminal.rows = rows;
      for (const width of [18, 40, 80]) {
        const lines = picker.render(width);
        assert.ok(lines.every((line) => visibleWidth(line) <= width));
        assert.ok(lines.length <= Math.floor(rows * 0.85));
        assert.ok(!lines.join("\n").includes("\x1b[2J"));
      }
    }
    const lines = picker.render(80).map(stripTerminalSequences);
    const y = lines.findIndex((line) => line.includes("Turn 1:"));
    assert.ok(y > 0);
    picker.handleMouse({ type: "click", button: "left", clickCount: 1, x: 4, y, screenX: 4, screenY: y,
      width: 80, height: 32, shift: false, ctrl: false, alt: false });
    assert.equal(f.engine.undos.length, 0);
    picker.handleInput("\r"); await tick();
    assert.deepEqual(f.engine.undoIds, ["older"]);
  } finally { await f.cleanup(); }
});

test("session and peek arrows recall saved prompts without sending or leaking sessions", async () => {
  const f = setup();
  try {
    f.c.send("first session prompt"); await tick();
    const first = f.store.state.sessions[0]!;
    f.c.send("second session prompt"); await tick();
    const second = f.store.state.sessions[1]!;
    first.messages.push({ role: "assistant", text: "not a prompt", timestamp: 2 });
    first.messages.push({ role: "user", text: "saved follow-up", timestamp: 3 });
    f.c.select(`session:${first.id}`); f.c.open();
    const calls = f.engine.calls.length;
    f.terminal.onInput("\x1b[A");
    assert.equal(f.app.composer.getValue(), "saved follow-up");
    f.terminal.onInput("\x1b[A"); f.terminal.onInput("\x1b[A");
    assert.equal(f.app.composer.getValue(), "first session prompt");
    f.terminal.onInput("\x1b[B"); f.terminal.onInput("\x1b[B");
    assert.equal(f.app.composer.getValue(), "");
    assert.equal(f.engine.calls.length, calls, "Recalling must never send a prompt");
    f.terminal.onInput("new reply"); f.terminal.onInput("\r"); await tick();
    f.terminal.onInput("\x1b[A");
    assert.equal(f.app.composer.getValue(), "new reply", "Accepted replies join history immediately");
    f.c.back();
    const before = f.c.selection;
    f.terminal.onInput("\x1b[A");
    assert.notEqual(f.c.selection, before, "Dashboard arrows still navigate rows");
    f.c.select(`session:${second.id}`); f.c.open();
    f.terminal.onInput("\x1b[A"); f.terminal.onInput("\x1b[A");
    assert.equal(f.app.composer.getValue(), "second session prompt");
    f.c.back(); f.c.select(`session:${first.id}`); f.c.peek();
    f.terminal.onInput("\x1b[A"); f.terminal.onInput("\r"); await tick();
    assert.equal(f.engine.calls.at(-1)?.session.id, first.id);
    assert.equal(f.engine.calls.at(-1)?.prompt, "new reply", "Peek can recall and resend a saved prompt");
  } finally { await f.cleanup(); }
});

test("settings shows and toggles reasoning independently of the model thinking level", async () => {
  const f = setup();
  try {
    f.c.send("task"); await tick(); f.c.open();
    const session = f.c.opened!;
    session.messages.unshift({ role: "thinking", text: "A provider-visible explanation\nwith several reasoning lines\x1b[2J", timestamp: 1, thinking: { id: "thinking:one" } });
    session.messages.push({ role: "thinking", text: "should not be shown", timestamp: 2, thinking: { id: "thinking:redacted", redacted: true } });
    const render = (width = 80) => f.app.body.transcript.render(width).map(stripTerminalSequences).join("\n");
    assert.match(render(), /A provider-visible explanation/);
    assert.match(render(), /Thinking \(redacted\)/); assert.doesNotMatch(render(), /should not be shown/);
    for (const width of [1, 8, 24, 80]) assert.ok(f.app.body.transcript.render(width).every((line) => visibleWidth(line) <= width));
    render(); f.app.body.transcript.move(1); f.app.body.transcript.toggle();
    assert.doesNotMatch(render(), /provider-visible/);
    f.app.body.transcript.toggleAll(true); assert.match(render(), /provider-visible/);
    const configuration = f.c.configuration;
    const calls = f.engine.calls.length;
    f.c.showSettings("showThinking"); f.tui.renderNow();
    assert.match(f.tui.getScreenLines().map(stripTerminalSequences).join("\n"), /Show reasoning\s+On/);
    f.terminal.onInput("\r"); f.tui.renderNow();
    assert.equal(f.c.dialog?.kind, "settings");
    assert.match(f.tui.getScreenLines().map(stripTerminalSequences).join("\n"), /Show reasoning\s+Off/);
    assert.doesNotMatch(render(), /provider-visible|Thinking \(redacted\)/);
    assert.deepEqual(f.c.configuration, configuration); assert.equal(f.engine.calls.length, calls);
    assert.equal(new Store(f.store.root).settings.showThinking, false);
    f.terminal.onInput("\x1b");
    f.c.showSettings("showThinking"); f.terminal.onInput("\r");
    assert.match(render(), /provider-visible/);
  } finally { await f.cleanup(); }
});

test("reasoning visibility is a global saved settings row with keyboard navigation, rollback and draft preservation", async (t) => {
  const f = setup();
  try {
    f.app.composer.setValue("keep this draft");
    const configuration = f.c.configuration;
    let lookups = 0;
    f.engine.listModels = async () => { lookups++; return []; };
    f.c.showSettings();
    for (let i = 0; i < 3; i++) f.terminal.onInput("\x0e");
    f.tui.renderNow();
    const screen = () => f.tui.getScreenLines().map(stripTerminalSequences).join("\n");
    assert.match(screen(), /Show reasoning\s+On/);
    assert.match(screen(), /Display only/);
    assert.match(screen(), /all sessions/);
    const save = t.mock.method(f.store, "save", () => { throw new Error("Disk full"); });
    f.terminal.onInput("\r");
    assert.equal(f.store.settings.showThinking, undefined, "A failed save must preserve the default visible state");
    assert.match(f.c.notice, /Disk full/);
    save.mock.restore();
    f.terminal.onInput("\r"); f.tui.renderNow();
    assert.match(screen(), /Show reasoning\s+Off/);
    assert.equal(new Store(f.store.root).settings.showThinking, false);
    assert.equal(f.c.dialog?.kind, "settings");
    assert.deepEqual(f.c.configuration, configuration);
    assert.equal(lookups, 0); assert.equal(f.engine.calls.length, 0);
    f.terminal.onInput("\x1b");
    assert.equal(f.app.composer.getValue(), "keep this draft");
    f.c.showSettings("showThinking"); f.terminal.onInput(" ");
    assert.equal(new Store(f.store.root).settings.showThinking, true);
  } finally { await f.cleanup(); }
});

test("/copy and /copy N copy exact assistant text from the selected or open session without running an agent", async () => {
  const copied: string[] = [];
  const f = setup(async (text) => { copied.push(text); });
  try {
    f.c.send("first task"); await tick();
    const first = f.store.state.sessions[0]!;
    const older = "  **Older response**\n\n```ts\nconst answer = 42;\n```\n";
    const latest = "Latest response 日本語\nwith a second line  ";
    first.messages = [
      { role: "assistant", text: older, timestamp: 1 },
      { role: "user", text: "not an answer", timestamp: 2 },
      { role: "thinking", text: "private reasoning", timestamp: 3 },
      { role: "tool", text: "tool output", timestamp: 4 },
      { role: "assistant", text: latest, timestamp: 5 },
      { role: "assistant", text: " \n ", timestamp: 6 },
      { role: "error", text: "not an answer either", timestamp: 7 },
    ];
    const calls = f.engine.calls.length;
    f.app.composer.setValue("/copy"); f.terminal.onInput("\r"); await tick();
    assert.deepEqual(copied, [latest]);
    assert.match(f.c.notice, /Copied assistant response 1/);
    assert.equal(f.app.composer.getValue(), "");
    f.app.composer.setValue("/copy 2"); f.terminal.onInput("\r"); await tick();
    assert.deepEqual(copied, [latest, older]);
    f.c.open();
    f.c.selection = `project:${f.pb.id}`;
    f.app.composer.setValue("/copy 1"); f.terminal.onInput("\r"); await tick();
    assert.deepEqual(copied, [latest, older, latest], "The open session takes precedence over dashboard selection");
    assert.equal(f.engine.calls.length, calls); assert.equal(f.store.state.sessions.length, 1);
    assert.equal(first.messages.length, 7); assert.equal(first.status, "completed");
  } finally { await f.cleanup(); }
});

test("copy validates its index and target, reports missing responses and never falls through to a task", async () => {
  const copied: string[] = [];
  const f = setup(async (text) => { copied.push(text); });
  try {
    f.app.composer.setValue("/copy"); f.terminal.onInput("\r"); await tick();
    assert.match(f.c.notice, /Open or select a session/);
    assert.equal(f.engine.calls.length, 0); assert.equal(f.store.state.sessions.length, 0);
    f.c.send("task"); await tick();
    const session = f.store.state.sessions[0]!;
    for (const argument of ["0", "-1", "1.5", "1e1", "0x1", "NaN", "Infinity", "2 extra", "9007199254740992"]) {
      f.app.composer.setValue(`/copy ${argument}`); f.terminal.onInput("\r"); await tick();
      assert.match(f.c.notice, /Usage: \/copy \[N\]/, argument);
    }
    f.app.composer.setValue("/copy 2"); f.terminal.onInput("\r"); await tick();
    assert.match(f.c.notice, /Only 1 assistant response is available/);
    session.messages = [{ role: "user", text: "prompt", timestamp: 1 }, { role: "thinking", text: "thought", timestamp: 2 }];
    await f.c.copyResponse(); assert.match(f.c.notice, /No assistant responses/);
    assert.deepEqual(copied, []); assert.equal(f.engine.calls.length, 1);
  } finally { await f.cleanup(); }
});

test("clipboard failures are visible and a subsequent copy can succeed", async () => {
  let available = false;
  const copied: string[] = [];
  const f = setup(async (text) => {
    if (!available) throw new Error("Clipboard unavailable");
    copied.push(text);
  });
  try {
    f.c.send("task"); await tick();
    await f.c.copyResponse();
    assert.match(f.c.notice, /Could not copy response: Clipboard unavailable/);
    assert.doesNotMatch(f.c.notice, /Copied assistant/);
    available = true;
    await f.c.copyResponse();
    assert.deepEqual(copied, ["Reply to task"]); assert.match(f.c.notice, /Copied assistant response 1/);
  } finally { await f.cleanup(); }
});

test("copy snapshots streaming text, serializes clipboard writes and suppresses stale feedback after navigation", async () => {
  let finish!: () => void;
  const copied: string[] = [];
  const f = setup(async (text) => { copied.push(text); if (copied.length === 1) await new Promise<void>((resolve) => { finish = resolve; }); });
  try {
    f.c.send("task"); await tick(); f.c.open();
    const session = f.c.opened!;
    session.messages = [{ role: "assistant", text: "older", timestamp: 1 }, { role: "assistant", text: "partial", timestamp: 2 }];
    session.status = "working";
    const latest = f.c.copyResponse();
    session.messages[1]!.text = "later streamed text";
    await tick(); assert.deepEqual(copied, ["partial"]);
    const older = f.c.copyResponse("2"); await tick(); assert.equal(copied.length, 1);
    f.c.back(); f.c.select(`project:${f.pb.id}`);
    f.c.notice = "keep navigation notice";
    finish(); await Promise.all([latest, older]);
    assert.deepEqual(copied, ["partial", "older"]);
    assert.equal(f.c.notice, "keep navigation notice");
    assert.equal(session.status, "working"); assert.equal(f.engine.cancelled.length, 0);
  } finally { finish?.(); await f.cleanup(); }
});

test("copy works with saved response history after reopening without changing stored content", async () => {
  const f = setup(async () => {});
  let restored: Controller | undefined;
  try {
    f.c.send("persisted task"); await tick();
    const session = f.store.state.sessions[0]!;
    f.store.save();
    const copied: string[] = [];
    const store = new Store(f.store.root);
    restored = new Controller(store, new FakeEngine(), undefined, async (text) => { copied.push(text); });
    restored.select(`session:${session.id}`);
    const original = readFileSync(store.file, "utf8");
    await restored.copyResponse();
    assert.deepEqual(copied, ["Reply to persisted task"]);
    assert.equal(readFileSync(store.file, "utf8"), original);
  } finally { await restored?.close(); await f.cleanup(); }
});

test("/settings toggles global auto-compaction without model calls or losing the draft", async () => {
  const f = setup();
  try {
    f.app.composer.setValue("preserve this draft");
    const configuration = f.c.configuration;
    f.engine.listModels = async () => assert.fail("Compaction settings need no model catalog");
    f.c.showSettings();
    for (let i = 0; i < 4; i++) f.terminal.onInput("\x0e");
    const screen = () => { f.tui.renderNow(); return f.tui.getScreenLines().map(stripTerminalSequences).join("\n"); };
    assert.match(screen(), /Auto-compaction\s+On/);
    assert.match(screen(), /all current and future sessions/);
    assert.match(screen(), /Off still allows \/compact/);
    f.terminal.onInput(" ");
    assert.match(screen(), /Auto-compaction\s+Off/);
    assert.equal(new Store(f.store.root).compaction.enabled, false);
    f.terminal.onInput("\r");
    assert.match(screen(), /Auto-compaction\s+On/);
    assert.equal(new Store(f.store.root).compaction.enabled, true);
    assert.deepEqual(f.c.configuration, configuration); assert.equal(f.engine.calls.length, 0);
    f.terminal.onInput("\x1b");
    assert.equal(f.app.composer.getValue(), "preserve this draft");
  } finally { await f.cleanup(); }
});

test("/settings edits compaction budgets inline, validates counts, and cancels unsaved edits", async () => {
  const f = setup();
  try {
    f.c.send("task"); await tick(); f.c.open();
    const configuration = f.c.configuration; const calls = f.engine.calls.length;
    f.app.composer.setValue("keep session draft");
    f.c.showSettings("reserveTokens");
    const screen = () => { f.tui.renderNow(); return f.tui.getScreenLines().map(stripTerminalSequences).join("\n"); };
    assert.match(screen(), /Compaction reserve\s+16,384/);
    assert.match(screen(), /83,616 estimated tokens/);
    f.terminal.onInput("\r"); f.terminal.onInput("\x15"); f.terminal.onInput("0"); f.terminal.onInput("\r");
    assert.equal(f.store.compaction.reserveTokens, 16384);
    assert.match(screen(), /at least 2 tokens/);
    f.terminal.onInput("\x15"); f.terminal.onInput("30000");
    assert.equal(f.store.compaction.reserveTokens, 16384, "Editing does not save until Enter");
    f.terminal.onInput("\r");
    assert.match(screen(), /Compaction reserve\s+30,000/);
    assert.match(screen(), /70,000 estimated tokens/);
    f.terminal.onInput("\x0e"); f.terminal.onInput("\r"); f.terminal.onInput("\x15"); f.terminal.onInput("0"); f.terminal.onInput("\r");
    assert.equal(f.store.compaction.keepRecentTokens, 0);
    f.terminal.onInput("\x0e"); f.terminal.onInput("\r"); f.terminal.onInput("\x15"); f.terminal.onInput("0"); f.terminal.onInput("\r");
    assert.equal(f.store.compaction.backgroundTokens, 0);
    assert.match(screen(), /0 disables background compaction only/);
    const saved = { ...f.store.compaction };
    assert.deepEqual(new Store(f.store.root).compaction, saved);
    f.terminal.onInput("\r"); f.terminal.onInput("\x15"); f.terminal.onInput("1e4"); f.terminal.onInput("\r");
    assert.match(screen(), /whole token count/);
    assert.deepEqual(f.store.compaction, saved);
    f.terminal.onInput("\x15"); f.terminal.onInput("5000"); f.terminal.onInput("\x1b");
    assert.equal(f.c.dialog?.kind, "settings"); assert.deepEqual(f.store.compaction, saved);
    f.terminal.onInput("\x1b");
    assert.equal(f.c.dialog, undefined);
    assert.equal(f.app.composer.getValue(), "keep session draft");
    assert.deepEqual(f.c.configuration, configuration); assert.equal(f.engine.calls.length, calls);
  } finally { await f.cleanup(); }
});

test("question wizard supports radio, plain select, multiple choices, input and review before sending", async () => {
  const f = setup();
  const screen = () => { f.tui.renderNow(); return f.tui.getScreenLines().map(stripTerminalSequences).join("\n"); };
  try {
    const session = waitingSession(); session.projectId = f.pa.id;
    f.store.state.sessions.push(session);
    f.c.select(`session:${session.id}`); f.c.open();
    assert.ok(f.c.questionForm);
    assert.equal(f.c.dialog, undefined);
    assert.match(screen(), /Question 1 of 4/);
    assert.match(screen(), /What should I build/);
    f.terminal.onInput("\x1b[B"); f.terminal.onInput("\r");
    assert.match(screen(), /Question 2 of 4/);
    assert.doesNotMatch(screen(), /Filter options/);
    assert.match(screen(), /TypeScript/);
    f.terminal.onInput("\x1b[B"); f.terminal.onInput("\r");
    assert.match(screen(), /Question 3 of 4/);
    f.terminal.onInput("\x1b[A"); f.terminal.onInput("\r");
    assert.match(screen(), /Select at least one option/);
    f.terminal.onInput("\x1b[B"); f.terminal.onInput(" "); f.terminal.onInput("\x1b[B"); f.terminal.onInput(" ");
    assert.match(screen(), /\[x\] Tests/);
    assert.match(screen(), /\[x\] Documentation/);
    f.terminal.onInput("\t");
    assert.match(screen(), /my-project/);
    f.terminal.onInput("\r");
    assert.match(screen(), /Enter an answer to continue/);
    f.terminal.onInput("my-builder"); f.terminal.onInput("\r");
    assert.match(screen(), /Review your answers/);
    assert.equal(f.engine.calls.length, 0, "No model calls between steps or on entering review");
    assert.equal(session.status, "needs-input");
    f.terminal.onInput("\x02");
    assert.match(screen(), /my-builder/);
    f.terminal.onInput("\r"); f.terminal.onInput("\r"); await tick();
    assert.equal(f.engine.calls.length, 1);
    assert.equal(f.engine.calls[0]!.session.id, session.id);
    const prompt = f.engine.calls[0]!.prompt;
    const answers = JSON.parse(prompt.slice(prompt.indexOf("\n") + 1));
    assert.deepEqual(answers.map((answer: { answer: unknown }) => answer.answer), ["web", "go", ["tests", "docs"], "my-builder"]);
    assert.equal(f.c.dialog, undefined);
  } finally { await f.cleanup(); }
});

test("closing questions preserves drafts on /answer and never blocks a normal text reply", async () => {
  const f = setup();
  const screen = () => { f.tui.renderNow(); return f.tui.getScreenLines().map(stripTerminalSequences).join("\n"); };
  try {
    const session = waitingSession(); session.projectId = f.pa.id;
    f.store.state.sessions.push(session);
    f.c.select(`session:${session.id}`); f.c.peek();
    assert.ok(f.c.questionForm, "Peek opens the pending questions inline too");
    assert.equal(f.c.dialog, undefined);
    // Custom answers remain available even when choices don't cover the user's intent.
    f.terminal.onInput("\x1b[A"); f.terminal.onInput("\r"); f.terminal.onInput("A different target");
    f.terminal.onInput("\x1b");
    assert.equal(f.c.dialog, undefined);
    assert.equal(session.status, "needs-input");
    assert.equal(f.engine.calls.length, 0);
    f.c.changed(); assert.equal(f.c.dialog, undefined, "An unrelated render must not reopen a dismissed question");
    f.app.composer.onSubmit?.("/answer");
    assert.ok(f.c.questionForm);
    assert.equal(f.c.dialog, undefined);
    assert.match(screen(), /A different target/);
    f.terminal.onInput("\x1b");
    f.c.open();
    f.app.composer.onSubmit?.("Skip the form, just build a CLI"); await tick();
    assert.equal(f.engine.calls.length, 1);
    assert.equal(f.engine.calls[0]!.prompt, "Skip the form, just build a CLI");
  } finally { await f.cleanup(); }
});

test("question arrivals do not steal other sessions' focus and stale answers cannot be submitted", async () => {
  const f = setup();
  try {
    f.c.send("Another task"); await tick(); f.c.open();
    const active = f.c.opened!;
    const session = waitingSession(); session.projectId = f.pb.id;
    f.store.state.sessions.push(session); f.c.changed();
    assert.equal(f.c.dialog, undefined);
    f.c.dialog = { kind: "help" }; f.c.changed();
    active.status = "needs-input";
    active.messages.push(...session.messages);
    f.c.changed();
    assert.equal(f.c.dialog.kind, "help");
    f.c.dialog = undefined; f.c.changed();
    assert.ok(f.c.questionForm);
    assert.equal(f.c.dialog, undefined);
    const id = pendingQuestion(active)!.id;
    active.status = "completed";
    const calls = f.engine.calls.length;
    assert.equal(f.c.answerQuestions(active.id, id, {}), false);
    assert.equal(f.engine.calls.length, calls);
    assert.match(f.c.notice, /no longer waiting/);
    assert.equal(f.c.dialog, undefined);
  } finally { await f.cleanup(); }
});

test("question composers fit narrow widths, sanitize model text and keep long reviews scrollable", async () => {
  const f = setup();
  try {
    const session = waitingSession(); session.projectId = f.pa.id;
    session.messages[1]!.tool!.arguments = { question: "Title\x1b[2J", questions: [{ id: "answer", question: "Long question ".repeat(10), type: "input" }] };
    f.store.state.sessions.push(session);
    const dialog = new QuestionComposer(f.c, f.tui, { sessionId: session.id, request: pendingQuestion(session)! });
    for (const width of [10, 24, 40, 80]) {
      const lines = dialog.render(width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      assert.ok(lines.every((line) => !line.includes("\x1b[2J")));
    }
    dialog.handleInput("long answer ".repeat(100)); dialog.handleInput("\r");
    const before = dialog.render(40).map(stripTerminalSequences).join("\n");
    assert.match(before, /Review your answers/);
    for (let i = 0; i < 20; i++) dialog.handleInput("\x1b[6~");
    const after = dialog.render(40).map(stripTerminalSequences).join("\n");
    assert.notEqual(before, after);
    assert.match(after, /Enter send/);
    assert.equal(f.engine.calls.length, 0);
  } finally { await f.cleanup(); }
});

test("custom multiselect answers stay visible and removable when going back", async () => {
  const f = setup();
  try {
    const session = waitingSession(); session.projectId = f.pa.id;
    session.messages[1]!.tool!.arguments = { question: "Features", questions: [{ id: "features", question: "Which features?", type: "multiselect", options: [
      { value: "tests", label: "Tests" }, { value: "docs", label: "Docs" },
    ] }] };
    f.store.state.sessions.push(session);
    const dialog = new QuestionComposer(f.c, f.tui, { sessionId: session.id, request: pendingQuestion(session)! });
    dialog.handleInput(" "); // Select Tests.
    dialog.handleInput("\x1b[B"); dialog.handleInput("\x1b[B"); // Inline custom answer.
    dialog.handleInput("Offline mode"); dialog.handleInput("\t");
    assert.match(dialog.render(80).map(stripTerminalSequences).join("\n"), /Tests, Offline mode/);
    dialog.handleInput("\x1b[Z");
    assert.match(dialog.render(80).map(stripTerminalSequences).join("\n"), /\[x\] Offline mode/);
    dialog.handleInput("\x15");
    assert.doesNotMatch(dialog.render(80).map(stripTerminalSequences).join("\n"), /Offline mode/);
    dialog.handleInput("\t"); dialog.handleInput("\r"); await tick();
    assert.match(f.engine.calls[0]!.prompt, /"tests"/);
    assert.doesNotMatch(f.engine.calls[0]!.prompt, /Offline mode/);
  } finally { await f.cleanup(); }
});

test("question choices support mouse selection and keep descriptions at every terminal height", async () => {
  const f = setup();
  try {
    const session = waitingSession(); session.projectId = f.pa.id;
    session.messages[1]!.tool!.arguments = { question: "Target", questions: [{ id: "target", question: "Choose a target", type: "radio", allowOther: false, options: [
      { value: "cli", label: "CLI" }, { value: "web", label: "Website" },
    ] }] };
    f.store.state.sessions.push(session);
    const dialog = new QuestionComposer(f.c, f.tui, { sessionId: session.id, request: pendingQuestion(session)! });
    const lines = dialog.render(80).map(stripTerminalSequences);
    const y = lines.findIndex((line) => line.includes("Website"));
    assert.equal(dialog.handleMouse({ type: "click", button: "left", x: 6, y, screenX: 6, screenY: y,
      width: 80, height: 32, shift: false, ctrl: false, alt: false })?.render, true);
    assert.match(dialog.render(80).map(stripTerminalSequences).join("\n"), /Review your answers/);
    assert.equal(f.engine.calls.length, 0, "A click must not submit the form");
    const request = pendingQuestion(session)!;
    request.questions[0]!.question = "A long wrapped question ".repeat(12);
    request.questions[0]!.type = "select";
    const small = new QuestionComposer(f.c, f.tui, { sessionId: session.id, request });
    for (const height of [12, 16, 20, 32]) {
      f.terminal.rows = height;
      const compact = small.render(32);
      assert.ok(compact.every((line) => visibleWidth(line) <= 32));
      assert.match(compact.map(stripTerminalSequences).join("\n"), /Website/);
      assert.match(compact.map(stripTerminalSequences).join("\n"), /No description provided/);
      assert.match(compact.map(stripTerminalSequences).join("\n"), /Enter next/);
    }
  } finally { await f.cleanup(); }
});

test("questions replace the composer without an overlay and keep the transcript visible", async () => {
  const f = setup();
  const screen = () => { f.tui.renderNow(); return f.tui.getScreenLines().map(stripTerminalSequences); };
  try {
    const session = waitingSession(); session.projectId = f.pa.id;
    session.messages.at(-1)!.text = "Transcript stays visible above the questions";
    f.store.state.sessions.push(session);
    f.c.select(`session:${session.id}`); f.c.open();
    assert.equal(f.tui.hasOverlay(), false);
    assert.equal(f.app.composer.focused, false);
    const lines = screen();
    const transcript = lines.findIndex((line) => line.includes("Transcript stays visible"));
    const form = lines.findIndex((line) => line.includes("Question 1 of 4"));
    assert.ok(transcript >= 0 && form > transcript);
    assert.doesNotMatch(lines.join("\n"), /describe a task for a new session|\+---/);
    assert.match(lines.at(-1)!, /test\/mock/);
    const choice = lines.findIndex((line) => line.includes("Website"));
    assert.ok(choice >= 0);
    f.terminal.onInput(`\x1b[<0;6;${choice + 1}M`);
    f.terminal.onInput(`\x1b[<0;6;${choice + 1}m`);
    assert.match(screen().join("\n"), /Question 2 of 4/);
    assert.equal(f.tui.hasOverlay(), false);
    assert.equal(f.engine.calls.length, 0);
    for (const [width, height] of [[40, 16], [80, 24], [120, 32]]) {
      f.terminal.columns = width!; f.terminal.rows = height!; f.terminal.onResize();
      const resized = screen();
      assert.ok(resized.every((line) => visibleWidth(line) <= width!));
      assert.ok(f.app.chatScroll.viewportHeight >= 1, "The transcript retains its own viewport");
      assert.match(resized.join("\n"), /Question 2 of 4/);
    }
  } finally { await f.cleanup(); }
});

test("inline questions preserve the composer draft, survive dialogs and restore focus on dismissal", async () => {
  const f = setup();
  const screen = () => { f.tui.renderNow(); return f.tui.getScreenLines().map(stripTerminalSequences).join("\n"); };
  try {
    const session = waitingSession(); session.projectId = f.pa.id;
    session.status = "completed";
    f.store.state.sessions.push(session);
    f.c.select(`session:${session.id}`); f.c.open();
    f.app.composer.setValue("keep this unsent reply");
    session.status = "needs-input"; f.c.changed();
    assert.ok(f.c.questionForm);
    assert.equal(f.tui.hasOverlay(), false);
    assert.equal(f.app.composer.getValue(), "keep this unsent reply");
    assert.doesNotMatch(screen(), /keep this unsent reply/);
    f.terminal.onInput("\x1b[A"); f.terminal.onInput("\r");
    f.terminal.onInput("custom answer draft");
    assert.equal(f.app.composer.getValue(), "keep this unsent reply", "Question typing never reaches the hidden composer");
    f.c.dialog = { kind: "help" }; f.c.changed();
    assert.equal(f.tui.hasOverlay(), true);
    f.terminal.onInput("\x1b");
    assert.equal(f.tui.hasOverlay(), false);
    assert.match(screen(), /custom answer draft/);
    f.terminal.onInput("\x1b");
    assert.equal(f.c.questionForm, undefined);
    assert.equal(f.app.composer.focused, true);
    assert.match(screen(), /keep this unsent reply/);
    assert.equal(session.status, "needs-input");
    assert.equal(f.engine.calls.length, 0);
    f.c.showQuestions();
    assert.equal(f.tui.hasOverlay(), false);
    assert.match(screen(), /custom answer draft/);
    f.c.back();
    assert.doesNotMatch(screen(), /Question 1 of 4/);
    f.c.open();
    assert.match(screen(), /custom answer draft/);
  } finally { await f.cleanup(); }
});

test("Tab and Shift+Tab still navigate the question wizard after shortcut removal", async () => {
  const f = setup();
  const screen = () => { f.tui.renderNow(); return f.tui.getScreenLines().map(stripTerminalSequences).join("\n"); };
  try {
    const session = waitingSession(); session.projectId = f.pa.id;
    session.agent = { model: { provider: "test", modelId: "reasoner" }, thinkingLevel: "high" };
    f.store.state.sessions.push(session);
    f.c.select(`session:${session.id}`); f.c.open();
    const configuration = f.c.configuration;
    f.terminal.onInput(" "); f.terminal.onInput("\t");
    assert.match(screen(), /Question 2 of 4/);
    f.terminal.onInput("\x1b[B"); f.terminal.onInput("\r");
    assert.match(screen(), /Question 3 of 4/);
    f.terminal.onInput("\t"); f.terminal.onInput("\t");
    assert.match(screen(), /Review your answers/);
    assert.match(screen(), /You have not answered all questions/);
    f.terminal.onInput("\t");
    assert.equal(f.engine.calls.length, 0, "Tab on Submit does not send");
    f.terminal.onInput("\x1b[Z");
    assert.match(screen(), /Question 4 of 4/);
    f.terminal.onInput("\x1b[Z");
    assert.match(screen(), /Question 3 of 4/);
    f.terminal.onInput("\x1b[Z");
    assert.match(screen(), /Question 2 of 4/);
    assert.match(screen(), /Go/);
    assert.deepEqual(f.c.configuration, configuration, "Shift+Tab must not cycle thinking during questions");
    assert.equal(f.tui.hasOverlay(), false);
    assert.equal(f.app.composer.getValue(), "");
  } finally { await f.cleanup(); }
});

test("five choices and every description fit together in the composer without paging", async () => {
  const f = setup();
  try {
    f.terminal.columns = 80;
    for (const type of ["radio", "select", "multiselect"]) {
      for (const allowOther of [false, true]) {
        const options = Array.from({ length: allowOther ? 4 : 5 }, (_, i) => ({ value: String(i), label: `Option ${i + 1}`, description: `Description for option ${i + 1}` }));
        const session = waitingSession(`${type}-${allowOther}`); session.projectId = f.pa.id;
        session.messages[1]!.tool!.arguments = { question: "Pick features", questions: [{ id: "features", question: "Which features?", type, allowOther, options }] };
        f.store.state.sessions.push(session);
        f.c.select(`session:${session.id}`); f.c.open();
        for (const height of [24, 32]) {
          f.terminal.rows = height; f.terminal.onResize(); f.tui.renderNow();
          const lines = f.tui.getScreenLines().map(stripTerminalSequences);
          const text = lines.join("\n");
          for (const option of options) assert.match(text, new RegExp(`${option.label}\\s+${option.description}`));
          if (allowOther) assert.match(text, /5\. (?:\[ \] )?type something/);
          assert.doesNotMatch(text, /Filter|Search/);
          assert.ok(f.app.chatScroll.viewportHeight >= 1);
          assert.match(lines.at(-1)!, /test\/mock/);
          f.terminal.onInput("\x1b[B");
        }
        assert.equal(f.engine.calls.length, 0);
      }
    }
  } finally { await f.cleanup(); }
});

test("ask_question stays in chat with the normal composer and accepts an ordinary reply", async () => {
  const f = setup();
  const screen = () => { f.tui.renderNow(); return f.tui.getScreenLines().map(stripTerminalSequences).join("\n"); };
  try {
    const session = waitingSession("direct"); session.projectId = f.pa.id;
    session.messages[1]!.tool!.name = "ask_question";
    session.messages[1]!.tool!.arguments = { question: "Which file should I change?" };
    session.messages[1]!.tool!.output = "Which file should I change?";
    session.messages.at(-1)!.text = "Which file should I change?";
    f.store.state.sessions.push(session);
    f.c.select(`session:${session.id}`); f.c.open();
    assert.equal(f.c.questionForm, undefined);
    assert.equal(f.tui.hasOverlay(), false);
    assert.equal(f.app.composer.focused, true);
    assert.match(screen(), /Which file should I change/);
    assert.doesNotMatch(screen(), /Question 1 of|Review your answers|Submit answers/);
    f.c.back(); f.c.peek();
    assert.equal(f.c.dialog?.kind, "peek", "Peeking a direct question uses the ordinary reply peek");
    assert.equal(f.c.questionForm, undefined);
    f.terminal.onInput("\x1b"); f.c.open();
    f.app.composer.setValue("src/main.ts");
    f.c.showQuestions();
    assert.match(f.c.notice, /No pending question form/);
    assert.equal(f.app.composer.getValue(), "src/main.ts");
    f.terminal.onInput("\r"); await tick();
    assert.equal(f.engine.calls.length, 1);
    assert.equal(f.engine.calls[0]!.session.id, session.id);
    assert.equal(f.engine.calls[0]!.prompt, "src/main.ts");
  } finally { await f.cleanup(); }
});

test("a direct question removes an obsolete wizard and restores the unsent composer draft", async () => {
  const f = setup();
  try {
    const session = waitingSession("transition"); session.projectId = f.pa.id;
    session.status = "completed";
    f.store.state.sessions.push(session);
    f.c.select(`session:${session.id}`); f.c.open();
    f.app.composer.setValue("keep my draft");
    session.status = "needs-input"; f.c.changed();
    assert.ok(f.c.questionForm);
    assert.equal(f.app.composer.focused, false);
    session.messages.push({ role: "tool", text: "", timestamp: 3, tool: {
      id: "direct", name: "ask_question", arguments: { question: "Continue?" }, output: "Continue?", status: "done",
    } }, { role: "assistant", text: "Continue?", timestamp: 3 });
    f.c.changed();
    assert.equal(f.c.questionForm, undefined);
    assert.equal(f.app.composer.focused, true);
    assert.equal(f.app.composer.getValue(), "keep my draft");
    assert.equal(f.tui.hasOverlay(), false);
    assert.equal(f.engine.calls.length, 0);
  } finally { await f.cleanup(); }
});

test("$ autocomplete uses the engine catalog for the selected project and peek session without sending", async () => {
  const f = setup();
  const listed: string[] = [];
  f.engine.listSkills = async (project) => {
    listed.push(project.id);
    return [{ name: project.id === f.pa.id ? "alpha-skill" : "beta-skill", description: "Scoped skill", filePath: "/skills/SKILL.md" }];
  };
  try {
    for (const project of [f.pa, f.pb]) {
      f.c.select(`project:${project.id}`);
      f.app.composer.setValue("");
      f.terminal.onInput("$");
      for (let i = 0; i < 100 && !f.app.composer.showingSuggestions; i++) await delay(20);
      assert.equal(f.app.composer.showingSuggestions, true);
      f.terminal.onInput("\r");
      assert.equal(f.app.composer.getValue(), project.id === f.pa.id ? "$alpha-skill " : "$beta-skill ");
      assert.equal(f.store.state.sessions.length, 0);
      assert.equal(listed.at(-1), project.id);
    }
    f.app.composer.setValue("");
    f.c.send("create peek session"); await tick(); f.c.peek();
    const peek = f.tui.getFocusedComponent() as unknown as { input: Composer };
    assert.ok(peek.input instanceof Composer);
    peek.input.handleInput("$");
    for (let i = 0; i < 100 && !peek.input.showingSuggestions; i++) await delay(20);
    assert.equal(peek.input.showingSuggestions, true);
    peek.input.handleInput("\r");
    assert.equal(peek.input.getValue(), "$beta-skill ");
    assert.equal(listed.at(-1), f.pb.id);
    assert.equal(f.engine.calls.length, 1, "Accepting a skill must not send a reply");
  } finally { await f.cleanup(); }
});

test("session and peek checklists show live task state without dependency annotations, and dashboard rows show counts", async () => {
  const f = setup();
  try {
    f.c.send("Add password reset"); await tick();
    const session = f.store.state.sessions[0]!;
    session.tasks = [
      { id: "1", subject: "Inspect auth", status: "completed", blockedBy: [] },
      { id: "2", subject: "Implement reset", activeForm: "Implementing reset", status: "in_progress", blockedBy: ["1"] },
      { id: "3", subject: "Test reset", status: "pending", blockedBy: ["2"] },
    ];
    f.c.open(); f.c.changed(); f.tui.renderNow();
    const screen = () => f.tui.getScreenLines().map(stripTerminalSequences).join("\n");
    assert.match(screen(), /Tasks - 1\/3 complete/);
    assert.match(screen(), /\u2610 #2 Implementing reset/);
    assert.match(screen(), /\u2610 #3 Test reset/);
    assert.doesNotMatch(screen(), /blocked|blockedBy|depends/);
    session.tasks[1]!.status = "completed";
    session.tasks[2]!.status = "in_progress";
    f.c.changed(); f.tui.renderNow();
    assert.match(screen(), /Tasks - 2\/3 complete/);
    assert.match(screen(), /\u2610 #3 Test reset/);
    assert.doesNotMatch(screen(), /Implementing reset/);
    for (const width of [8, 16, 24, 80]) {
      for (const height of [12, 24, 32]) {
        f.terminal.columns = width; f.terminal.rows = height;
        f.terminal.onResize(); f.tui.renderNow();
        const lines = f.tui.getScreenLines().map(stripTerminalSequences);
        assert.equal(lines.length, height);
        assert.ok(lines.every((line) => visibleWidth(line) <= width));
        assert.ok(lines.some((line) => line.startsWith("Tasks")), `checklist at ${width}x${height}`);
        assert.ok(lines.at(-1)?.startsWith("test/"), "model status stays visible");
        assert.doesNotMatch(lines.join("\n"), /blockedBy|blocked by/);
      }
    }
    f.terminal.columns = 24; f.terminal.rows = 12; f.terminal.onResize();
    f.app.composer.setValue("draft line\n".repeat(5)); f.tui.renderNow();
    assert.doesNotMatch(screen(), /Tasks -/, "the checklist yields space to tall drafts");
    f.app.composer.setValue("");
    f.terminal.columns = 120; f.terminal.rows = 32; f.terminal.onResize();
    f.c.back(); f.c.select(`session:${session.id}`); f.c.changed(); f.tui.renderNow();
    assert.match(screen(), /2\/3 tasks/);
    assert.doesNotMatch(screen(), /Tasks -/);
    f.c.peek(); f.tui.renderNow();
    assert.match(screen(), /Tasks - 2\/3 complete/);
    assert.doesNotMatch(screen(), /blockedBy|blocked by/);
    f.terminal.onInput("/tasks"); f.terminal.onInput("\r"); f.tui.renderNow();
    assert.equal(f.c.dialog?.kind, "tasks");
    assert.match(screen(), /Session tasks/);
    f.terminal.onInput("\x1b");
    assert.equal(f.engine.calls.length, 1);
  } finally { await f.cleanup(); }
});

test("/tasks opens scoped, scrollable details without sending work, preserves drafts and refreshes live", async () => {
  const f = setup();
  const submit = () => f.app.composer.onSubmit?.("/tasks");
  const screen = () => { f.tui.renderNow(); return f.tui.getScreenLines().map(stripTerminalSequences).join("\n"); };
  try {
    submit();
    assert.equal(f.c.dialog, undefined);
    assert.match(f.c.notice, /Open or select a session/);
    assert.equal(f.engine.calls.length, 0);
    f.c.send("first"); await tick();
    const first = f.store.state.sessions[0]!;
    first.tasks = [
      { id: "1", subject: "First task", description: "First task requirements", status: "in_progress", blockedBy: [] },
      { id: "2", subject: "Next task", status: "pending", blockedBy: ["1"] },
    ];
    f.c.send("second"); await tick();
    const second = f.store.state.sessions.at(-1)!;
    f.c.select(`session:${first.id}`);
    f.app.composer.setValue("preserve my draft");
    submit();
    assert.equal((f.c as Controller).dialog?.kind, "tasks");
    assert.match(screen(), /Session tasks/);
    assert.match(screen(), /First task requirements/);
    assert.doesNotMatch(screen(), /blockedBy|blocked by/);
    assert.equal(f.app.composer.getValue(), "preserve my draft");
    first.tasks[0]!.status = "completed"; f.c.changed();
    assert.match(screen(), /Completed/);
    f.terminal.onInput("\x1b");
    f.c.select(`session:${second.id}`); f.c.open(); submit();
    assert.match(screen(), /No checklist tasks/);
    f.terminal.onInput("\x1b");
    f.c.back(); f.c.select(`session:${first.id}`); f.c.open();
    first.tasks = Array.from({ length: 25 }, (_, index) => ({
      id: String(index + 1), subject: `Checklist item ${index}`, description: `Requirements ${index}`, status: "pending", blockedBy: [],
    }));
    f.terminal.columns = 28; f.terminal.rows = 16; f.terminal.onResize(); submit();
    const initial = screen();
    for (let i = 0; i < 50; i++) f.terminal.onInput("\x1b[6~");
    assert.notEqual(screen(), initial);
    assert.match(screen(), /Requirements 24/);
    assert.ok(f.tui.getScreenLines().every((line) => visibleWidth(line) <= 28));
    f.terminal.onInput("\x1b");
    assert.equal(f.engine.calls.length, 2);
  } finally { await f.cleanup(); }
});

test("structured questions take precedence over checklist rows without changing task state", async () => {
  const f = setup();
  try {
    const session = waitingSession("checklist-question"); session.projectId = f.pa.id;
    session.tasks = [{ id: "1", subject: "Waiting for a decision", status: "in_progress", blockedBy: [] }];
    f.store.state.sessions.push(session);
    f.c.select(`session:${session.id}`); f.c.open(); f.c.changed(); f.tui.renderNow();
    assert.equal(f.c.questionForm?.sessionId, session.id);
    assert.doesNotMatch(f.tui.getScreenLines().map(stripTerminalSequences).join("\n"), /Tasks -/);
    assert.equal(session.tasks[0]?.status, "in_progress");
    f.terminal.onInput("\x1b"); f.tui.renderNow();
    assert.match(f.tui.getScreenLines().map(stripTerminalSequences).join("\n"), /Tasks - 0\/1 complete/);
    assert.equal(f.engine.calls.length, 0);
  } finally { await f.cleanup(); }
});

test("cleared checklists disappear from sessions, peeks and dashboard counts while /tasks shows an empty list", async () => {
  const f = setup();
  const screen = () => { f.tui.renderNow(); return f.tui.getScreenLines().map(stripTerminalSequences).join("\n"); };
  try {
    f.c.send("Finished checklist"); await tick();
    const session = f.store.state.sessions[0]!;
    const completed = [{ id: "1", subject: "Finished item", status: "completed" as const, blockedBy: [] }];
    session.tasks = completed; f.c.open(); f.c.changed();
    assert.match(screen(), /Tasks - 1\/1 complete/);
    session.tasks = undefined; f.c.changed();
    assert.doesNotMatch(screen(), /Tasks -|Finished item/);
    f.c.back(); f.c.select(`session:${session.id}`);
    session.tasks = completed; f.c.changed(); assert.match(screen(), /1\/1 tasks/);
    session.tasks = undefined; f.c.changed(); assert.doesNotMatch(screen(), /1\/1 tasks/);
    session.tasks = completed; f.c.peek(); assert.match(screen(), /Tasks - 1\/1 complete/);
    session.tasks = undefined; f.c.changed(); assert.doesNotMatch(screen(), /Tasks -|Finished item/);
    f.terminal.onInput("\x1b");
    session.tasks = completed; f.c.showTasks(); assert.match(screen(), /Finished item/);
    session.tasks = undefined; f.c.changed();
    assert.match(screen(), /No checklist tasks/);
    assert.doesNotMatch(screen(), /Finished item/);
    assert.equal(f.engine.calls.length, 1, "cleanup display updates never send a prompt");
  } finally { await f.cleanup(); }
});

test("/top and Ctrl+Home jump directly to the oldest output without sending work or losing drafts", async () => {
  const f = setup();
  try {
    f.c.send("long conversation"); await tick();
    const session = f.store.state.sessions[0]!;
    session.messages = Array.from({ length: 300 }, (_, i) => ({ role: "assistant", timestamp: i, text: `Reply ${i}` }));
    f.c.open(); f.tui.renderNow();
    assert.ok(f.app.scroll.scrollTop > 0);
    f.app.composer.setValue("/top"); f.terminal.onInput("\r"); f.tui.renderNow();
    assert.equal(f.app.scroll.scrollTop, 0);
    assert.equal(f.app.scroll.isFollowingEnd, false);
    assert.match(f.tui.getScreenLines().map(stripTerminalSequences).join("\n"), /Reply 0/);
    session.messages.push({ role: "assistant", timestamp: 301, text: "Live update" });
    f.c.changed(); f.tui.renderNow();
    assert.equal(f.app.scroll.scrollTop, 0);
    f.app.composer.setValue("/bottom"); f.terminal.onInput("\r"); f.tui.renderNow();
    assert.equal(f.app.scroll.isFollowingEnd, true);
    f.app.composer.setValue("keep this draft");
    f.terminal.onInput("\x1b[1;5H"); f.tui.renderNow();
    assert.equal(f.app.scroll.scrollTop, 0);
    assert.equal(f.app.composer.getValue(), "keep this draft");
    assert.equal(f.engine.calls.length, 1);
  } finally { await f.cleanup(); }
});

test("session wheel starts at three lines, Alt+wheel at fifteen, and dashboard keeps fine scrolling", async (t) => {
  const f = setup();
  t.mock.method(performance, "now", () => 0);
  try {
    f.c.send("long conversation"); await tick();
    const session = f.store.state.sessions[0]!;
    session.messages = Array.from({ length: 100 }, (_, i) => ({ role: "assistant", timestamp: i, text: `Reply ${i}` }));
    f.c.open(); f.tui.renderNow();
    const bottom = f.app.scroll.scrollTop;
    f.terminal.onInput("\x1b[<64;4;6M"); f.tui.renderNow();
    assert.equal(f.app.scroll.scrollTop, bottom - 3);
    f.terminal.onInput("\x1b[<65;4;6M"); f.tui.renderNow();
    assert.equal(f.app.scroll.scrollTop, bottom);
    assert.equal(f.app.scroll.isFollowingEnd, true);
    f.terminal.onInput("\x1b[<72;4;6M"); f.tui.renderNow();
    assert.equal(f.app.scroll.scrollTop, bottom - 15);
    f.app.scroll.scrollTo(1); f.tui.renderNow();
    f.terminal.onInput("\x1b[<64;4;6M"); f.tui.renderNow();
    assert.equal(f.app.scroll.scrollTop, 0);
    f.store.state.sessions.push(...Array.from({ length: 50 }, (_, i) => ({ ...session, id: `extra-${i}` })));
    f.c.back(); f.tui.renderNow();
    f.app.scroll.scrollTo(20); f.tui.renderNow();
    assert.equal(f.app.scroll.scrollTop, 20);
    f.terminal.onInput("\x1b[<64;4;6M"); f.tui.renderNow();
    assert.equal(f.app.scroll.scrollTop, 19);
  } finally { await f.cleanup(); }
});

test("fast session wheel gestures accelerate, preserve Alt scaling and reset between views", async (t) => {
  const f = setup();
  let now = 0;
  t.mock.method(performance, "now", () => now);
  try {
    f.c.send("long conversation"); await tick();
    const session = f.store.state.sessions[0]!;
    session.messages = Array.from({ length: 300 }, (_, i) => ({ role: "assistant", timestamp: i, text: `Reply ${i}` }));
    f.c.open(); f.tui.renderNow();
    const wheel = (time: number, button = 64) => {
      now = time;
      const before = f.app.scroll.scrollTop;
      f.terminal.onInput(`\x1b[<${button};4;6M`); f.tui.renderNow();
      return before - f.app.scroll.scrollTop;
    };
    assert.equal(wheel(0), 3);
    assert.equal(wheel(50), 6);
    assert.equal(wheel(100), 6);
    assert.equal(wheel(150, 72), 30, "Alt multiplies the accelerated distance by five");
    assert.equal(wheel(200, 65), -3, "Reversing direction restores the base speed");
    assert.equal(wheel(450, 65), -3, "A pause restores the base speed");
    assert.equal(wheel(500, 65), -6);
    f.app.scroll.scrollTo(2); f.tui.renderNow();
    assert.equal(wheel(750), 2, "Scrolling clamps to the start of the transcript");
    assert.equal(f.app.scroll.isFollowingEnd, false);
    f.app.composer.setValue("/bottom"); f.terminal.onInput("\r"); f.tui.renderNow();
    assert.equal(f.app.scroll.isFollowingEnd, true);
    f.store.state.sessions.push(...Array.from({ length: 50 }, (_, i) => ({ ...session, id: `accelerated-extra-${i}` })));
    f.c.back(); f.tui.renderNow();
    f.app.scroll.scrollTo(20); f.tui.renderNow();
    assert.equal(wheel(800), 1, "Dashboard scrolling never inherits chat acceleration");
    f.c.select(`session:${session.id}`); f.c.open(); f.tui.renderNow();
    assert.equal(wheel(850), 3, "A reopened chat starts a fresh gesture");
    f.c.showUsage(); f.tui.renderNow();
    assert.equal(wheel(900), 1, "Modal wheel input must not inherit chat acceleration");
    f.terminal.onInput("\x1b"); f.tui.renderNow();
    assert.equal(wheel(950), 3, "Dismissing a dialog starts a fresh gesture");
    assert.equal(f.engine.calls.length, 1);
  } finally { await f.cleanup(); }
});
