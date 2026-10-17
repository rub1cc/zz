import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { stripTerminalSequences, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import type { ConversationView } from "@earendil-works/pi-durable";
import { Controller } from "../src/controller.js";
import { applyView } from "../src/engine.js";
import type { Message, Session, ToolActivity } from "../src/model.js";
import { Store } from "../src/store.js";
import { Transcript, workLabel } from "../src/transcript.js";
import { Dashboard } from "../src/ui.js";
import { image } from "./image-fixtures.js";
import { FakeEngine, FakeTerminal, temporary } from "./helpers.js";

function setup() {
  const temp = temporary();
  const store = new Store(join(temp.root, "data"));
  const project = store.addProject(temp.root);
  const session: Session = { id: "rendering", projectId: project.id, title: "Rendering", status: "completed", preview: "", createdAt: 1, updatedAt: 1, messages: [] };
  store.state.sessions.push(session);
  const controller = new Controller(store, new FakeEngine());
  controller.mode = "session"; controller.openedSessionId = session.id;
  const transcript = new Transcript(controller, () => {});
  const render = (width = 100) => transcript.render(width).map(stripTerminalSequences).map((line) => line.trimEnd()).join("\n");
  return { ...temp, store, session, controller, transcript, render,
    async close() { await controller.close(); temp.cleanup(); } };
}
const toolMessage = (tool: ToolActivity): Message => ({ role: "tool", text: "", timestamp: 3, tool });

test("the complete sample conversation renders as prompt, thinking, tools, edits, write, tests and final reply", async () => {
  const f = setup();
  try {
    f.session.messages = [
      { role: "user", text: "Fix greet() for empty names and add a test.", timestamp: 1 },
      { role: "thinking", text: "", thinking: { id: "thinking:one" }, timestamp: 2 },
      { role: "assistant", text: "I'll check the function and add a test.", timestamp: 2 },
      toolMessage({ id: "read", name: "read", arguments: { path: "src/greet.ts" }, status: "done", output: "export function greet(name) {\n  return name;\n}\n" }),
      toolMessage({ id: "edit", name: "edit", arguments: { path: "src/greet.ts" }, status: "done", output: "Successfully replaced 1 block(s).",
        details: { result: { diff: ' 1 export function greet(name) {\n-2   return name;\n+2   return name || "World";\n 3 }' } } }),
      toolMessage({ id: "write", name: "write", arguments: { path: "src/greet.test.ts", content: 'test("empty name", () => {\n  expect(greet("")).toBe("World");\n});\n' }, status: "done", output: "Successfully wrote to src/greet.test.ts" }),
      toolMessage({ id: "bash", name: "bash", arguments: { command: "npm test -- --run" }, status: "done", output: "1 test passed" }),
      { role: "assistant", text: 'Updated greet() to fall back to "World".\n\nTests: **1 passed**.', timestamp: 4 },
    ];
    const before = structuredClone(f.session.messages);
    assert.equal(f.render(), [
      "\u276f Fix greet() for empty names and add a test.", "", "\u273b Thinking", "",
      "\u25cf I'll check the function and add a test.", "", "\u25cf Read(src/greet.ts)", "  \u23bf Read 3 lines", "",
      "\u25cf Update(src/greet.ts)", "  \u23bf Added 1 line, removed 1 line", "     1 export function greet(name) {",
      "    -2   return name;", '    +2   return name || "World";', "     3 }", "",
      "\u25cf Write(src/greet.test.ts)", "  \u23bf Wrote 3 lines", '      1 test("empty name", () => {',
      '      2   expect(greet("")).toBe("World");', "      3 });", "",
      "\u25cf Bash", "  \u23bf Ran 1 shell command (/expand)", "",
      '\u25cf Updated greet() to fall back to "World".', "", "  Tests: 1 passed.", "",
    ].join("\n"));
    assert.deepEqual(f.session.messages, before, "Rendering is presentation only");
  } finally { await f.close(); }
});

test("all code changes survive collapse, clicks, routine grouping and session switches", async () => {
  const f = setup();
  try {
    const diff = [
      ...Array.from({ length: 12 }, (_, i) => ` ${i + 1} unchanged${i + 1}`),
      "-13 removedFirst", "+13 addedFirst", "...", "-99 removedLast", "+99 addedLast",
    ].join("\n");
    const content = Array.from({ length: 30 }, (_, i) => `written${i + 1}`).join("\n");
    f.session.messages = [
      ...["read1", "read2"].map((id) => toolMessage({ id, name: "read", arguments: { path: id }, status: "done", output: "read" })),
      toolMessage({ id: "edit", name: "edit", arguments: { path: "changed.ts" }, status: "done", output: "Updated", details: { result: { diff } } }),
      toolMessage({ id: "write", name: "write", arguments: { path: "written.ts", content }, status: "done", output: "Written" }),
    ];
    const before = structuredClone(f.session.messages);
    const assertCodeVisible = () => {
      const text = f.render();
      for (const source of [...diff.split("\n"), ...content.split("\n")]) assert.ok(text.includes(source), source);
      assert.doesNotMatch(text, /more \(\/expand\)/);
    };
    assertCodeVisible();
    assert.match(f.render(), /Read 2 files/);
    for (const expanded of [true, false, true, false]) {
      f.transcript.toggleAll(expanded);
      assertCodeVisible();
    }
    const y = f.transcript.positions.get("write")! + 2;
    const event = { type: "click", button: "left", x: 4, y, screenX: 4, screenY: y, width: 100, height: 32, shift: false, ctrl: false, alt: false } as const;
    for (let i = 0; i < 2; i++) {
      assert.equal(f.transcript.handleMouse(event)?.handled, true);
      assertCodeVisible();
    }
    for (const width of [1, 4, 12, 24, 80]) {
      const lines = f.transcript.render(width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      const unwrapped = lines.map(stripTerminalSequences).join("").replace(/\s/g, "");
      assert.ok(unwrapped.includes("addedLast"));
      assert.ok(unwrapped.includes("written30"));
    }
    f.session.messages = structuredClone(before);
    assertCodeVisible();
    const other = { ...structuredClone(f.session), id: "other-code" };
    f.store.state.sessions.push(other); f.controller.openedSessionId = other.id;
    assertCodeVisible();
    assert.deepEqual(f.session.messages, before);
  } finally { await f.close(); }
});

test("streaming projection updates one tool card and preserves expansion across durable replacements", async () => {
  const f = setup();
  const call = { id: 1, model: [{ role: "assistant", timestamp: 2, content: [{ type: "toolCall", id: "run", name: "bash", arguments: { command: "npm test" } }] }] };
  const project = (entries: unknown[], live: unknown) => applyView(f.session, { entries, docs: { "pi.live": live } } as unknown as ConversationView);
  try {
    project([call], { run: { taskId: 1 } });
    assert.match(f.render(), /Bash[^]*Pending/);
    f.transcript.move(1); f.transcript.toggle();
    project([call], { run: { taskId: 1 }, tools: [{ callId: "run", name: "bash", status: "running", output: "PASS first" }] });
    assert.match(f.render(), /Running[^]*Arguments[^]*PASS first/);
    project([call, { id: 2, model: [{ role: "toolResult", toolCallId: "run", toolName: "bash", timestamp: 3, isError: false, content: [{ type: "text", text: "PASS first\nPASS second" }] }] }], {});
    assert.equal(f.render().match(/Bash/g)?.length, 1);
    assert.match(f.render(), /Arguments[^]*PASS second/);
    project([call], {});
    assert.match(f.render(), /Interrupted; completion not confirmed/);
  } finally { await f.close(); }
});

test("Markdown, streaming text, image-only messages, legacy tools, and errors remain readable at all widths", async () => {
  const f = setup();
  try {
    f.session.messages = [
      { role: "user", text: "**literal**\n\t\u65e5\u672c\u8a9e \ud83d\ude00\x1b[2J", timestamp: 1 },
      { role: "assistant", text: "# Heading\n\n- Item\n\n> Quote\n\n```ts\nconst hello = 1;\n```\n\n| Name | State |\n| --- | --- |\n| greet | ready |\n\n[Docs](https://example.com)", timestamp: 2 },
      { role: "user", text: "", images: [image], timestamp: 3 },
      { role: "assistant", text: "", images: [image], timestamp: 4 },
      { role: "tool", text: "legacy output", timestamp: 5 },
      { role: "error", text: "Provider unavailable\x1b[2J", timestamp: 6 },
    ];
    for (const width of [1, 2, 4, 8, 12, 24, 80, 120]) {
      const lines = f.transcript.render(width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      assert.ok(lines.every((line) => !line.includes("\x1b[2J")));
    }
    const text = f.render();
    for (const token of ["**literal**", "Heading", "Item", "Quote", "const hello = 1;", "greet", "Docs", "image", "legacy output", "Provider unavailable"]) assert.ok(text.includes(token), token);
    f.session.messages[1]!.text = "Partial answer";
    assert.match(f.render(), /\u25cf Partial answer/);
    f.session.messages[1]!.text += " now complete.";
    assert.match(f.render(), /Partial answer now complete/);
    f.session.messages[1]!.text = "";
    assert.doesNotMatch(f.render(), /Partial answer/);
  } finally { await f.close(); }
});

test("thinking redaction, display settings, retry, cancellation, waiting and queue states are distinct", async () => {
  const f = setup();
  try {
    f.session.status = "working"; f.session.preview = "Thinking...";
    assert.match(stripTerminalSequences(workLabel(f.session)!), /Thinking/);
    f.session.preview = "Retrying: rate limit\x1b[2J";
    assert.match(f.render(), /Retrying: rate limit/);
    assert.doesNotMatch(f.render(), /\x1b\[2J/);
    f.session.stopped = true;
    assert.match(f.render(), /Stopping/);
    f.session.status = "paused";
    assert.match(f.render(), /Stopped\. Reply to continue/);
    delete f.session.stopped;
    assert.match(f.render(), /Paused\. Reply to continue/);
    f.session.status = "needs-input";
    assert.match(f.render(), /Waiting for your answer/);
    f.session.messages = [{ role: "thinking", text: "visible reasoning", thinking: { id: "thinking:one" }, timestamp: 1 },
      { role: "thinking", text: "NEVER_DISPLAY", thinking: { id: "thinking:redacted", redacted: true }, timestamp: 2 }];
    assert.match(f.render(), /visible reasoning[^]*Thinking \(redacted\)/);
    assert.doesNotMatch(f.render(), /NEVER_DISPLAY/);
    f.transcript.toggleAll(false); assert.doesNotMatch(f.render(), /visible reasoning/);
    f.transcript.toggleAll(true); assert.match(f.render(), /visible reasoning/);
    f.store.state.settings = { replyBehavior: "followUp", showThinking: false };
    assert.doesNotMatch(f.render(), /Thinking|visible reasoning/);
    f.session.queuedInputs = [{ id: 1, text: "Later task", mode: "followUp" }, { id: 2, text: "Change direction", mode: "steer", imageCount: 1 }];
    assert.match(f.render(), /Queued messages \(2\)[^]*\[follow-up\] Later task[^]*\[steer\] Change direction \[1 image\]/);
  } finally { await f.close(); }
});

test("preview clicks toggle full tool details and expansion resets on session changes", async () => {
  const f = setup();
  try {
    f.session.messages = [toolMessage({ id: "call", name: "bash", arguments: { command: "npm test" }, status: "done", output: "result" })];
    f.render();
    const y = f.transcript.positions.get("call")! + 1;
    const event = { type: "click", button: "left", x: 4, y, screenX: 4, screenY: y, width: 100, height: 32, shift: false, ctrl: false, alt: false } as const;
    assert.equal(f.transcript.handleMouse(event)?.handled, true);
    assert.match(f.render(), /Arguments/);
    const other = { ...structuredClone(f.session), id: "other" };
    f.store.state.sessions.push(other); f.controller.openedSessionId = other.id;
    assert.doesNotMatch(f.render(), /Arguments/);
    f.controller.openedSessionId = undefined;
    assert.deepEqual(f.transcript.render(100), []);
  } finally { await f.close(); }
});

test("the full TUI preserves prompt text, cursor markers, borders, scrolling and resize layout", async () => {
  const f = setup(); const terminal = new FakeTerminal(); const tui = new TuiAltScreen(terminal);
  try {
    const app = new Dashboard(f.controller, tui, () => {});
    tui.setLayoutRoot(app); tui.setFocus(app); tui.start(); app.sync();
    f.session.messages = Array.from({ length: 40 }, (_, i) => ({ role: "assistant", text: `Reply ${i}`, timestamp: i }));
    app.composer.setValue("keep this prompt");
    for (const width of [12, 24, 80, 120]) {
      for (const height of [12, 24, 40]) {
        terminal.columns = width; terminal.rows = height; terminal.onResize(); tui.renderNow();
        const lines = tui.getScreenLines();
        assert.equal(lines.length, height);
        assert.ok(lines.every((line) => visibleWidth(line) <= width));
        assert.equal(app.composer.getValue(), "keep this prompt");
      }
    }
    const text = tui.getScreenLines().map(stripTerminalSequences).join("\n");
    assert.match(text, /\u276f keep this prompt/);
    assert.match(text, /Reply 39/);
    assert.ok(app.composer.render(80).some((line) => line.includes("\x1b_pi:c")), "The editor must retain its hardware cursor marker");
  } finally { tui.stop(); await f.close(); }
});
