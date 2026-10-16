import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { CompactionResult as DurableCompactionResult, TaskId } from "@earendil-works/pi-durable";
import { stripTerminalSequences, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { Controller } from "../src/controller.js";
import { Composer } from "../src/composer.js";
import { rows, rowId, type CompactResult } from "../src/model.js";
import { Store } from "../src/store.js";
import { Dashboard, scrollToEndIndicator } from "../src/ui.js";
import { FakeEngine, FakeTerminal, temporary, tick } from "./helpers.js";

function setup() {
  const temp = temporary();
  const a = join(temp.root, "alpha"); const b = join(temp.root, "beta");
  mkdirSync(a); mkdirSync(b);
  const store = new Store(join(temp.root, "data"));
  const pa = store.addProject(a); const pb = store.addProject(b);
  const engine = new FakeEngine();
  const c = new Controller(store, engine);
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

test("Escape stops once and stays in the session; Left only goes back with an empty composer", async () => {
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
    assert.equal(f.app.composer.onSubmit?.("/stop"), true); await tick();
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
    assert.equal(f.app.composer.getValue(), "reply one\nreply two");
    assert.match(f.c.notice, /still working/);
    f.c.opened!.status = "completed";
    f.terminal.onInput("\r"); await tick();
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
    f.terminal.onInput("\x0f"); assert.equal(f.c.mode, "projects");
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
    f.terminal.onInput("\x14"); await tick(); // ctrl+t
    assert.equal(dialogKind(), "thinking");
    f.terminal.onInput("\x10"); f.terminal.onInput("\r"); await tick(); // wrap off -> high
    assert.equal(f.c.opened?.agent?.thinkingLevel, "high");
    assert.equal(f.engine.configuration().thinkingLevel, "off");
    f.terminal.onInput("draft reply"); f.terminal.onInput("\x0c"); await tick(); // ctrl+l
    f.terminal.onInput("mock"); f.terminal.onInput("\r"); await tick();
    assert.equal(f.c.opened?.agent?.model?.modelId, "mock");
    assert.equal(f.engine.configuration().model?.modelId, "reasoner");
    assert.equal(f.app.composer.getValue(), "draft reply");
    f.c.opened!.status = "working";
    assert.equal(await f.c.configure({ model: { provider: "test", modelId: "reasoner" } }, f.c.opened!.id), false);
    assert.match(f.c.notice, /finish/);
  } finally { await f.cleanup(); }
});

test("shift+tab cycles supported thinking levels without losing drafts, including during a run", async () => {
  const f = setup();
  try {
    await f.c.configure({ model: { provider: "test", modelId: "reasoner" } });
    f.terminal.onInput("keep this draft");
    f.terminal.onInput("\x1b[Z"); await tick();
    assert.equal(f.c.configuration.thinkingLevel, "low");
    f.terminal.onInput("\x1b[Z"); f.terminal.onInput("\x1b[Z"); await tick();
    assert.equal(f.c.configuration.thinkingLevel, "off");
    assert.equal(f.app.composer.getValue(), "keep this draft");
    assert.equal(f.c.dialog, undefined);
    f.app.composer.setValue(""); f.c.send("start"); await tick(); f.c.open();
    f.c.opened!.status = "working";
    f.terminal.onInput("\x1b[Z"); await tick();
    assert.equal(f.c.opened?.agent?.thinkingLevel, "low");
    assert.equal(f.engine.configuration().thinkingLevel, "off");
    assert.match(f.c.notice, /next model request/);
  } finally { await f.cleanup(); }
});

test("skills picker fills an explicit skill command without creating a session", async () => {
  const f = setup();
  try {
    f.terminal.onInput("/skills"); f.terminal.onInput("\r"); await tick();
    assert.equal(f.c.dialog?.kind, "skills");
    f.terminal.onInput("test"); f.terminal.onInput("\r"); await tick();
    assert.equal(f.app.composer.getValue(), "/skill:testing ");
    assert.equal(f.store.state.sessions.length, 0);
    f.terminal.onInput("check these tests"); f.terminal.onInput("\r"); await tick();
    assert.equal(f.engine.calls.at(-1)?.prompt, "/skill:testing check these tests");
    assert.equal(f.engine.calls.at(-1)?.project.id, f.pb.id);
  } finally { await f.cleanup(); }
});

test("chat follows output only at the end and offers clickable and keyboard jump-to-bottom controls", async () => {
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
    f.terminal.onInput("\x1b[1;5F"); f.tui.renderNow();
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

test("transcript wraps user messages in light grey without speaker labels or agent backgrounds", async () => {
  const f = setup();
  try {
    f.c.send("inspect project"); await tick(); f.c.open();
    const session = f.c.opened!;
    session.messages = [
      { role: "user", text: "Please inspect **this project**\n\n日本語 🧑‍💻", timestamp: 1 },
      { role: "assistant", text: "Here is the **summary**.", timestamp: 2 },
      { role: "error", text: "Something failed", timestamp: 3 },
    ];
    const background = "\x1b[48;2;238;238;238m";
    const transcript = f.app.body.transcript;
    for (const width of [1, 4, 10, 24, 50, 120]) {
      const lines = transcript.render(width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      if (width < 10) continue;
      const userLines = lines.filter((line) => line.includes(background));
      assert.ok(userLines.length >= 4);
      for (const line of userLines) {
        assert.ok(line.startsWith(`  ${background}`));
        assert.ok(line.endsWith("\x1b[49m"));
        assert.equal(visibleWidth(line), width - 2);
      }
      assert.equal(stripTerminalSequences(userLines[0]!).trim(), "");
      assert.equal(stripTerminalSequences(userLines.at(-1)!).trim(), "");
      assert.doesNotMatch(lines.map(stripTerminalSequences).join("\n"), /^\s*(You|Agent)\s*$/m);
    }
    const lines = transcript.render(120);
    assert.match(lines.find((line) => line.includes("Please inspect"))!, /\x1b\[38;2;32;32;32m/);
    assert.equal(lines.find((line) => line.includes("Here is"))?.includes(background), false);
    assert.match(lines.map(stripTerminalSequences).join("\n"), /Here is the summary\.[\s\S]*Error\n  Something failed/);
    session.messages[1]!.text += " More detail.";
    assert.match(transcript.render(120).map(stripTerminalSequences).join("\n"), /More detail\./);
    // Replacing a projected message must not reuse styling from its previous role.
    session.messages[0]!.role = "assistant";
    assert.ok(transcript.render(120).every((line) => !line.includes(background)));
  } finally { await f.cleanup(); }
});

test("tool and skill activity is collapsed, keyboard and mouse expandable, and stable across updates", async () => {
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
    assert.match(render(), /\[\+\] Skill frontend-design/);
    assert.doesNotMatch(render(), /skill instructions|Tests passed/);
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
    assert.doesNotMatch(render(), /skill instructions|Tests passed/);
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
      if (mode === "projects") f.terminal.onInput("\x0f");
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
      if (mode === "projects") f.terminal.onInput("\x0f");
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
    for (const command of ["/session", "/compact", "/stop", "/bottom", "/expand", "/collapse"]) await expectSuggestion(command, false);
    for (const command of ["/model", "/thinking", "/skills", "/help"]) await expectSuggestion(command, true);
    f.c.select(`session:${session.id}`);
    assert.equal(f.app.composer.showingSuggestions, false, "Selection changes dismiss the old menu");
    for (const command of ["/session", "/compact", "/stop"]) await expectSuggestion(command, true);
    await expectSuggestion("/bottom", false);
    f.c.open();
    for (const command of ["/session", "/compact", "/stop", "/bottom", "/expand", "/collapse"]) await expectSuggestion(command, true);
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
    f.terminal.onInput("\x1b");
    return text;
  };
  try {
    f.terminal.rows = 100; f.terminal.onResize();
    const project = help();
    assert.match(project, /Commands: Dashboard \(project selected\)/);
    assert.match(project, /\/model\s+Choose the model for new tasks/);
    assert.doesNotMatch(project, /\|\s*\/(session|compact|stop|bottom|expand|collapse)\s/);
    f.c.send("task"); await tick();
    const selected = help();
    assert.match(selected, /Commands: Dashboard \(session selected\)/);
    assert.match(selected, /\/compact\s+Summarize older context in the selected session/);
    assert.doesNotMatch(selected, /\|\s*\/(bottom|expand|collapse)\s/);
    f.c.open();
    const open = help();
    assert.match(open, /Commands: Open session/);
    assert.match(open, /\/model\s+Choose this session's model/);
    for (const command of ["bottom", "expand", "collapse"]) assert.match(open, new RegExp(`\\|\\s*\\/${command}\\s`));
    assert.equal(f.engine.calls.length, 1);
  } finally { await f.cleanup(); }
});

test("manually entered transcript commands on the dashboard do not start agent tasks", async () => {
  const f = setup();
  try {
    for (const command of ["/bottom", "/expand", "/collapse"]) {
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
    const border = stripTerminalSequences(f.app.composer.render(116).at(-1)!).trim();
    const bottom = lines.findLastIndex((line) => line.trim() === border);
    assert.ok(bottom >= 0);
    return lines.slice(bottom + 1).map((line) => line.trim()).filter(Boolean);
  };
  try {
    const idle = "test/mock · off · ?/100k · ◉ ? · cost ?";
    assert.deepEqual(belowComposer(), [idle]);
    assert.equal(render().filter((line) => line.includes("test/mock")).length, 1, "Model appears only below the composer");
    assert.doesNotMatch(render().join("\n"), /shortcuts|ctrl\+l model|shift\+tab cycle|ctrl\+j newline/);
    f.terminal.onInput("?");
    assert.equal(Boolean(f.c.dialog), false);
    assert.equal(f.app.composer.getValue(), "?", "Question marks are now ordinary draft text, even at the start");
    assert.deepEqual(belowComposer(), [idle]);
    assert.equal(f.engine.calls.length, 0);
    f.app.composer.setValue("");
    f.c.send("task"); await tick(); f.c.open();
    f.c.opened!.context = { tokens: 1234 };
    f.c.opened!.agent = { model: { provider: "test", modelId: "reasoner" }, thinkingLevel: "high" };
    const active = "test/reasoner · high · ░░░░░░░░ ~1%/100k · ◉ ? · cost ?";
    assert.deepEqual(belowComposer(), [active]);
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
    assert.equal(f.app.composer.onSubmit?.("/compact"), true);
    assert.match(f.c.notice, /Open or select a session/);
    assert.equal(f.engine.compactions.length, 0);
    f.c.send("first task"); await tick();
    const first = f.store.state.sessions[0]!;
    f.c.send("second task"); await tick();
    const second = f.store.state.sessions[1]!;
    const calls = f.engine.calls.length;
    f.c.select(`session:${first.id}`);
    assert.equal(f.app.composer.onSubmit?.("/compact keep exact paths\nand pending tests"), true);
    await tick();
    assert.equal(f.engine.compactions[0]?.session.id, first.id);
    assert.equal(f.engine.compactions[0]?.instructions, "keep exact paths\nand pending tests");
    assert.match(f.c.notice, /Context compacted/);
    f.c.open();
    f.c.selection = `session:${second.id}`;
    assert.equal(f.app.composer.onSubmit?.("/compact"), true); await tick();
    assert.equal(f.engine.compactions[1]?.session.id, first.id, "open session takes precedence over list selection");
    assert.equal(f.engine.compactions[1]?.instructions, undefined);
    assert.equal(f.engine.calls.length, calls);
    assert.equal(f.store.state.sessions.length, 2);
  } finally { await f.cleanup(); }
});

test("compaction activity supports Escape cancellation without marking an idle session stopped", async () => {
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
    f.c.escape(); await tick();
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
