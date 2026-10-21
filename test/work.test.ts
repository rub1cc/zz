import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { shimmer, statusRefreshInterval } from "../src/format.js";
import { finishWork, startWork, type Session } from "../src/model.js";
import { emptyUsage } from "../src/usage.js";
import { workLabel } from "../src/transcript.js";

function session(): Session {
  return { id: "work", projectId: "/project", title: "Test", status: "working", preview: "", createdAt: 1, updatedAt: 1, messages: [],
    work: { startedAt: new Date(2026, 0, 1, 15, 21, 57).getTime() } };
}

test("work status shimmers while running and only long successful runs have receipts", (t) => {
  const s = session();
  const end = new Date(2026, 0, 1, 15, 22).getTime();
  t.mock.method(Date, "now", () => end);
  finishWork(s, end);
  assert.equal(s.work?.finishedAt, undefined);
  assert.match(stripTerminalSequences(workLabel(s)!), /^[✽✻✢∙] Working \(\d+s\)$/);
  s.status = "completed";
  finishWork(s, end);
  assert.equal(workLabel(s), undefined);
  s.work!.finishedAt = s.work!.startedAt + 10000;
  assert.equal(stripTerminalSequences(workLabel(s)!), "✽ Worked for 10s");
  s.work!.finishedAt = end;
  finishWork(s, end + 10_000);
  assert.equal(s.work?.finishedAt, end);
});

test("session Working indicator loops the shared icons and respects reduced motion", (t) => {
  const oldMotion = process.env.ZZ_REDUCED_MOTION;
  const oldColor = process.env.NO_COLOR;
  t.after(() => {
    if (oldMotion === undefined) delete process.env.ZZ_REDUCED_MOTION; else process.env.ZZ_REDUCED_MOTION = oldMotion;
    if (oldColor === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = oldColor;
  });
  delete process.env.ZZ_REDUCED_MOTION;
  delete process.env.NO_COLOR;
  assert.equal(statusRefreshInterval(true), 80);
  assert.equal(statusRefreshInterval(false), 30_000);
  const s = session();
  s.work = { startedAt: 0, outputTokensStart: 0, outputTokens: 1234 };
  let now = 0;
  t.mock.method(Date, "now", () => now);
  for (const [index, icon] of ["✽", "✻", "✢", "∙", "✢", "✻", "✽", "✽"].entries()) {
    now = index * 160;
    const label = workLabel(s)!;
    assert.equal(stripTerminalSequences(label), `${icon} Working (${Math.floor(now / 1000)}s)`);
    assert.equal(visibleWidth(label), visibleWidth("✻ Working (0s)"));
    assert.doesNotMatch(stripTerminalSequences(label), /tokens|1,234/);
  }
  for (const env of ["ZZ_REDUCED_MOTION", "NO_COLOR"]) {
    process.env[env] = "1";
    assert.equal(statusRefreshInterval(true), 1000, "elapsed seconds refresh even without motion");
    assert.equal(statusRefreshInterval(false), 30_000);
    for (now of [0, 160, 480, 1120]) {
      assert.equal(stripTerminalSequences(workLabel(s)!), `✽ Working (${Math.floor(now / 1000)}s)`);
    }
    delete process.env[env];
  }
});

test("working elapsed time rolls through minutes, hours and days and retains intermediate zero units", (t) => {
  const s = session();
  s.work = { startedAt: 0 };
  let now = 0;
  t.mock.method(Date, "now", () => now);
  const cases: [number, string][] = [
    [-1000, "0s"], [0, "0s"], [999, "0s"], [1000, "1s"], [59999, "59s"],
    [60000, "1m 0s"], [62000, "1m 2s"], [3599999, "59m 59s"],
    [3600000, "1h 0m 0s"], [3601000, "1h 0m 1s"], [3662000, "1h 1m 2s"],
    [86399999, "23h 59m 59s"], [86400000, "1d 0h 0m 0s"], [87615000, "1d 0h 20m 15s"],
    [90061000, "1d 1h 1m 1s"], [172800000, "2d 0h 0m 0s"],
  ];
  for (const [elapsed, expected] of cases) {
    now = elapsed;
    assert.ok(stripTerminalSequences(workLabel(s)!).endsWith(`Working (${expected})`));
  }
});

test("work statistics reset between runs, preserve unknown legacy usage and clamp elapsed time", (t) => {
  const s = session();
  startWork(s, 1000);
  assert.deepEqual(s.work, { startedAt: 1000, outputTokensStart: 0, outputTokens: 0 });
  t.mock.method(Date, "now", () => 900);
  assert.match(stripTerminalSequences(workLabel(s)!), /Working \(0s\)$/);
  s.usage = { ...emptyUsage(), output: 2000 };
  s.titleUsage = { ...emptyUsage(), output: 9999 };
  startWork(s, 0);
  assert.deepEqual(s.work, { startedAt: 0, outputTokensStart: 2000, outputTokens: 0 });
  s.work!.outputTokens = 50;
  s.preview = "Thinking...";
  assert.match(stripTerminalSequences(workLabel(s)!), /Thinking\.\.\. \(0s\)$/);
  s.preview = "Retrying: rate limit";
  assert.match(stripTerminalSequences(workLabel(s)!), /Retrying: rate limit \(0s\)$/);
  s.stopped = true;
  assert.match(stripTerminalSequences(workLabel(s)!), /Stopping\.\.\. \(0s\)$/);
  delete s.work;
  assert.match(stripTerminalSequences(workLabel(s)!), /\(\?s\)$/);
  delete s.usage;
  s.conversationId = 1;
  startWork(s, 1000);
  assert.deepEqual(s.work, { startedAt: 1000 });
});

test("failed, waiting, paused, and legacy sessions are not falsely labelled done", () => {
  const s = session();
  s.status = "paused";
  finishWork(s);
  assert.equal(s.work?.finishedAt, undefined);
  assert.equal(workLabel(s), undefined);
  for (const [status, label] of [["failed", "failed"], ["needs-input", "awaiting input"]] as const) {
    s.status = status;
    finishWork(s, s.work!.startedAt + 3000);
    assert.equal(workLabel(s), undefined, label);
  }
  delete s.work;
  s.status = "completed";
  assert.equal(workLabel(s), undefined);
});

test("shimmer preserves its text and width, changes frames, and supports reduced motion", (t) => {
  const oldMotion = process.env.ZZ_REDUCED_MOTION;
  const oldColor = process.env.NO_COLOR;
  t.after(() => {
    if (oldMotion === undefined) delete process.env.ZZ_REDUCED_MOTION; else process.env.ZZ_REDUCED_MOTION = oldMotion;
    if (oldColor === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = oldColor;
  });
  delete process.env.ZZ_REDUCED_MOTION;
  delete process.env.NO_COLOR;
  const first = shimmer("✻ Working", 500);
  const next = shimmer("✻ Working", 1000);
  assert.notEqual(first, next);
  assert.equal(stripTerminalSequences(first), "✻ Working");
  assert.equal(visibleWidth(first), visibleWidth("✻ Working"));
  process.env.ZZ_REDUCED_MOTION = "1";
  assert.equal(shimmer("✻ Working", 500), shimmer("✻ Working", 1000));
  delete process.env.ZZ_REDUCED_MOTION;
  process.env.NO_COLOR = "1";
  assert.equal(shimmer("✻ Working", 500), shimmer("✻ Working", 1000));
});

test("status shimmer follows reported terminal foreground/background without changing text", async (t) => {
  const { setStatusColors } = await import("../src/format.js");
  const motion = process.env.ZZ_REDUCED_MOTION, noColor = process.env.NO_COLOR;
  delete process.env.ZZ_REDUCED_MOTION; delete process.env.NO_COLOR;
  t.after(() => {
    if (motion === undefined) delete process.env.ZZ_REDUCED_MOTION; else process.env.ZZ_REDUCED_MOTION = motion;
    if (noColor === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = noColor;
    setStatusColors({});
  });
  const label = "✽ Working";
  setStatusColors({ background: { r: 255, g: 255, b: 255 }, foreground: { r: 20, g: 30, b: 40 } });
  const light = shimmer(label, 500);
  setStatusColors({ background: { r: 20, g: 20, b: 20 }, foreground: { r: 240, g: 240, b: 240 } });
  const dark = shimmer(label, 500);
  assert.notEqual(light, dark);
  assert.equal(stripTerminalSequences(light), label); assert.equal(stripTerminalSequences(dark), label);
});
