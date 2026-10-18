import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { stripTerminalSequences, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { Controller } from "../src/controller.js";
import type { Message, Session, ToolActivity, TranscriptMessage } from "../src/model.js";
import { Store } from "../src/store.js";
import { renderToolGroup, toolGroupLabel, toolGroups } from "../src/tool-groups.js";
import { canGroupTool, renderToolResponse } from "../src/tool-response.js";
import { Transcript } from "../src/transcript.js";
import { Dashboard } from "../src/ui.js";
import { image } from "./image-fixtures.js";
import { FakeEngine, FakeTerminal, temporary } from "./helpers.js";

const read = (id = "read", status: ToolActivity["status"] = "done"): ToolActivity => ({ id, name: "read", status, arguments: { path: `${id}.ts` }, output: "FILE_CONTENT" });
const bash = (id = "bash", status: ToolActivity["status"] = "done"): ToolActivity => ({ id, name: "bash", status, arguments: { command: "cat > file <<'EOF'\nSCRIPT_BODY\nEOF" }, output: "COMMAND_OUTPUT" });
const message = (tool: ToolActivity): Message => ({ role: "tool", tool, text: "", timestamp: 1 });
const clean = (lines: string[]) => lines.map(stripTerminalSequences).map((line) => line.trimEnd()).join("\n");

function setup(messages: Message[] = [message(read()), message(bash())]) {
  const temp = temporary();
  const store = new Store(join(temp.root, "data"));
  const project = store.addProject(temp.root);
  const session: Session = { id: "grouped", title: "Grouped tools", projectId: project.id, status: "completed", preview: "", createdAt: 1, updatedAt: 1, messages };
  store.state.sessions.push(session);
  const controller = new Controller(store, new FakeEngine());
  controller.mode = "session"; controller.openedSessionId = session.id;
  const transcript = new Transcript(controller, () => {});
  const render = (width = 120) => clean(transcript.render(width));
  return { ...temp, store, session, controller, transcript, render,
    async close() { await controller.close(); temp.cleanup(); } };
}

test("adjacent routine reads and commands become one line without commands, paths, or stdout", async () => {
  const f = setup();
  try {
    const original = structuredClone(f.session.messages);
    assert.equal(f.render(), "\u25cf Read 1 file, ran 1 shell command (/expand)\n");
    assert.doesNotMatch(f.render(), /read\.ts|cat >|SCRIPT_BODY|FILE_CONTENT|COMMAND_OUTPUT/);
    assert.equal(f.transcript.positions.get("read"), f.transcript.positions.get("bash"));
    f.transcript.move(1); f.transcript.toggle();
    assert.match(f.render(), /Read 1 file, ran 1 shell command \(collapse\)[^]*Read\(read.ts\)[^]*FILE_CONTENT[^]*Bash[^]*SCRIPT_BODY[^]*COMMAND_OUTPUT/);
    f.transcript.toggle();
    assert.doesNotMatch(f.render(), /SCRIPT_BODY|FILE_CONTENT|COMMAND_OUTPUT/);
    assert.deepEqual(f.session.messages, original);
  } finally { await f.close(); }
});

test("group counts and hints are normal weight, with only the Read name bold", () => {
  const mixed = renderToolGroup([read(), bash()], 120, false, false)[0]!;
  assert.ok(mixed.includes("\x1b[1mRead\x1b[22m 1 file, ran 1 shell command"));
  assert.equal(mixed.match(/\x1b\[1m/g)?.length, 1);
  assert.doesNotMatch(renderToolGroup([bash(), bash("second")], 120, false, false)[0]!, /\x1b\[1m/);
});

test("groups distinguish completed, running and pending work without claiming uncompleted work ran", () => {
  assert.equal(toolGroupLabel([read(), bash("run", "running")]), "Read 1 file, running 1 shell command");
  assert.equal(toolGroupLabel([read("a", "running"), bash("run", "pending")]), "Reading 1 file, queued 1 shell command");
  assert.equal(toolGroupLabel([read("a", "pending"), read("b", "pending"), bash("run", "pending")]), "Queued 2 file reads, queued 1 shell command");
  assert.equal(toolGroupLabel([read(), read(), bash(), bash("second")]), "Read 1 file, ran 2 shell commands");
  const powerShell = { ...bash("ps"), name: "powershell" };
  assert.equal(toolGroupLabel([bash(), powerShell]), "Ran 2 shell commands");
});

test("narrative, mutations, skills, questions, warnings, images and failures are grouping boundaries", () => {
  const barriers: TranscriptMessage[] = [
    { role: "user", text: "Next task", timestamp: 2 },
    { role: "assistant", text: "Here is an explanation", timestamp: 2 },
    { role: "thinking", text: "Provider thinking", timestamp: 2 },
    { role: "error", text: "Model failed", timestamp: 2 },
    { role: "tool", text: "Legacy output", timestamp: 2 },
    { role: "shell", text: "local", timestamp: 2, shell: { id: "local", command: "pwd", cwd: "/project", text: "local", status: "done", timestamp: 2, updatedAt: 2, droppedBytes: 0, droppedLines: 0 } },
    ...["edit", "write", "load_skill", "ask_user", "ask_question", "ask_multiple_questions", "compact", "unknown"].map((name) => message({ ...read("barrier"), name })),
    message({ ...read("skill"), arguments: { path: "C:\\skills\\testing\\SKILL.md" } }),
    message(read("failed", "error")), message(bash("stopped", "interrupted")),
    message({ ...read("picture"), images: [image] }),
    message({ ...read("warning"), details: { diagnostics: [{ severity: "warn", message: "Truncated" }] } }),
    message({ ...read("continuation"), details: { diagnostics: [{ severity: "info", message: "Use offset=10" }] } }),
    message({ ...read("truncated"), details: { result: { truncation: { truncated: true } } } }),
    message({ ...read("legacy-diagnostic"), output: "text\n<harness>\n[warn] Truncated\n</harness>" }),
  ];
  for (const barrier of barriers) {
    assert.equal(toolGroups([message(read()), barrier, message(bash())]).size, 0, JSON.stringify(barrier));
  }
  for (const tool of [{ ...read(), arguments: {} }, { ...bash(), arguments: { command: "" } }]) assert.equal(canGroupTool(tool), false);
});

test("group selection and expansion survive appending calls, projection replacements, and group merging", async () => {
  const f = setup([message(bash())]);
  try {
    f.render(); f.transcript.move(1); f.transcript.toggle();
    assert.match(f.render(), /SCRIPT_BODY/);
    f.session.messages.unshift(message(read()));
    assert.match(f.render(), /SCRIPT_BODY/);
    assert.equal(f.transcript.selected, "read", "Selection follows a standalone call into its new group");
    f.transcript.toggle();
    assert.doesNotMatch(f.render(), /SCRIPT_BODY/);
    f.session.messages.push(message(bash("second", "running")));
    f.session.messages = structuredClone(f.session.messages);
    assert.match(f.render(), /Read 1 file, ran 1 shell command, running 1 shell command/);
    assert.doesNotMatch(f.render(), /SCRIPT_BODY|COMMAND_OUTPUT/);
    f.session.messages.at(-1)!.tool!.status = "done";
    assert.match(f.render(), /Read 1 file, ran 2 shell commands/);
    f.transcript.toggleAll(true);
    assert.match(f.render(), /SCRIPT_BODY|COMMAND_OUTPUT/);
    f.transcript.toggleAll(false);
    assert.doesNotMatch(f.render(), /SCRIPT_BODY|COMMAND_OUTPUT/);
  } finally { await f.close(); }
});

test("an error breaks out of its group and stays visible instead of being summarized as success", async () => {
  const f = setup();
  try {
    assert.match(f.render(), /Read 1 file, ran 1 shell command/);
    const call = f.session.messages[1]!.tool!;
    call.status = "error"; call.details = { diagnostics: [{ severity: "error", message: "Command exited with code 7" }] };
    const text = f.render();
    assert.doesNotMatch(text, /ran 1 shell command|SCRIPT_BODY|COMMAND_OUTPUT/);
    assert.match(text, /Read\(read.ts\)[^]*Bash[^]*Error[^]*Command exited with code 7/);
    call.status = "interrupted";
    assert.match(f.render(), /Interrupted; completion not confirmed/);
    assert.doesNotMatch(f.render(), /ran 1 shell command/);
  } finally { await f.close(); }
});

test("group clicks, keyboard navigation and /expand /collapse work in the real TUI", async () => {
  const f = setup(); const terminal = new FakeTerminal(); const tui = new TuiAltScreen(terminal);
  try {
    const app = new Dashboard(f.controller, tui, () => {});
    tui.setLayoutRoot(app); tui.setFocus(app); tui.start(); app.sync();
    const render = () => clean(app.body.transcript.render(120));
    assert.match(render(), /Read 1 file, ran 1 shell command/);
    terminal.onInput("\t"); terminal.onInput(" ");
    assert.match(render(), /SCRIPT_BODY[^]*COMMAND_OUTPUT/);
    app.composer.setValue("/collapse"); terminal.onInput("\r");
    assert.doesNotMatch(render(), /SCRIPT_BODY|COMMAND_OUTPUT/);
    app.composer.setValue("/expand"); terminal.onInput("\r");
    assert.match(render(), /SCRIPT_BODY[^]*COMMAND_OUTPUT/);
    const y = app.body.transcript.positions.get("read")!;
    app.body.transcript.handleMouse({ type: "click", button: "left", x: 2, y, screenX: 2, screenY: y, width: 120, height: 32, shift: false, ctrl: false, alt: false });
    assert.doesNotMatch(render(), /SCRIPT_BODY|COMMAND_OUTPUT/);
    f.session.messages.push(message({ ...read("edit"), name: "edit" }));
    render(); app.body.transcript.move(1);
    assert.equal(app.body.transcript.selected, "edit", "A group is one navigation target");
    assert.equal((f.controller.engine as FakeEngine).calls.length, 0);
  } finally { tui.stop(); await f.close(); }
});

test("restoring and switching sessions rebuilds collapsed groups without altering saved messages", async () => {
  const f = setup(); let restoredController: Controller | undefined;
  try {
    const expected = f.render();
    f.store.save();
    f.transcript.toggleAll(true); assert.match(f.render(), /SCRIPT_BODY/);
    const restored = new Store(f.store.root);
    restoredController = new Controller(restored, new FakeEngine());
    restoredController.mode = "session"; restoredController.openedSessionId = f.session.id;
    const transcript = new Transcript(restoredController, () => {});
    assert.equal(clean(transcript.render(120)), expected);
    assert.deepEqual(restoredController.opened?.messages, f.session.messages);
    const other = { ...structuredClone(f.session), id: "other" };
    f.store.state.sessions.push(other); f.controller.openedSessionId = other.id;
    assert.equal(f.render(), expected);
  } finally { await restoredController?.close(); await f.close(); }
});

test("group headings and individual long targets stay on one safe terminal row", () => {
  const tools = [read(), bash()];
  for (const width of [1, 2, 3, 4, 12, 24, 80, 300]) {
    const lines = renderToolGroup(tools, width, false, true);
    assert.equal(lines.length, 1);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    const long = { ...read(), arguments: { path: "\u754c\u9762\x1b[2J".repeat(1000) } };
    const heading = renderToolResponse(long, width, false, false)[0]!;
    assert.ok(visibleWidth(heading) <= width);
    assert.ok(!heading.includes("\x1b[2J"));
  }
});

test("compact diagnostics prioritize exceptions and cannot produce an unbounded wall of text", () => {
  const tool = { ...bash("failed", "error"), details: { diagnostics: [
    ...Array.from({ length: 100 }, () => ({ severity: "info", message: "LONG_DETAIL ".repeat(100) })),
    { severity: "error", message: "CRITICAL_EXIT_CODE_7" },
  ] } };
  const lines = renderToolResponse(tool, 100, false, false);
  assert.ok(lines.length <= 5);
  assert.match(clean(lines), /CRITICAL_EXIT_CODE_7[^]*More diagnostics/);
  assert.doesNotMatch(clean(lines), /SCRIPT_BODY|COMMAND_OUTPUT/);
  assert.ok(renderToolResponse(tool, 100, true, false).length > lines.length);
});
