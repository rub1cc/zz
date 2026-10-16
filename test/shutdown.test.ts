import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { createShutdown } from "../src/shutdown.js";
import { temporary } from "./helpers.js";

test("shutdown restores the terminal, saves before releasing the lock, and explicitly exits", async () => {
  const events: string[] = [];
  const shutdown = createShutdown({
    prepare: () => { events.push("prepare"); }, close: async () => { events.push("close"); },
    restoreTerminal: () => { events.push("restore"); }, release: async () => { events.push("release"); },
    report: () => assert.fail("No shutdown failure expected"), exit: (code) => { events.push(`exit:${code}`); },
  });
  shutdown.request(); await shutdown.done;
  assert.deepEqual(events, ["prepare", "restore", "close", "release", "exit:0"]);
  shutdown.request(); assert.equal(events.length, 5);
});

test("a second interrupt forces exit without releasing an active database lock", async () => {
  let finish!: () => void;
  const closing = new Promise<void>((resolve) => { finish = resolve; });
  const exits: number[] = []; const errors: unknown[] = []; let released = false;
  const shutdown = createShutdown({ prepare() {}, close: () => closing, restoreTerminal() {},
    release: async () => { released = true; }, report: (error) => errors.push(error), exit: (code) => { exits.push(code); } });
  shutdown.request(); await Promise.resolve(); shutdown.request();
  assert.deepEqual(exits, [130]); assert.equal(released, false); assert.match(String(errors[0]), /Forced exit/);
  finish(); await shutdown.done;
  assert.deepEqual(exits, [130]); assert.equal(released, false);
});

test("stalled cleanup has a hard deadline, including stalled lock release", async () => {
  for (const stage of ["close", "release"]) {
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    let exited!: (code: number) => void;
    const exit = new Promise<number>((resolve) => { exited = resolve; });
    const errors: unknown[] = []; let restored = false;
    const shutdown = createShutdown({ prepare() {}, restoreTerminal: () => { restored = true; },
      close: () => stage === "close" ? blocked : Promise.resolve(),
      release: () => stage === "release" ? blocked : Promise.resolve(),
      exit: exited, report: (error) => errors.push(error), timeoutMs: 20 });
    shutdown.request(); assert.equal(await exit, 130);
    assert.equal(restored, true); assert.match(String(errors[0]), /timed out/);
    unblock(); await shutdown.done;
  }
});

test("cleanup failure still restores the terminal and exits with an error", async () => {
  const failure = new Error("storage failed"); const errors: unknown[] = []; const exits: number[] = [];
  let restored = false;
  const shutdown = createShutdown({ prepare() {}, restoreTerminal: () => { restored = true; },
    close: async () => { throw failure; }, release: async () => assert.fail("Do not release before successful closure"),
    report: (error) => errors.push(error), exit: (code) => { exits.push(code); } });
  shutdown.request(); await shutdown.done;
  assert.equal(restored, true); assert.deepEqual(errors, [failure]); assert.deepEqual(exits, [1]);
});

for (const stalled of [false, true]) test(stalled
  ? "real CLI accepts a second interrupt while its shutdown is stalled"
  : "real CLI exits after Ctrl+C even if a dependency leaves a keepalive handle", { timeout: 30000 }, async () => {
  const temp = temporary();
  const preload = 'Object.defineProperty(process.stdin,"isTTY",{value:true}); Object.defineProperty(process.stdout,"isTTY",{value:true}); process.stdin.setRawMode=function(value){this.isRaw=value;return this;}; setInterval(()=>{},1000);'
    + (stalled ? `const {DurableEngine}=await import(${JSON.stringify(pathToFileURL(resolve("src/engine.ts")).href)}); DurableEngine.prototype.close=()=>new Promise(()=>{});` : "");
  const child = spawn(process.execPath, ["--import", "tsx", "--import", `data:text/javascript,${encodeURIComponent(preload)}`, "src/cli.ts", "--data-dir", temp.root], {
    cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: temp.root, TMPDIR: temp.root, TSX_DISABLE_CACHE: "1", PI_OFFLINE: "1",
      PI_CODING_AGENT_DIR: join(temp.root, "pi"), TERM: "xterm-256color", COLUMNS: "100", LINES: "28" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = ""; let sent = false; let forced = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectWait: (error: Error) => void = () => {};
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
    if (!sent && stripTerminalSequences(output).includes("describe a task for a new session")) {
      sent = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => rejectWait(new Error(`CLI shutdown did not finish: ${output.slice(-500)}`)), 2000);
      child.stdin.write("\x03");
    }
    if (stalled && !forced && output.includes("\x1b[?1049l")) { forced = true; child.kill("SIGINT"); }
  });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, reject) => {
      rejectWait = reject;
      // SDK/tsx cold startup competes with the full suite; shutdown has its own strict deadline.
      timer = setTimeout(() => reject(new Error(`CLI did not start: ${output.slice(-500)}`)), 20000);
      child.on("error", reject); child.on("close", (code, signal) => done({ code, signal }));
    });
    assert.equal(sent, true); assert.deepEqual(result, { code: stalled ? 130 : 0, signal: null });
    if (stalled) { assert.equal(forced, true); assert.match(output, /Forced exit/); }
    assert.ok(output.includes("\x1b[?1049l"), "alternate-screen cleanup is emitted before exit");
  } finally {
    if (timer) clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>((done) => child.once("close", () => done())); child.kill("SIGKILL"); await closed;
    }
    temp.cleanup();
  }
});
