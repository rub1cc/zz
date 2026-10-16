import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { shimmer } from "../src/format.js";
import { finishWork, type Session } from "../src/model.js";
import { workLabel } from "../src/transcript.js";

function session(): Session {
  return { id: "work", projectId: "/project", title: "Test", status: "working", preview: "", createdAt: 1, updatedAt: 1, messages: [],
    work: { startedAt: new Date(2026, 0, 1, 15, 21, 57).getTime() } };
}

test("work status shimmers while running and records a stable local completion time", () => {
  const s = session();
  const end = new Date(2026, 0, 1, 15, 22).getTime();
  finishWork(s, end);
  assert.equal(s.work?.finishedAt, undefined);
  assert.match(stripTerminalSequences(workLabel(s)!), /^[✽✻✢∙] Working$/);
  s.status = "completed";
  finishWork(s, end);
  assert.equal(stripTerminalSequences(workLabel(s)!), "✻ Worked for 3s · done 3:22 PM");
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
  const s = session();
  let now = 0;
  t.mock.method(Date, "now", () => now);
  for (const [index, icon] of ["✽", "✻", "✢", "∙", "✢", "✻", "✽", "✽"].entries()) {
    now = index * 160;
    const label = workLabel(s)!;
    assert.equal(stripTerminalSequences(label), `${icon} Working`);
    assert.equal(visibleWidth(label), visibleWidth("✻ Working"));
  }
  for (const env of ["ZZ_REDUCED_MOTION", "NO_COLOR"]) {
    process.env[env] = "1";
    for (now of [0, 160, 480, 1120]) assert.equal(stripTerminalSequences(workLabel(s)!), "✽ Working");
    delete process.env[env];
  }
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
    assert.ok(stripTerminalSequences(workLabel(s)!).includes(`· ${label} `));
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
