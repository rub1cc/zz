import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { TaskDisplay, taskChecklist, taskDetails, taskVisibleLimit } from "../src/task-display.js";
import type { ChecklistTask } from "../src/tasks.js";
import { ManualTaskClock } from "./task-cleanup-fixtures.js";

const task = (id: number, status: ChecklistTask["status"] = "pending", blockedBy: string[] = []): ChecklistTask => ({
  id: String(id), subject: `Task ${id}`, status, blockedBy,
});
const plain = (lines: string[]) => lines.map(stripTerminalSequences);
const ids = (lines: string[]) => plain(lines).flatMap((line) => {
  const match = line.match(/Task (\d+)/); return match ? [Number(match[1])] : [];
});
function fixture(tasks: ChecklistTask[] = [task(1, "in_progress"), ...[2, 3, 4, 5, 6].map((id) => task(id))]) {
  const clock = new ManualTaskClock(); let redraws = 0;
  const display = new TaskDisplay(() => { redraws++; }, clock);
  const session = { id: "main", conversationId: 1, tasks };
  const sync = () => display.sync([session]);
  const render = () => display.render(session, 100, 7, 24);
  sync();
  return { clock, display, session, sync, render, get redraws() { return redraws; } };
}

test("Claude task limits show five items normally, three or four on shorter terminals and summary only below eleven rows", () => {
  for (const [height, count] of [[40, 5], [24, 5], [19, 5], [18, 4], [17, 3], [11, 3], [10, 0], [1, 0]]) {
    assert.equal(taskVisibleLimit(height!), count);
  }
});

test("a fitting checklist and full details use numeric creation order regardless of status, without mutating task data", () => {
  const tasks = [task(10, "in_progress"), task(3, "completed"), task(2), task(1, "completed")];
  const before = structuredClone(tasks);
  const options = { completedAt: new Map([["3", 0]]), now: 1 };
  assert.deepEqual(ids(taskChecklist(tasks, 100, 7, options)), [1, 2, 3, 10]);
  assert.deepEqual(ids(taskDetails(tasks, 100)), [1, 2, 3, 10]);
  assert.deepEqual(tasks, before);
});

test("overflow prioritizes recent completions, active work, ready pending work, blocked pending work, then older completions", () => {
  const tasks = [task(1, "completed"), task(2, "pending", ["5"]), task(3, "completed"), task(4), task(5, "in_progress"), task(6), task(7, "pending", ["1"])];
  const lines = taskChecklist(tasks, 100, 7, { completedAt: new Map([["3", 0]]), now: 1 });
  assert.deepEqual(ids(lines), [3, 5, 4, 6, 7]);
  assert.match(plain(lines).at(-1)!, /\u2026 \+1 pending, 1 completed/);
  assert.doesNotMatch(plain(lines).join("\n"), /blocked|#[1-7]/);
  const blocked = taskChecklist(tasks, 100, 8, { limit: 6, completedAt: new Map([["3", 0]]), now: 1 });
  assert.deepEqual(ids(blocked), [3, 5, 4, 6, 7, 2]);
});

test("overflow counts each hidden status, and terminal space can reduce the limit without overflowing the line budget", () => {
  const tasks = [task(1, "in_progress"), task(2, "in_progress"), task(3), task(4, "completed")];
  assert.match(plain(taskChecklist(tasks, 100, 3)).at(-1)!, /\+1 in progress, 1 pending, 1 completed/);
  assert.equal(taskChecklist(tasks, 100, 7, { limit: 0 }).length, 1);
  for (let budget = 0; budget <= 8; budget++) assert.ok(taskChecklist(tasks, 100, budget).length <= budget);
  const six = Array.from({ length: 6 }, (_, i) => task(i + 1));
  assert.deepEqual(ids(taskChecklist(six, 100)), [1, 2, 3, 4, 5]);
  assert.match(plain(taskChecklist(six, 100)).at(-1)!, /\+1 pending/);
});

test("newly completed work stays prioritized for exactly thirty seconds and triggers a redraw without other updates", async () => {
  const f = fixture();
  try {
    f.session.tasks[0]!.status = "completed"; f.session.tasks[1]!.status = "in_progress"; f.sync();
    assert.deepEqual(ids(f.render()), [1, 2, 3, 4, 5]);
    assert.equal(f.clock.scheduled, 1);
    await f.clock.advance(15_000); f.sync(); f.render();
    assert.equal(f.clock.scheduled, 1, "ordinary rendering must not restart the grace period");
    await f.clock.advance(14_999); assert.deepEqual(ids(f.render()), [1, 2, 3, 4, 5]);
    const before = structuredClone(f.session.tasks);
    await f.clock.advance(1);
    assert.equal(f.redraws, 1);
    assert.deepEqual(ids(f.render()), [2, 3, 4, 5, 6]);
    assert.match(plain(f.render()).at(-1)!, /\+1 completed/);
    assert.deepEqual(f.session.tasks, before, "expiry changes presentation, not durable task state");
    assert.equal(f.clock.scheduled, 0);
  } finally { f.display.close(); }
});

test("initially completed tasks are old, while later completions each get their own deadline", async () => {
  const f = fixture([task(1, "completed"), ...[2, 3, 4, 5, 6].map((id) => task(id))]);
  try {
    assert.deepEqual(ids(f.render()), [2, 3, 4, 5, 6]);
    assert.equal(f.clock.scheduled, 0);
    f.session.tasks[1]!.status = "completed"; f.sync();
    await f.clock.advance(10_000);
    f.session.tasks[2]!.status = "completed"; f.sync();
    await f.clock.advance(20_000); assert.equal(f.redraws, 1);
    assert.deepEqual(ids(f.render()), [3, 4, 5, 6, 1]);
    await f.clock.advance(10_000); assert.equal(f.redraws, 2);
    assert.deepEqual(ids(f.render()), [4, 5, 6, 1, 2]);
  } finally { f.display.close(); }
});

test("reopening cancels recency and recompletion gets a new deadline", async () => {
  const f = fixture();
  try {
    f.session.tasks[0]!.status = "completed"; f.sync(); await f.clock.advance(10_000);
    f.session.tasks[0]!.status = "pending"; f.sync(); assert.equal(f.clock.scheduled, 0);
    f.session.tasks[0]!.status = "completed"; f.sync();
    await f.clock.advance(20_000); assert.equal(f.redraws, 0);
    await f.clock.advance(10_000); assert.equal(f.redraws, 1);
  } finally { f.display.close(); }
});

test("session isolation, undo forks, cleared or deleted lists and shutdown discard their recency timers", async () => {
  const f = fixture();
  try {
    f.session.tasks[0]!.status = "completed"; f.sync();
    const other = { ...f.session, id: "other", tasks: structuredClone(f.session.tasks) };
    f.display.sync([f.session, other]);
    assert.deepEqual(ids(f.display.render(other, 100, 7, 24)), [2, 3, 4, 5, 6]);
    assert.deepEqual(ids(f.render()), [1, 2, 3, 4, 5]);
    f.session.conversationId = 2; f.sync();
    assert.equal(f.clock.scheduled, 0);
    assert.deepEqual(ids(f.render()), [2, 3, 4, 5, 6]);
    f.session.tasks[1]!.status = "completed"; f.sync(); assert.equal(f.clock.scheduled, 1);
    f.session.tasks = []; f.sync(); assert.equal(f.clock.scheduled, 0);
    assert.deepEqual(f.render(), []);
    f.session.tasks = [task(1)]; f.sync(); f.session.tasks[0]!.status = "completed"; f.sync();
    assert.equal(f.clock.scheduled, 1);
    f.display.sync([]); assert.equal(f.clock.scheduled, 0);
    f.session.tasks = [task(1)]; f.sync(); f.session.tasks[0]!.status = "completed"; f.sync();
    f.display.close(); await f.clock.advance(30_000);
    assert.equal(f.clock.scheduled, 0); assert.equal(f.redraws, 0);
    assert.deepEqual(f.render(), []);
  } finally { f.display.close(); }
});

test("cancelled callbacks cannot redraw or overwrite a newer completion timer", async () => {
  const clock = new ManualTaskClock(); const callbacks: (() => void)[] = []; let redraws = 0;
  const display = new TaskDisplay(() => { redraws++; }, { now: () => clock.now(), schedule: (delay, callback) => {
    callbacks.push(callback); return clock.schedule(delay, callback);
  } });
  const session = { id: "stale", tasks: [task(1)] };
  try {
    display.sync([session]); session.tasks[0]!.status = "completed"; display.sync([session]);
    session.tasks[0]!.status = "pending"; display.sync([session]);
    await clock.advance(1000);
    session.tasks[0]!.status = "completed"; display.sync([session]);
    callbacks[0]!(); assert.equal(redraws, 0); assert.equal(clock.scheduled, 1);
    await clock.advance(30_000); assert.equal(redraws, 1);
    display.close(); callbacks[1]!(); assert.equal(redraws, 1);
  } finally { display.close(); }
});
