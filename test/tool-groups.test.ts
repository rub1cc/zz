import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { stripTerminalSequences, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { Controller } from "../src/controller.js";
import type { Message, Session, ToolActivity, TranscriptMessage } from "../src/model.js";
import { Store } from "../src/store.js";
import { normalizedToolPath, renderToolGroup, toolGroupLabel, toolGroups } from "../src/tool-groups.js";
import { canGroupTool } from "../src/tool-response.js";
import { Transcript } from "../src/transcript.js";
import { Dashboard } from "../src/ui.js";
import { image } from "./image-fixtures.js";
import { FakeEngine, FakeTerminal, temporary } from "./helpers.js";

const read = (id = "read", status: ToolActivity["status"] = "done"): ToolActivity => ({ id, name: "read", status, arguments: { path: `${id}.ts` }, output: "FILE_CONTENT" });
const bash = (id = "bash", status: ToolActivity["status"] = "done"): ToolActivity => ({ id, name: "bash", status, arguments: { command: "npm test\nSCRIPT_BODY" }, output: "COMMAND_OUTPUT" });
const message = (tool: ToolActivity): Message => ({ role: "tool", tool, text: "", timestamp: 1 });
const thinking = (): Message => ({ role: "thinking", text: "REASONING", timestamp: 2, thinking: { id: "thinking:one" } });
const clean = (lines: string[]) => lines.map(stripTerminalSequences).map(line => line.trimEnd()).join("\n");

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

test("historical calls, including singletons, have quiet count receipts", async () => {
  const f = setup();
  try {
    const original = structuredClone(f.session.messages);
    assert.equal(f.render(), "  Read 1 file, ran 1 shell command\n");
    assert.doesNotMatch(f.render(), /SCRIPT_BODY|COMMAND_OUTPUT|FILE_CONTENT/);
    f.session.messages.pop();
    assert.equal(f.render(), "  Read 1 file\n");
    f.session.messages = original;
    assert.equal(f.render(), "  Read 1 file, ran 1 shell command\n");
    assert.deepEqual(f.session.messages, original);
  } finally { await f.close(); }
});

test("group expansion reveals headings, individual expansion reveals output and retains state", async () => {
  const f = setup();
  try {
    f.render(); f.transcript.move(1); f.transcript.toggle();
    assert.match(f.render(), /Read\(read.ts\)[^]*Bash\(npm test\)/);
    assert.doesNotMatch(f.render(), /FILE_CONTENT|SCRIPT_BODY/);
    f.transcript.move(1); f.transcript.toggle();
    assert.match(f.render(), /FILE_CONTENT/);
    f.transcript.move(-1); f.transcript.toggle();
    assert.doesNotMatch(f.render(), /FILE_CONTENT/);
    f.transcript.toggle();
    assert.match(f.render(), /FILE_CONTENT/);
    assert.doesNotMatch(f.render(), /SCRIPT_BODY/);
    f.transcript.toggleAll(true);
    assert.match(f.render(), /SCRIPT_BODY/);
    f.transcript.toggleAll(false);
    assert.doesNotMatch(f.render(), /FILE_CONTENT|SCRIPT_BODY/);
  } finally { await f.close(); }
});

test("visible thinking splits groups; hiding it merges calls without losing reasoning", async () => {
  const f = setup([message(read()), thinking(), message(bash())]);
  try {
    const original = structuredClone(f.session.messages);
    assert.match(f.render(), /Read 1 file[^]*REASONING[^]*Ran 1 shell command/);
    f.store.state.settings = { replyBehavior: "followUp", showThinking: false };
    assert.equal(f.render(), "  Read 1 file, ran 1 shell command\n");
    f.transcript.toggleAll(true);
    assert.match(f.render(), /FILE_CONTENT[^]*SCRIPT_BODY/);
    assert.doesNotMatch(f.render(), /REASONING/);
    f.store.state.settings.showThinking = true;
    assert.match(f.render(), /REASONING/);
    assert.deepEqual(f.session.messages, original);
  } finally { await f.close(); }
});

test("live preview replaces in place, survives settlement, and becomes counts only at prose", async () => {
  const first = read("package", "running");
  const f = setup([message(first)]);
  try {
    f.session.status = "working";
    assert.match(f.render(), /Reading package.ts[^]*package.ts/);
    assert.doesNotMatch(f.render(), /Read 1 file/);
    first.status = "done";
    assert.match(f.render(), /Reading package.ts/);
    const shell = bash("run", "pending"); f.session.messages.push(message(shell));
    assert.match(f.render(), /Reading package.ts/);
    shell.status = "running"; shell.output = "OLD\nfirst\nsecond\nLATEST";
    assert.match(f.render(), /Running npm test[^]*first[^]*second[^]*LATEST/);
    assert.doesNotMatch(f.render(), /OLD|SCRIPT_BODY/);
    shell.status = "done"; f.session.status = "completed";
    assert.match(f.render(), /Running npm test/);
    f.session.messages.push({ role: "assistant", text: "Tests pass.", timestamp: 3 });
    assert.match(f.render(), /Read 1 file, ran 1 shell command[^]*Tests pass/);
    assert.doesNotMatch(f.render(), /Running npm test|LATEST/);
    const replay = new Transcript(f.controller, () => {});
    assert.match(clean(replay.render(120)), /Read 1 file, ran 1 shell command/);
  } finally { await f.close(); }
});

test("parallel completion and incomplete next arguments never replace latest-started preview", async () => {
  const a = read("a", "running"), b = read("b", "pending");
  const f = setup([message(a), message(b)]);
  try {
    f.session.status = "working"; assert.match(f.render(), /Reading a.ts/);
    b.status = "running"; assert.match(f.render(), /Reading b.ts/);
    b.status = "done"; assert.match(f.render(), /Reading b.ts/);
    a.status = "done"; assert.match(f.render(), /Reading b.ts/);
    const preparing = { ...read("next", "pending"), arguments: {}, preparing: true };
    f.session.messages.push(message(preparing));
    assert.match(f.render(), /Reading b.ts/);
    assert.doesNotMatch(f.render(), /Preparing|Pending/);
    f.session.messages = structuredClone(f.session.messages);
    assert.match(f.render(), /Reading b.ts/);
  } finally { await f.close(); }
});

test("replayed pending calls show queued counts, not invented live previews", async () => {
  const f = setup([message(read("queued", "pending"))]);
  try {
    assert.match(f.render(), /Queued 1 file read/);
    assert.doesNotMatch(f.render(), /Reading queued.ts/);
  } finally { await f.close(); }
});

test("successful task calls disappear without splitting groups even globally expanded", async () => {
  const task = { ...read("task"), name: "task_update", output: "SECRET_TASK_JSON" };
  const f = setup([message(read()), message(task), message(bash())]);
  try {
    assert.match(f.render(), /Read 1 file, ran 1 shell command/);
    f.transcript.toggleAll(true);
    assert.doesNotMatch(f.render(), /SECRET_TASK_JSON|Update tasks/);
    task.status = "error"; task.output = "Dependency cycle";
    assert.match(f.render(), /Dependency cycle/);
    assert.doesNotMatch(f.render(), /Read 1 file, ran/);
  } finally { await f.close(); }
});

test("failed inspections retain their group, failure count and bounded diagnostic", async () => {
  const failed = bash("failed", "error"); failed.output = "Permission denied ".repeat(500);
  const f = setup([message(read()), message(failed)]);
  try {
    assert.match(f.render(), /1 failed[^]*Read 1 file, ran 1 shell command[^]*Permission denied/);
    assert.ok(f.transcript.render(80).length <= 5);
    f.transcript.toggleAll(true);
    assert.match(f.render(), /Arguments[^]*Permission denied/);
    failed.status = "interrupted";
    assert.match(f.render(), /Interrupted; completion not confirmed/);
    assert.doesNotMatch(f.render(), /Read 1 file, ran/);
  } finally { await f.close(); }
});

test("read images group but non-read artifacts, warnings and consequential actions stay boundaries", () => {
  assert.equal(toolGroups([message({ ...read(), images: [image] }), message(bash())]).get(0)?.tools.length, 2);
  const barriers: TranscriptMessage[] = [
    { role: "user", text: "Next", timestamp: 2 }, { role: "assistant", text: "Explanation", timestamp: 2 }, thinking(),
    { role: "error", text: "Provider error", timestamp: 2 }, { role: "tool", text: "Legacy", timestamp: 2 },
    ...["edit", "write", "load_skill", "ask_question", "compact", "unknown"].map(name => message({ ...read("barrier"), name })),
    message({ ...bash(), images: [image] }), message(bash("stopped", "interrupted")),
    message({ ...read(), details: { diagnostics: [{ severity: "warn", message: "Truncated" }] } }),
    message({ ...read(), details: { result: { truncation: { truncated: true } } } }),
  ];
  for (const barrier of barriers) assert.equal(toolGroups([message(read()), barrier, message(bash())]).get(0)?.tools.length, 1);
  assert.equal(canGroupTool({ ...read(), arguments: {} }), false);
});

test("path aliases deduplicate reads while ranges and invocation counts remain inspectable", () => {
  const tools = [read("one"), read("two"), read("three")];
  tools[0]!.arguments = { path: "./src/../a.ts", offset: 1, limit: 5 };
  tools[1]!.arguments = { path: "/repo/a.ts", offset: 6 };
  tools[2]!.arguments = { path: "@a.ts" };
  assert.equal(toolGroupLabel(tools, "/repo"), "Read 1 file (3 calls)");
  assert.equal(normalizedToolPath("file:///repo/a.ts", "/repo"), "/repo/a.ts");
  assert.equal(toolGroupLabel([bash(), { ...bash("ps"), name: "powershell" }]), "Ran 2 shell commands");
});

test("headers are muted, failed counts lead, and narrow widths stay safe", () => {
  const tools = [read(), bash()];
  assert.doesNotMatch(renderToolGroup(tools, 120, false, false)[0]!, /\x1b\[1m|\x1b\[32m/);
  for (const width of [1, 2, 4, 8, 24, 80]) {
    const rows = renderToolGroup([...tools, { ...bash("bad", "error"), output: "界面 ".repeat(300) }], width, false, false);
    assert.ok(rows.every(row => visibleWidth(row) <= width));
  }
});

test("click targets distinguish group headers and member rows through resize", async () => {
  const f = setup(); const terminal = new FakeTerminal(); const tui = new TuiAltScreen(terminal);
  try {
    const app = new Dashboard(f.controller, tui, () => {});
    tui.setLayoutRoot(app); tui.setFocus(app); tui.start(); app.sync();
    const transcript = app.body.transcript;
    transcript.render(120);
    terminal.onInput("\t"); terminal.onInput(" ");
    assert.match(clean(transcript.render(120)), /Read\(read.ts\)/);
    const y = transcript.positions.get("read")!;
    transcript.handleMouse({ type: "click", button: "left", x: 2, y, screenX: 2, screenY: y, width: 120, height: 32, shift: false, ctrl: false, alt: false });
    assert.match(clean(transcript.render(120)), /FILE_CONTENT/);
    for (const width of [1, 4, 24, 80]) assert.ok(transcript.render(width).every(row => visibleWidth(row) <= width));
    app.composer.setValue("/collapse"); terminal.onInput("\r");
    assert.doesNotMatch(clean(transcript.render(120)), /FILE_CONTENT/);
    app.composer.setValue("/expand"); terminal.onInput("\r");
    assert.match(clean(transcript.render(120)), /SCRIPT_BODY/);
  } finally { tui.stop(); await f.close(); }
});

test("session switches reset local previews and expansion without changing saved messages", async () => {
  const f = setup();
  try {
    const original = structuredClone(f.session.messages);
    f.render(); f.transcript.toggleAll(true); assert.match(f.render(), /SCRIPT_BODY/);
    const other = { ...structuredClone(f.session), id: "other" };
    f.store.state.sessions.push(other); f.controller.openedSessionId = other.id;
    assert.equal(f.render(), "  Read 1 file, ran 1 shell command\n");
    assert.deepEqual(f.session.messages, original);
  } finally { await f.close(); }
});

test("structured failure diagnostics group once, but spill paths and warnings stay standalone", () => {
  const failed = { ...bash("bad", "error"), output: "failed\n<harness>\n[error] Exit 7\n</harness>",
    details: { diagnostics: [{ severity: "error", message: "Exit 7" }] } };
  assert.equal(canGroupTool(failed), true);
  assert.equal(clean(renderToolGroup([read(), failed], 100, false, false)).match(/Exit 7/g)?.length, 1);
  failed.details.diagnostics.push({ severity: "info", message: "Full output: /tmp/log.txt" });
  assert.equal(canGroupTool(failed), false);
});

test("stopping a run closes live previews even when its last tool completed", async () => {
  const tool = bash("running", "running"); const f = setup([message(tool)]);
  try {
    f.session.status = "working"; assert.match(f.render(), /Running npm test/);
    tool.status = "done"; f.session.status = "paused";
    assert.doesNotMatch(f.render(), /Running npm test/);
    assert.match(f.render(), /Ran 1 shell command[^]*Paused/);
  } finally { await f.close(); }
});
