import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { Markdown, stripTerminalSequences, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
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
      "\u276f Fix greet() for empty names and add a test.", "",
      "\u25cf I'll check the function and add a test.", "", "  Read 1 file", "",
      "\u2022 Update(src/greet.ts)", "  \u23bf Added 1 line, removed 1 line", "     1 export function greet(name) {",
      "    -2   return name;", '    +2   return name || "World";', "     3 }", "",
      "\u2022 Write(src/greet.test.ts)", "  \u23bf Wrote 3 lines", '      1 test("empty name", () => {',
      '      2   expect(greet("")).toBe("World");', "      3 });", "",
      "  Ran 1 shell command", "",
      '\u25cf Updated greet() to fall back to "World".', "", "  Tests: 1 passed.", "",
    ].join("\n"));
    assert.deepEqual(f.session.messages, before, "Rendering is presentation only");
  } finally { await f.close(); }
});

test("diffs default to full, local clicks collapse only that diff and global controls override", async () => {
  const f = setup();
  try {
    const diff = Array.from({ length: 40 }, (_, i) => `+${i + 1} added${i + 1}`).join("\n");
    const content = Array.from({ length: 30 }, (_, i) => `written${i + 1}`).join("\n");
    f.session.messages = [
      toolMessage({ id: "edit", name: "edit", arguments: { path: "changed.ts" }, status: "done", output: "Updated", details: { result: { diff } } }),
      toolMessage({ id: "write", name: "write", arguments: { path: "written.ts", content }, status: "done", output: "Written" }),
    ];
    const before = structuredClone(f.session.messages);
    assert.match(f.render(), /added40/);
    assert.doesNotMatch(f.render(), /written30/);
    f.transcript.move(1); f.transcript.toggle();
    assert.doesNotMatch(f.render(), /added40/);
    assert.match(f.render(), /more rows/);
    f.render(24); f.render(120);
    assert.doesNotMatch(f.render(), /added40/);
    f.transcript.toggle(); assert.match(f.render(), /added40/);
    f.transcript.toggleAll(true); assert.match(f.render(), /added40[^]*written30/);
    f.transcript.toggleAll(false); assert.doesNotMatch(f.render(), /added40|written30/);
    for (const width of [1, 4, 12, 24, 80]) assert.ok(f.transcript.render(width).every(line => visibleWidth(line) <= width));
    const other = { ...structuredClone(f.session), id: "other-code" };
    f.store.state.sessions.push(other); f.controller.openedSessionId = other.id;
    assert.match(f.render(), /added40/);
    assert.doesNotMatch(f.render(), /written30/);
    assert.deepEqual(f.session.messages, before);
  } finally { await f.close(); }
});

test("streaming projection updates one tool card and preserves expansion across durable replacements", async () => {
  const f = setup();
  const call = { id: 1, model: [{ role: "assistant", timestamp: 2, content: [{ type: "toolCall", id: "run", name: "bash", arguments: { command: "npm test" } }] }] };
  const project = (entries: unknown[], live: unknown) => applyView(f.session, { entries, docs: { "pi.live": live } } as unknown as ConversationView);
  try {
    project([call], { run: { taskId: 1 } });
    assert.match(f.render(), /Waiting to run npm test/);
    f.transcript.move(1); f.transcript.toggle(); f.render(); f.transcript.move(1); f.transcript.toggle();
    project([call], { run: { taskId: 1 }, tools: [{ callId: "run", name: "bash", status: "running", output: "PASS first" }] });
    assert.match(f.render(), /Running[^]*Arguments[^]*PASS first/);
    project([call, { id: 2, model: [{ role: "toolResult", toolCallId: "run", toolName: "bash", timestamp: 3, isError: false, content: [{ type: "text", text: "PASS first\nPASS second" }] }] }], {});
    assert.equal(f.render().match(/Bash/g)?.length, 1);
    assert.match(f.render(), /Arguments[^]*PASS second/);
    project([call], {});
    assert.match(f.render(), /Interrupted; completion not confirmed/);
  } finally { await f.close(); }
});

test("live shell previews expose streaming tails and retain them through settlement", async () => {
  const f = setup();
  try {
    const tool: ToolActivity = { id: "run", name: "bash", arguments: { command: "npm test" },
      status: "running", output: "FIRST_RESULT\nsecond\nthird\nFULL_TAIL" };
    f.session.status = "working";
    f.session.messages = [toolMessage(tool)];
    assert.match(f.render(), /Running npm test[^]*second[^]*third[^]*FULL_TAIL/);
    assert.doesNotMatch(f.render(), /FIRST_RESULT/);
    tool.status = "done"; tool.durationMs = 6900;
    assert.match(f.render(), /Running npm test[^]*FULL_TAIL/);
    assert.doesNotMatch(f.render(), /Ran 1 shell command/);
    f.transcript.toggleAll(true);
    assert.match(f.render(), /Arguments[^]*FULL_TAIL/);
    f.transcript.toggleAll(false);
    assert.match(f.render(), /FULL_TAIL/);
    tool.status = "interrupted";
    assert.match(f.render(), /Interrupted; completion not confirmed/);
    assert.doesNotMatch(f.render(), /FIRST_RESULT/);
    assert.match(f.render(), /FULL_TAIL/);
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

test("empty thinking never creates headings or navigation targets, but redacted placeholders remain", async () => {
  const f = setup();
  try {
    f.session.messages = [
      { role: "thinking", text: "", timestamp: 1, thinking: { id: "thinking:empty" } },
      { role: "thinking", text: " \t\n\x1b[2J", timestamp: 2, thinking: { id: "thinking:blank" } },
      { role: "assistant", text: "Visible reply", timestamp: 3 },
    ];
    const original = structuredClone(f.session.messages);
    assert.equal(f.render(), "\u25cf Visible reply\n");
    assert.equal(f.transcript.positions.size, 0);
    f.transcript.toggleAll(true);
    assert.doesNotMatch(f.render(), /Thinking/);
    assert.deepEqual(f.session.messages, original);
    f.session.messages[0]!.text = "Streaming reasoning";
    assert.match(f.render(), /Thinking[^]*Streaming reasoning/);
    f.transcript.move(1);
    assert.equal(f.transcript.selected, "thinking:empty");
    f.session.messages[0]!.text = "";
    assert.doesNotMatch(f.render(), /Thinking/);
    assert.equal(f.transcript.selected, undefined);
    f.session.messages[0]!.thinking!.redacted = true;
    f.session.messages[0]!.text = "NEVER_DISPLAY";
    assert.match(f.render(), /Thinking \(redacted\)[^]*Thinking was redacted by the provider/);
    assert.doesNotMatch(f.render(), /NEVER_DISPLAY/);
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
    let y = f.transcript.positions.get("group:call")!;
    const event = { type: "click", button: "left", x: 4, y, screenX: 4, screenY: y, width: 100, height: 32, shift: false, ctrl: false, alt: false } as const;
    assert.equal(f.transcript.handleMouse(event)?.handled, true);
    assert.doesNotMatch(f.render(), /Arguments/);
    y = f.transcript.positions.get("call")!;
    assert.equal(f.transcript.handleMouse({ ...event, y })?.handled, true);
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

test("scroll-only TUI frames reuse formatted history and preserve tool click targets", async (t) => {
  const f = setup(); const terminal = new FakeTerminal(); const tui = new TuiAltScreen(terminal);
  try {
    f.session.messages = Array.from({ length: 100 }, (_, i) => ({ role: "assistant", text: `Reply ${i}`, timestamp: i }));
    f.session.messages.push(toolMessage({ id: "last-tool", name: "bash", arguments: { command: "npm test" }, status: "done", output: "PASS" }));
    const app = new Dashboard(f.controller, tui, () => {});
    tui.setLayoutRoot(app); tui.setFocus(app); tui.start(); app.sync(); tui.renderNow();
    const clear = t.mock.method(app.body.transcript.positions, "clear");
    const positions = [...app.body.transcript.positions];
    const bottom = app.chatScroll.scrollTop;
    const screen = tui.getScreenLines();
    for (let i = 0; i < 10; i++) {
      terminal.onInput("\x1b[<64;5;10M");
      tui.renderNow();
    }
    assert.ok(app.chatScroll.scrollTop < bottom);
    assert.notDeepEqual(tui.getScreenLines(), screen);
    assert.equal(clear.mock.callCount(), 0, "Scrolling must not rebuild history or its hit map");
    assert.deepEqual([...app.body.transcript.positions], positions);
    app.chatScroll.scrollToEnd(); tui.renderNow();
    const y = app.body.transcript.positions.get("group:last-tool")!;
    app.body.transcript.handleMouse({ type: "click", button: "left", x: 4, y, screenX: 4, screenY: y, width: 120, height: 32, shift: false, ctrl: false, alt: false });
    tui.renderNow();
    const memberY = app.body.transcript.positions.get("last-tool")!;
    app.body.transcript.handleMouse({ type: "click", button: "left", x: 4, y: memberY, screenX: 4, screenY: memberY, width: 120, height: 32, shift: false, ctrl: false, alt: false });
    tui.renderNow();
    assert.match(tui.getScreenLines().map(stripTerminalSequences).join("\n"), /Arguments[^]*PASS/);
    assert.equal(clear.mock.callCount(), 2);
  } finally { tui.stop(); await f.close(); }
});

test("history cache detects nested mutations, shell streaming, resize and explicit invalidation", async (t) => {
  const f = setup();
  try {
    const details = { result: { diff: "-1 old\n+1 first" } };
    f.session.messages = [toolMessage({ id: "edit", name: "edit", arguments: { path: "a.ts" }, status: "done", output: "Updated", details })];
    assert.match(f.render(), /first/);
    const clear = t.mock.method(f.transcript.positions, "clear");
    assert.match(f.render(), /first/);
    assert.equal(clear.mock.callCount(), 0);
    details.result.diff = "-1 first\n+1 second";
    assert.match(f.render(), /second/);
    assert.equal(clear.mock.callCount(), 1);
    f.session.messages = structuredClone(f.session.messages);
    f.render();
    assert.equal(clear.mock.callCount(), 1, "Equivalent durable projections should reuse history");
    f.session.shellResponses = [{ id: "shell", command: "echo hello", cwd: "/tmp", text: "partial", timestamp: 4, updatedAt: 4,
      status: "running", droppedBytes: 0, droppedLines: 0 }];
    assert.match(f.render(), /partial[^]*Shell running/);
    Object.assign(f.session.shellResponses[0]!, { text: "finished", status: "done", exitCode: 0, updatedAt: 5 });
    assert.match(f.render(), /finished[^]*Exit code 0/);
    assert.equal(clear.mock.callCount(), 1, "Shell updates retain the unchanged tool prefix");
    f.render(20);
    assert.equal(clear.mock.callCount(), 2);
    f.transcript.invalidate(); f.render(20);
    assert.equal(clear.mock.callCount(), 3);
    f.session.messages = []; f.session.shellResponses = [];
    assert.equal(f.render(20), "");
  } finally { await f.close(); }
});

test("cached history does not freeze work animation, queues or session status", async (t) => {
  const f = setup();
  try {
    let now = 0;
    t.mock.method(Date, "now", () => now);
    f.session.messages = [{ role: "assistant", text: "Existing reply", timestamp: 1 }];
    f.session.status = "working";
    f.session.work = { startedAt: 0, outputTokensStart: 0, outputTokens: 0 };
    const initial = f.transcript.render(100);
    assert.match(initial.map(stripTerminalSequences).join("\n"), /Working \(0s\)/);
    const clear = t.mock.method(f.transcript.positions, "clear");
    now = 2320;
    f.session.work.outputTokens = 1234;
    const next = f.transcript.render(100);
    assert.match(next.map(stripTerminalSequences).join("\n"), /Working \(2s\)/);
    assert.doesNotMatch(next.map(stripTerminalSequences).join("\n"), /tokens|1,234/);
    assert.deepEqual(next.slice(0, 2), initial.slice(0, 2));
    assert.ok(next.includes(workLabel(f.session)!));
    now = 87615000;
    assert.match(f.render(), /Working \(1d 0h 20m 15s\)/);
    f.session.preview = "Retrying: rate limit";
    assert.match(f.render(), /Retrying: rate limit/);
    f.session.queuedInputs = [{ id: 1, text: "Next task", mode: "steer" }];
    assert.match(f.render(), /Queued steering[^]*Next task/);
    f.session.queuedInputs[0]!.text = "Updated task";
    assert.match(f.render(), /Updated task/);
    f.session.status = "needs-input";
    assert.match(f.render(), /Waiting for your answer/);
    f.session.queuedInputs = [];
    f.session.status = "paused";
    assert.doesNotMatch(f.render(), /Queued steering|Waiting for your answer/);
    assert.match(f.render(), /Paused\. Reply to continue/);
    assert.equal(clear.mock.callCount(), 0, "Live status updates must not reformat unchanged history");
  } finally { await f.close(); }
});

test("streaming redraws format only the changed suffix, including after durable replacements", async (t) => {
  const f = setup();
  try {
    f.session.messages = Array.from({ length: 100 }, (_, i) => ({ role: "assistant", text: `Reply ${i}`, timestamp: i }));
    f.render();
    const render = t.mock.method(Markdown.prototype, "render");
    const clear = t.mock.method(f.transcript.positions, "clear");
    for (let i = 0; i < 5; i++) {
      f.session.messages = structuredClone(f.session.messages);
      f.session.messages.at(-1)!.text += " more";
      assert.match(f.render(), /Reply 99 more/);
      assert.equal(render.mock.callCount(), i + 1, "Old replies must not be reformatted for each streaming chunk");
    }
    f.session.messages.push({ role: "assistant", text: "New reply", timestamp: 101 });
    assert.match(f.render(), /New reply/);
    assert.equal(render.mock.callCount(), 6);
    assert.equal(clear.mock.callCount(), 0, "Incremental updates retain the unchanged interaction map");
  } finally { await f.close(); }
});

test("incremental group caches track hidden thinking, visibility changes, errors and regrouping", async () => {
  const f = setup();
  try {
    const full = new Transcript(f.controller, () => {});
    const read = (id: string) => toolMessage({ id, name: "read", arguments: { path: `${id}.ts` }, status: "done", output: "source" });
    const check = () => {
      full.invalidate();
      assert.deepEqual(f.transcript.render(100), full.render(100));
      assert.deepEqual([...f.transcript.positions], [...full.positions]);
      assert.equal(f.transcript.selected, full.selected);
    };
    const reason: Message = { role: "thinking", text: "", timestamp: 2, thinking: { id: "thinking:between" } };
    const second = read("second");
    f.session.messages = [read("first"), reason, second, { role: "assistant", text: "Boundary", timestamp: 4 }, read("third")];
    check();
    reason.text = "Streaming reasoning"; check();
    f.transcript.toggleAll(true); full.toggleAll(true); check();
    f.store.state.settings = { replyBehavior: "followUp", showThinking: false }; check();
    f.store.state.settings.showThinking = true; check();
    second.tool!.status = "error"; check();
    second.tool!.status = "done"; check();
    f.session.messages.splice(2, 0, { role: "thinking", text: "NEVER_DISPLAY", timestamp: 3,
      thinking: { id: "thinking:redacted", redacted: true } }); check();
    f.session.messages.splice(4, 1); check();
    f.transcript.toggleAll(false); full.toggleAll(false); check();
    reason.text = ""; check();
    f.session.messages = structuredClone(f.session.messages); check();
    f.session.messages.shift(); check();
    f.session.messages.length = 1; check();
  } finally { await f.close(); }
});

test("incremental output and hit maps match full renders when groups grow, split, merge or disappear", async () => {
  const f = setup();
  try {
    const full = new Transcript(f.controller, () => {});
    const read = (id: string) => toolMessage({ id, name: "read", arguments: { path: `${id}.ts` }, status: "done", output: "source" });
    const check = () => {
      full.invalidate();
      assert.deepEqual(f.transcript.render(100), full.render(100));
      assert.deepEqual([...f.transcript.positions], [...full.positions]);
      assert.equal(f.transcript.selected, full.selected);
    };
    const selectLast = () => { f.transcript.move(-1); full.move(-1); };
    const toggle = (expand?: boolean) => { f.transcript.toggle(expand); full.toggle(expand); };
    f.session.messages = [
      { role: "user", text: "Check the files", timestamp: 1 },
      { role: "thinking", text: "Initial reasoning", timestamp: 2 },
      read("first"), read("second"),
      { role: "assistant", text: "More work", timestamp: 4 },
    ];
    check();
    f.session.messages.push(read("third")); check();
    selectLast(); toggle(true); check();
    f.session.messages.push(read("fourth")); check();
    f.session.messages.at(-1)!.tool!.status = "error"; check();
    f.session.messages.at(-1)!.tool!.status = "done"; check();
    f.session.messages.splice(4, 1); check();
    f.session.messages.splice(3, 0, { role: "assistant", text: "Group boundary", timestamp: 3 }); check();
    toggle(false); check();
    f.session.messages.splice(3, 1); check();
    f.session.messages.length = 3; check();
    f.session.messages.push(read("fifth")); check();
    f.session.messages = structuredClone(f.session.messages); check();
    f.session.messages[1]!.text += " expanded reasoning"; check();
    f.session.messages.splice(0, 2); check();
    f.session.messages = []; check();
  } finally { await f.close(); }
});

test("completion receipts are view-local, success-only, thresholded and cleared by later activity", async () => {
  const f = setup();
  try {
    f.session.messages = [{ role: "assistant", text: "Reply", timestamp: 1 }];
    f.session.work = { startedAt: 0 };
    f.session.status = "working";
    f.render();
    f.session.work.finishedAt = 10000; f.session.status = "completed";
    assert.match(f.render(), /Worked for 10s/);
    const replay = new Transcript(f.controller, () => {});
    assert.doesNotMatch(replay.render(100).map(stripTerminalSequences).join("\n"), /Worked for/);
    f.session.messages.push({ role: "assistant", text: "Later notice", timestamp: 2 });
    assert.doesNotMatch(f.render(), /Worked for/);
    f.session.status = "working"; f.session.work = { startedAt: 20000 }; f.render();
    f.session.status = "completed"; f.session.work.finishedAt = 29999;
    assert.doesNotMatch(f.render(), /Worked for/);
    for (const status of ["failed", "paused", "needs-input"] as const) {
      f.session.status = "working"; f.session.work = { startedAt: 40000 }; f.render();
      f.session.status = status; f.session.work.finishedAt = 60000;
      assert.doesNotMatch(f.render(), /Worked for/);
    }
  } finally { await f.close(); }
});

test("sticky prompts track the scrolled turn, hide at the original and jump on click", async () => {
  const f = setup(); const terminal = new FakeTerminal(); const tui = new TuiAltScreen(terminal);
  let app: Dashboard | undefined;
  try {
    f.session.messages = [
      { role: "user", text: "FIRST PROMPT\ncontinued", timestamp: 1 },
      { role: "assistant", text: Array.from({ length: 30 }, (_, i) => `First reply row ${i}`).join("\n"), timestamp: 2 },
      { role: "user", text: "SECOND PROMPT", timestamp: 3 },
      { role: "assistant", text: Array.from({ length: 30 }, (_, i) => `Second reply row ${i}`).join("\n"), timestamp: 4 },
    ];
    app = new Dashboard(f.controller, tui, () => {});
    tui.setLayoutRoot(app); tui.setFocus(app); tui.start(); app.sync(); tui.renderNow();
    assert.deepEqual(app.stickyPrompt.render(80), []);
    app.chatScroll.scrollTo(5); tui.renderNow(); tui.renderNow();
    assert.match(app.stickyPrompt.render(80).map(stripTerminalSequences).join("\n"), /FIRST PROMPT continued/);
    assert.ok(app.stickyPrompt.render(8).every(line => visibleWidth(line) <= 8));
    const second = [...app.body.transcript.prompts].find(([, text]) => text === "SECOND PROMPT")![0];
    app.chatScroll.scrollTo(second + 2); tui.renderNow(); tui.renderNow();
    assert.match(app.stickyPrompt.render(80).map(stripTerminalSequences).join("\n"), /SECOND PROMPT/);
    const stickyRow = tui.getScreenLines().findIndex(line => stripTerminalSequences(line).includes("SECOND PROMPT"));
    assert.ok(stickyRow >= 0);
    terminal.onInput(`\x1b[<0;2;${stickyRow + 1}M`);
    terminal.onInput(`\x1b[<0;2;${stickyRow + 1}m`);
    assert.equal(app.chatScroll.scrollTop, second);
    tui.renderNow(); tui.renderNow();
    assert.deepEqual(app.stickyPrompt.render(80), []);
    app.chatScroll.scrollToEnd(); tui.renderNow(); tui.renderNow();
    assert.deepEqual(app.stickyPrompt.render(80), []);
    app.chatScroll.scrollTo(5); tui.renderNow(); tui.renderNow();
    for (const [width, height] of [[24, 18], [80, 32], [12, 8], [120, 32]]) {
      terminal.columns = width!; terminal.rows = height!; terminal.onResize(); tui.renderNow(); tui.renderNow();
      assert.ok(tui.getScreenLines().every(line => visibleWidth(line) <= width!));
      if (height! < 10) assert.deepEqual(app.stickyPrompt.render(width!), []);
    }
    const other = { ...structuredClone(f.session), id: "sticky-other", messages: [{ role: "assistant" as const, text: "Other session", timestamp: 1 }] };
    f.store.state.sessions.push(other); f.controller.openedSessionId = other.id; app.sync(); tui.renderNow(); tui.renderNow();
    assert.deepEqual(app.stickyPrompt.render(80), []);
    assert.doesNotMatch(tui.getScreenLines().map(stripTerminalSequences).join("\n"), /FIRST PROMPT|SECOND PROMPT/);
  } finally { tui.stop(); app?.dispose(); await f.close(); }
});
