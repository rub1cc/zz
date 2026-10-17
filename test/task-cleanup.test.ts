import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, EntryDraft, Harness, ToolExecutionApi } from "@earendil-works/pi-durable";
import { TaskCleanup } from "../src/task-cleanup.js";
import { applyTaskBatch, createTaskExtension, TASK_COMPLETION_GRACE_MS, TasksDoc, updateTaskCompletion, type TaskState } from "../src/tasks.js";
import { UndoDoc } from "../src/undo.js";
import { ManualTaskClock } from "./task-cleanup-fixtures.js";
import { tick } from "./helpers.js";

const id = 1 as ConversationId;
function fixture() {
  const clock = new ManualTaskClock();
  const errors: unknown[] = [];
  const data: { tasks: TaskState; undo: { restoring?: boolean }; entries: EntryDraft[]; gate?: Promise<void>; failure?: Error } = {
    tasks: { nextId: 3, items: [
      { id: "1", subject: "First", status: "completed", blockedBy: [] },
      { id: "2", subject: "Second", status: "completed", blockedBy: ["1"] },
    ], receipts: { "12": "saved result" }, completedAt: 0 }, undo: {}, entries: [],
  };
  const harness = { commit: async (change: (tx: unknown) => Promise<unknown>) => {
    await data.gate;
    if (data.failure) throw data.failure;
    const tasks = structuredClone(data.tasks);
    const undo = structuredClone(data.undo);
    const entries: EntryDraft[] = [];
    const result = await change({ doc: async (token: unknown) => {
      assert.ok(token === TasksDoc || token === UndoDoc);
      return token === TasksDoc ? tasks : undo;
    }, appendEntry: async (_id: ConversationId, entry: EntryDraft) => { entries.push(entry); } });
    data.tasks = tasks; data.undo = undo; data.entries.push(...entries);
    return result;
  } } as unknown as Harness;
  const cleanup = new TaskCleanup(harness, (error) => errors.push(error), clock);
  return { clock, errors, data, harness, cleanup, watch: (blocked = () => false) => cleanup.watch(id, data.tasks, blocked) };
}

test("completed checklists stay visible for five seconds, then clear atomically without resetting IDs or receipts", async () => {
  const f = fixture();
  try {
    f.watch(); f.watch();
    assert.equal(f.clock.scheduled, 1);
    await f.clock.advance(4999);
    assert.equal(f.data.tasks.items.length, 2);
    assert.equal(f.data.entries.length, 0);
    await f.clock.advance(1);
    assert.deepEqual(f.data.tasks, { nextId: 3, items: [], receipts: { "12": "saved result" } });
    assert.equal(f.clock.scheduled, 0);
    assert.deepEqual(f.data.entries, [{ kind: "zz.tasks_cleared", data: { count: 2, completedAt: 0, timestamp: 5000 } }]);
    assert.deepEqual(f.errors, []);
  } finally { await f.cleanup.close(); }
});

test("open or empty lists do not arm cleanup, and reopening or adding work cancels the timer", async () => {
  for (const action of ["reopen", "create", "empty"]) {
    const f = fixture();
    try {
      f.watch(); await f.clock.advance(2000);
      if (action === "reopen") applyTaskBatch(f.data.tasks, { operations: [{ action: "update", taskId: "2", status: "pending" }] }, f.clock.now());
      else if (action === "create") applyTaskBatch(f.data.tasks, { operations: [{ action: "create", subject: "New work" }] }, f.clock.now());
      else { f.data.tasks.items = []; updateTaskCompletion(f.data.tasks, f.clock.now()); }
      f.watch();
      assert.equal(f.clock.scheduled, 0);
      await f.clock.advance(10000);
      assert.equal(f.data.entries.length, 0);
      assert.equal(f.data.tasks.items.length, action === "empty" ? 0 : action === "create" ? 3 : 2);
    } finally { await f.cleanup.close(); }
  }
});

test("cleanup rechecks the committed list rather than trusting a stale timer or observer", async () => {
  const f = fixture();
  try {
    f.watch();
    f.data.tasks.items[1]!.status = "pending";
    // Deliberately leave the old completion timestamp and skip the watch notification.
    await f.clock.advance(5000);
    assert.equal(f.data.tasks.items.length, 2);
    assert.equal(f.data.entries.length, 0);
  } finally { await f.cleanup.close(); }
});

test("a new completion gets a fresh deadline and stale callbacks cannot clear it", async () => {
  const f = fixture();
  try {
    f.watch(); await f.clock.advance(1000);
    applyTaskBatch(f.data.tasks, { operations: [{ action: "update", taskId: "2", status: "pending" }] }, f.clock.now()); f.watch();
    await f.clock.advance(1000);
    applyTaskBatch(f.data.tasks, { operations: [{ action: "update", taskId: "2", status: "completed" }] }, f.clock.now()); f.watch();
    assert.equal(f.data.tasks.completedAt, 2000);
    await f.clock.advance(4999); assert.equal(f.data.tasks.items.length, 2);
    await f.clock.advance(1); assert.equal(f.data.tasks.items.length, 0);
  } finally { await f.cleanup.close(); }
});

test("a timer already waiting for its transaction cannot clear new or reopened work", async () => {
  const f = fixture(); let release!: () => void;
  try {
    f.data.gate = new Promise<void>((resolve) => { release = resolve; });
    f.watch();
    const firing = f.clock.advance(5000);
    await tick();
    applyTaskBatch(f.data.tasks, { operations: [{ action: "update", taskId: "2", status: "pending" }] }, f.clock.now());
    f.watch(); release(); await firing;
    assert.equal(f.data.tasks.items[1]?.status, "pending");
    assert.equal(f.data.entries.length, 0);
    assert.deepEqual(f.errors, []);
  } finally { release?.(); await f.cleanup.close(); }
});

test("undo blocks cleanup until restoration finishes", async () => {
  for (const durable of [true, false]) {
    const f = fixture(); let blocked = !durable;
    try {
      f.data.undo.restoring = durable;
      f.watch(() => blocked);
      await f.clock.advance(5000);
      assert.equal(f.data.tasks.items.length, 2);
      assert.equal(f.clock.scheduled, 1);
      blocked = false; f.data.undo.restoring = false;
      await f.clock.advance(1000);
      assert.equal(f.data.tasks.items.length, 0);
    } finally { await f.cleanup.close(); }
  }
});

test("shutdown and disposed conversations cancel timers; overdue deadlines run on the next observation", async () => {
  const f = fixture();
  f.watch(); f.cleanup.forget(id); await f.clock.advance(5000);
  assert.equal(f.data.tasks.items.length, 2);
  f.watch(); await f.cleanup.close(); await f.clock.advance(5000);
  assert.equal(f.data.tasks.items.length, 2);
  const restored = new TaskCleanup(f.harness, (error) => f.errors.push(error), f.clock);
  try {
    restored.watch(id, f.data.tasks, () => false);
    await f.clock.advance(0);
    assert.equal(f.data.tasks.items.length, 0);
  } finally { await restored.close(); }
});

test("cleanup errors are reported without clearing tasks or leaving a live timer", async () => {
  const f = fixture();
  try {
    f.data.failure = new Error("Storage unavailable"); f.watch();
    await f.clock.advance(TASK_COMPLETION_GRACE_MS);
    assert.equal(f.data.tasks.items.length, 2);
    assert.equal(f.data.entries.length, 0);
    assert.equal(f.clock.scheduled, 0);
    assert.match(String(f.errors[0]), /Storage unavailable/);
  } finally { await f.cleanup.close(); }
});

test("shutdown waits for an admitted cleanup transaction and prevents late clearing", async () => {
  const f = fixture(); let release!: () => void;
  try {
    f.data.gate = new Promise<void>((resolve) => { release = resolve; }); f.watch();
    const firing = f.clock.advance(5000); await tick();
    let closed = false;
    const closing = f.cleanup.close().then(() => { closed = true; });
    await tick(); assert.equal(closed, false);
    release(); await Promise.all([firing, closing]);
    assert.equal(f.data.tasks.items.length, 2);
    assert.equal(f.data.entries.length, 0);
    assert.equal(f.clock.scheduled, 0);
  } finally { release?.(); await f.cleanup.close(); }
});

test("replaying a committed task mutation after cleanup returns its receipt without resurrecting tasks", async () => {
  const f = fixture();
  try {
    f.watch(); await f.clock.advance(5000);
    const tool = createTaskExtension(() => f.clock.now()).tools![0]!;
    const api = { conversationId: id, taskId: 12, commit: f.harness.commit.bind(f.harness) } as unknown as ToolExecutionApi;
    const result = await tool.execute({ operations: [{ action: "create", subject: "Already completed" }] }, api,
      BACKGROUND_CONTEXT);
    assert.deepEqual(result.output, [{ type: "text", text: "saved result" }]);
    assert.deepEqual(f.data.tasks.items, []);
    assert.equal(f.data.tasks.nextId, 3);
    assert.equal(f.data.tasks.completedAt, undefined);
  } finally { await f.cleanup.close(); }
});
