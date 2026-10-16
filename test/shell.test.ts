import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { stripTerminalSequences, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { Controller } from "../src/controller.js";
import { activityTimestamp, displayStatus, lastReply, transcriptMessages, type ShellResponse } from "../src/model.js";
import { renderShellResponse } from "../src/shell-response.js";
import { ShellRun, SHELL_OUTPUT_BYTES, SHELL_OUTPUT_LINES } from "../src/shell.js";
import { Store } from "../src/store.js";
import { Dashboard } from "../src/ui.js";
import { FakeEngine, FakeTerminal, temporary, tick } from "./helpers.js";
import { png } from "./image-fixtures.js";

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) { assert.ok(Date.now() < deadline, "Timed out waiting for shell state"); await new Promise((resolve) => setTimeout(resolve, 5)); }
}

function fixture(writeClipboard?: (text: string) => Promise<void>) {
  const temp = temporary();
  const a = join(temp.root, "alpha with spaces ' ;"); const b = join(temp.root, "beta"); mkdirSync(a); mkdirSync(b);
  const store = new Store(join(temp.root, "data")); const pa = store.addProject(a); const pb = store.addProject(b);
  const engine = new FakeEngine(); const c = new Controller(store, engine, undefined, writeClipboard);
  const terminal = new FakeTerminal(); const tui = new TuiAltScreen(terminal, false);
  const app = new Dashboard(c, tui, () => {});
  tui.setLayoutRoot(app); tui.setFocus(app); tui.start(); app.sync();
  const run = () => { const run = c.shellRun; assert.ok(run); return run; };
  const screen = () => { tui.renderNow(); return tui.getScreenLines().map(stripTerminalSequences).join("\n"); };
  return { ...temp, store, pa, pb, engine, c, terminal, tui, app, run, screen,
    async cleanup() { await c.close(); tui.stop(); temp.cleanup(); } };
}

test("!pwd opens a normal response transcript without a popup, model request or global chdir", async () => {
  const f = fixture();
  try {
    const launchCwd = process.cwd();
    f.engine.defaults = { thinkingLevel: "off" };
    f.c.select(`project:${f.pa.id}`);
    f.app.composer.setValue("!pwd"); f.terminal.onInput("\r");
    const run = f.run(); await run.done;
    assert.equal(run.output.text.trim(), realpathSync(f.pa.path));
    assert.equal(run.phase, "done"); assert.equal(run.exitCode, 0);
    assert.equal(f.c.dialog, undefined); assert.equal(f.c.mode, "session");
    assert.equal(f.app.composer.getValue(), ""); assert.equal(f.engine.calls.length, 0);
    assert.equal(f.store.state.sessions.length, 1); assert.equal(f.c.opened?.conversationId, undefined);
    assert.equal(f.c.opened?.messages.length, 0, "Shell output is not native model context");
    assert.equal(f.c.opened?.shellResponses?.[0]?.text, run.output.text);
    assert.equal(process.cwd(), launchCwd);
    assert.match(f.screen(), /!pwd/); assert.match(f.screen(), /Exit code 0/);
    assert.ok(f.app.body.transcript.render(160).join("\n").includes(realpathSync(f.pa.path)));
    f.c.back(); f.c.select(`project:${f.pb.id}`);
    assert.equal(f.c.send("!pwd"), true);
    const second = f.run(); await second.done;
    assert.equal(second.output.text.trim(), realpathSync(f.pb.path));
    assert.equal(f.store.state.sessions.length, 2); assert.equal(f.engine.calls.length, 0);
  } finally { await f.cleanup(); }
});

test("open sessions retain inline shell responses and images without changing model-authored history", async () => {
  const f = fixture();
  try {
    f.c.select(`project:${f.pa.id}`); f.c.send("real task"); await tick(); f.c.open();
    const session = f.c.opened!; f.c.selection = `project:${f.pb.id}`;
    writeFileSync(join(f.pa.path, "sample.png"), png()); await f.app.composer.attachFile("sample.png");
    const history = structuredClone(session.messages);
    f.app.composer.setValue("!pwd; printf 'SHELL_INLINE_OUTPUT_8724\\n'"); f.terminal.onInput("\r");
    const run = f.run(); await run.done;
    assert.ok(run.output.text.includes(realpathSync(f.pa.path)));
    assert.match(run.output.text, /SHELL_INLINE_OUTPUT_8724/);
    assert.equal(f.c.dialog, undefined); assert.equal(f.c.opened?.id, session.id);
    assert.deepEqual(session.messages, history); assert.equal(session.status, "completed");
    assert.equal(f.engine.calls.length, 1); assert.equal(f.app.composer.images.length, 1);
    assert.match(f.app.body.transcript.render(160).map(stripTerminalSequences).join("\n"), /SHELL_INLINE_OUTPUT_8724/);
    assert.match(readFileSync(f.store.file, "utf8"), /SHELL_INLINE_OUTPUT_8724/);
    f.c.back(); f.c.open();
    assert.match(f.app.body.transcript.render(160).map(stripTerminalSequences).join("\n"), /SHELL_INLINE_OUTPUT_8724/);
    assert.equal(f.app.composer.images.length, 1);
  } finally { await f.cleanup(); }
});

test("dashboard-selected sessions receive shell responses instead of creating another session", async () => {
  const f = fixture();
  try {
    f.c.select(`project:${f.pa.id}`); f.c.send("task"); await tick();
    const session = f.store.state.sessions[0]!;
    f.app.composer.setValue("!pwd"); f.terminal.onInput("\r"); await f.run().done;
    assert.equal(f.c.opened?.id, session.id); assert.equal(f.store.state.sessions.length, 1);
    assert.equal(session.shellResponses?.length, 1); assert.equal(f.engine.calls.length, 1);
  } finally { await f.cleanup(); }
});

test("pipes, redirects, multiline commands, stderr and failed exit codes render inline", async () => {
  const f = fixture();
  try {
    f.c.select(`project:${f.pa.id}`);
    const command = "printf 'pipe input\\n' | tr 'a-z' 'A-Z' > marker.txt\ncat marker.txt\nprintf 'error output\\n' >&2\nexit 7";
    f.app.composer.setValue(`!${command}`); f.terminal.onInput("\r");
    const run = f.run(); await run.done;
    assert.match(run.output.text, /PIPE INPUT/); assert.match(run.output.text, /error output/);
    assert.equal(readFileSync(join(f.pa.path, "marker.txt"), "utf8"), "PIPE INPUT\n");
    assert.equal(existsSync(join(f.pb.path, "marker.txt")), false);
    assert.equal(run.phase, "failed"); assert.equal(run.exitCode, 7);
    assert.match(f.screen(), /Exit code 7/); assert.equal(displayStatus(f.c.opened!), "failed");
    assert.equal(f.c.dialog, undefined); assert.equal(f.engine.calls.length, 0);
  } finally { await f.cleanup(); }
});

test("shell starts fresh per invocation and saved responses do not replay after reopening", async () => {
  const f = fixture(); let restored: Controller | undefined;
  try {
    f.c.select(`project:${f.pa.id}`);
    f.c.runShell("read line || printf 'STDIN_EOF\\n'; cd ..; export ZZ_SHELL_LOCAL_ONLY=1");
    const first = f.run(); await first.done; assert.match(first.output.text, /STDIN_EOF/);
    f.c.runShell("pwd; printf '%s' \"${ZZ_SHELL_LOCAL_ONLY-unset}\"");
    const second = f.run(); await second.done;
    assert.equal(second.output.text, `${realpathSync(f.pa.path)}\nunset`);
    const store = new Store(f.store.root); const engine = new FakeEngine();
    restored = new Controller(store, engine);
    const session = store.state.sessions[0]!;
    assert.equal(session.shellResponses?.length, 2); assert.equal(engine.calls.length, 0);
    assert.equal(lastReply(session), second.output.text);
    assert.equal(transcriptMessages(session).filter((message) => message.role === "shell").length, 2);
  } finally { await restored?.close(); await f.cleanup(); }
});

test("Escape stops the direct shell without stopping an agent; cancelled output stays inline", async () => {
  const f = fixture();
  try {
    f.c.select(`project:${f.pa.id}`); f.c.send("agent work"); await tick(); f.c.open();
    const session = f.c.opened!; session.status = "working";
    f.app.composer.setValue("!printf 'STARTED\\n'; sleep 30; printf 'SHOULD_NOT_FINISH\\n'"); f.terminal.onInput("\r");
    const run = f.run(); await until(() => run.output.text.includes("STARTED"));
    await until(() => session.shellResponses?.[0]?.text.includes("STARTED") === true);
    assert.match(f.screen(), /STARTED/); assert.equal(f.c.dialog, undefined);
    f.terminal.onInput("\x1b"); await run.done;
    assert.equal(run.phase, "cancelled"); assert.doesNotMatch(run.output.text, /SHOULD_NOT_FINISH/);
    assert.equal(session.status, "working"); assert.equal(f.engine.cancelled.length, 0);
    assert.equal(session.shellResponses?.[0]?.status, "cancelled"); assert.match(f.screen(), /Shell command cancelled/);
    assert.equal(f.c.mode, "session");
  } finally { await f.cleanup(); }
});

test("/stop and deletion stop local commands without creating agent stop intent for shell-only sessions", async () => {
  const f = fixture();
  try {
    f.c.runShell("printf 'READY\\n'; sleep 30"); const first = f.run();
    await until(() => first.output.text.includes("READY"));
    const session = f.c.opened!;
    assert.equal(f.c.canStop(session), true);
    await f.c.cancel(); assert.equal(first.phase, "cancelled");
    assert.equal(f.engine.cancelled.length, 0); assert.equal(session.stopped, undefined);
    f.c.runShell("printf 'AGAIN\\n'; sleep 30"); const second = f.run();
    await until(() => second.output.text.includes("AGAIN"));
    f.c.back(); f.c.requestDelete(); await f.c.confirmDelete();
    assert.equal(second.phase, "cancelled"); assert.equal(f.store.state.sessions.length, 0);
  } finally { await f.cleanup(); }
});

test("quitting cancels an active shell and saves its final inline response before cleanup resolves", async () => {
  const f = fixture();
  try {
    f.c.runShell("printf '%s\\n' $$; sleep 30"); const run = f.run();
    await until(() => /^\d+\n/.test(run.output.text));
    const pid = Number(run.output.text.trim());
    await f.c.close();
    assert.equal(run.phase, "cancelled"); assert.throws(() => process.kill(pid, 0), /ESRCH/);
    assert.equal(new Store(f.store.root).state.sessions[0]?.shellResponses?.[0]?.status, "cancelled");
    assert.equal(f.c.runShell("pwd"), false);
  } finally { await f.cleanup(); }
});

test("blank/missing-project inputs and overlapping commands never reach the agent", async () => {
  const f = fixture();
  try {
    f.app.composer.setValue("!   "); f.terminal.onInput("\r");
    assert.match(f.c.notice, /Usage: !command/); assert.equal(f.store.state.sessions.length, 0);
    f.c.selection = "missing"; assert.equal(f.c.send("!pwd"), false); assert.match(f.c.notice, /Select a project/);
    f.c.select(`project:${f.pa.id}`); f.c.runShell("printf 'READY\\n'; sleep 30");
    const run = f.run(); await until(() => run.output.text.includes("READY"));
    assert.equal(f.c.runShell("touch must-not-exist"), false);
    assert.match(f.c.notice, /already running/); assert.equal(existsSync(join(f.pa.path, "must-not-exist")), false);
    assert.equal(f.c.opened?.shellResponses?.length, 1); run.cancel(); await run.done;
    assert.equal(f.engine.calls.length, 0);
  } finally { await f.cleanup(); }
});

test("peek shows shell output as its response without replacing the existing peek or losing images", async () => {
  const f = fixture();
  try {
    f.c.select(`project:${f.pa.id}`); f.c.send("first task"); await tick();
    const session = f.store.state.sessions[0]!;
    writeFileSync(join(f.pa.path, "sample.png"), png()); f.c.peek(); const peek = f.c.dialog;
    f.terminal.onInput('\x1b[200~"sample.png"\x1b[201~');
    await until(() => f.screen().includes("Image 1: sample.png"));
    f.c.selection = `project:${f.pb.id}`;
    f.terminal.onInput("!pwd"); f.terminal.onInput("\r");
    const run = f.run(); await run.done;
    assert.equal(run.output.text.trim(), realpathSync(f.pa.path));
    assert.equal(f.c.dialog, peek); assert.equal(f.c.mode, "sessions");
    assert.match(f.screen(), /Exit code 0/); assert.match(f.screen(), /Image 1: sample.png/);
    f.terminal.onInput("describe image"); f.terminal.onInput("\r"); await tick();
    assert.equal(f.engine.calls.length, 2); assert.equal(f.engine.calls[1]?.session.id, session.id);
    assert.equal(f.engine.calls[1]?.images?.length, 1);
  } finally { await f.cleanup(); }
});

test("shell and undo cannot overlap in the same project; local response history is not undone", async () => {
  const f = fixture(); let finish!: () => void;
  try {
    f.c.select(`project:${f.pa.id}`); f.c.send("task"); await tick(); const session = f.store.state.sessions[0]!;
    f.c.runShell("printf 'READY\\n'; sleep 30"); const run = f.run();
    await until(() => run.output.text.includes("READY"));
    await f.c.showUndo(); assert.match(f.c.notice, /direct shell command to finish/);
    run.cancel(); await run.done; await tick();
    f.engine.undo = async () => { await new Promise<void>((resolve) => { finish = resolve; }); return { prompt: "restored", files: 0, shell: false }; };
    await f.c.showUndo(); const restoring = f.c.undo("latest", session.id);
    assert.equal(f.c.runShell("pwd"), false); assert.match(f.c.notice, /undo to finish/);
    finish(); await restoring; assert.equal(session.shellResponses?.length, 1);
  } finally { finish?.(); await f.cleanup(); }
});

test("bounded shell responses render expanded, scroll with the transcript and strip terminal controls", async () => {
  const f = fixture();
  try {
    f.c.runShell("for ((i=0;i<2100;i++)); do printf '%s\\n' \"$i\"; done; printf '\\033[31mSAFE\\033[0m\\033]52;c;ZXZpbA==\\007\\033[2J'");
    const run = f.run(); await run.done;
    const response = f.c.opened!.shellResponses![0]!;
    assert.equal(run.phase, "done"); assert.ok(response.droppedLines > 0);
    assert.ok(Buffer.byteLength(response.text) <= SHELL_OUTPUT_BYTES);
    assert.ok(response.text.split("\n").length <= SHELL_OUTPUT_LINES + 1);
    assert.doesNotMatch(response.text, /\x1b|\x07/); assert.match(response.text, /SAFE/);
    for (const width of [1, 12, 24, 80]) assert.ok(renderShellResponse(response, width).every((line) => visibleWidth(line) <= width));
    assert.match(f.app.body.transcript.render(80).map(stripTerminalSequences).join("\n"), /Older output omitted/);
    const bottom = f.screen(); assert.match(bottom, /SAFE/);
    f.terminal.onInput("\x1b[5~"); assert.notEqual(f.screen(), bottom);
    f.app.chatScroll.scrollToEnd(); f.tui.requestRender(); assert.match(f.screen(), /SAFE/);
    const huge = new ShellRun(f.pa.path, `${JSON.stringify(process.execPath)} -e 'process.stdout.write("x".repeat(400000))'`, () => {});
    await huge.start(); assert.ok(huge.output.droppedBytes > 0); assert.ok(Buffer.byteLength(huge.output.text) <= SHELL_OUTPUT_BYTES);
  } finally { await f.cleanup(); }
});

test("navigation and settings do not cancel background shell execution; empty and failed outputs are explicit", async () => {
  const f = fixture();
  try {
    const missing = new ShellRun(join(f.root, "missing"), "pwd", () => {}); await missing.start();
    assert.equal(missing.phase, "failed"); assert.match(missing.error ?? "", /Working directory does not exist/);
    f.c.runShell("true"); await f.run().done; assert.match(f.screen(), /No output/);
    f.c.runShell("printf 'READY\\n'; sleep 30"); const run = f.run();
    await until(() => run.output.text.includes("READY"));
    f.c.showSettings(); await tick(); assert.equal(run.running, true);
    f.c.dialog = undefined; f.c.back(); f.c.select(`project:${f.pb.id}`);
    assert.equal(run.running, true); run.cancel(); await run.done;
    const session = f.store.state.sessions[0]!;
    assert.equal(session.shellResponses?.at(-1)?.status, "cancelled"); assert.equal(displayStatus(session), "paused");
  } finally { await f.cleanup(); }
});

test("inline shell output participates in /copy ordering, without copying command headings or status", async () => {
  const copied: string[] = []; const f = fixture(async (text) => { copied.push(text); });
  try {
    f.c.select(`project:${f.pa.id}`); f.c.send("task"); await tick(); f.c.open();
    f.c.runShell("printf 'RAW_RESPONSE\\n'"); await f.run().done;
    await f.c.copyResponse(); await f.c.copyResponse("2");
    assert.deepEqual(copied, ["RAW_RESPONSE\n", "Reply to task"]);
    assert.equal(lastReply(f.c.opened!), "RAW_RESPONSE\n");
  } finally { await f.cleanup(); }
});

test("interrupted saved responses stay readable and are never re-executed; malformed records are refused", async () => {
  const f = fixture(); let restored: Controller | undefined;
  try {
    f.c.runShell("printf 'SAVED_PARTIAL\\n'"); await f.run().done;
    const session = f.c.opened!; const response = session.shellResponses![0]!;
    response.status = "running"; response.command = "touch must-not-replay"; f.store.save();
    const store = new Store(f.store.root); const engine = new FakeEngine(); restored = new Controller(store, engine);
    const recovered = store.state.sessions[0]!;
    assert.equal(recovered.shellResponses?.[0]?.status, "interrupted");
    assert.equal(lastReply(recovered), "SAVED_PARTIAL\n");
    assert.equal(existsSync(join(f.pa.path, "must-not-replay")), false); assert.equal(engine.calls.length, 0);
    assert.ok(activityTimestamp(recovered) >= recovered.updatedAt);
    recovered.shellResponses![0]!.status = "invalid" as ShellResponse["status"]; store.save();
    const original = readFileSync(store.file, "utf8");
    assert.throws(() => new Store(store.root), /Invalid zz state/); assert.equal(readFileSync(store.file, "utf8"), original);
  } finally { await restored?.close(); await f.cleanup(); }
});

test("failed initial history persistence prevents executing the command or creating a session", async (t) => {
  const f = fixture();
  try {
    t.mock.method(f.store, "save", () => { throw new Error("Disk full"); });
    assert.equal(f.c.runShell("touch must-not-run"), false);
    assert.equal(existsSync(join(f.pb.path, "must-not-run")), false);
    assert.equal(f.store.state.sessions.length, 0); assert.equal(f.c.shellRun, undefined); assert.match(f.c.notice, /Disk full/);
    t.mock.restoreAll();
  } finally { t.mock.restoreAll(); await f.cleanup(); }
});

test("ordinary prompts containing ! remain prompts and an unstarted cancelled shell never executes", async () => {
  const f = fixture();
  try {
    f.app.composer.setValue("Explain what !pwd means"); f.terminal.onInput("\r"); await tick();
    assert.equal(f.engine.calls[0]?.prompt, "Explain what !pwd means"); assert.equal(f.c.dialog, undefined);
    const run = new ShellRun(f.pa.path, "touch must-not-run", () => {}); run.cancel(); await run.start();
    assert.equal(run.phase, "cancelled"); assert.equal(existsSync(join(f.pa.path, "must-not-run")), false);
    f.app.composer.setValue("!pwd"); assert.match(f.app.composer.render(120).map(stripTerminalSequences).join("\n"), /Local shell/);
  } finally { await f.cleanup(); }
});
