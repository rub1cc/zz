import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonObject } from "@earendil-works/pi-durable";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { applyTaskBatch, createTask, getTask, legacyTaskExtension, prepareTaskUpdate, taskExtension, unresolvedDependencies, updateTask, type TaskState } from "../src/tasks.js";
import { taskChecklist, taskDetails, taskProgress } from "../src/task-display.js";
import { Store } from "../src/store.js";
import { temporary } from "./helpers.js";

const state = (): TaskState => ({ nextId: 1, items: [], receipts: {} });

test("tasks have stable IDs, editable details, dependencies and an explicit lifecycle", () => {
  const tasks = state();
  const first = createTask(tasks, { subject: "Inspect auth", description: "Check current tokens", activeForm: "Inspecting auth" });
  const second = createTask(tasks, { subject: "Implement reset", blockedBy: [first.id] });
  const third = createTask(tasks, { subject: "Run tests", blockedBy: [second.id] });
  assert.deepEqual([first.id, second.id, third.id], ["1", "2", "3"]);
  assert.equal(first.status, "pending");
  assert.equal(getTask(tasks, "1").description, "Check current tokens");
  assert.deepEqual(unresolvedDependencies(tasks, second), ["1"]);
  updateTask(tasks, { taskId: "1", status: "in_progress" });
  updateTask(tasks, { taskId: "1", status: "completed" });
  assert.deepEqual(unresolvedDependencies(tasks, second), []);
  updateTask(tasks, { taskId: "2", status: "in_progress", activeForm: "Implementing reset" });
  assert.equal(getTask(tasks, "2").activeForm, "Implementing reset");
  updateTask(tasks, { taskId: "2", subject: "Implement reset endpoint", description: "Token expiry is required" });
  assert.equal(getTask(tasks, "2").subject, "Implement reset endpoint");
  updateTask(tasks, { taskId: "3", removeBlockedBy: ["2"], addBlockedBy: ["1"] });
  assert.deepEqual(getTask(tasks, "3").blockedBy, ["1"]);
});

test("invalid IDs, blocked transitions and cycles leave tasks unchanged", () => {
  const tasks = state();
  createTask(tasks, { subject: "Inspect" });
  createTask(tasks, { subject: "Implement", blockedBy: ["1"] });
  createTask(tasks, { subject: "Test", blockedBy: ["2"] });
  const invalid = [
    () => createTask(tasks, { subject: "Missing prerequisite", blockedBy: ["99"] }),
    () => createTask(tasks, { subject: "Self", blockedBy: ["4"] }),
    () => updateTask(tasks, { taskId: "99", status: "completed" }),
    () => updateTask(tasks, { taskId: "2", status: "in_progress" }),
    () => updateTask(tasks, { taskId: "2", status: "completed" }),
    () => updateTask(tasks, { taskId: "1", addBlockedBy: ["3"] }),
    () => updateTask(tasks, { taskId: "1", addBlockedBy: ["1"] }),
    () => updateTask(tasks, { taskId: "1", addBlockedBy: ["99"] }),
    () => updateTask(tasks, { taskId: "2", addBlockedBy: ["1"], removeBlockedBy: ["1"] }),
  ];
  for (const change of invalid) {
    const before = structuredClone(tasks);
    assert.throws(change);
    assert.deepEqual(tasks, before);
  }
  updateTask(tasks, { taskId: "1", status: "completed" });
  updateTask(tasks, { taskId: "2", status: "in_progress" });
  assert.throws(() => updateTask(tasks, { taskId: "1", status: "pending" }), /unfinished prerequisites/);
  assert.equal(getTask(tasks, "1").status, "completed");
  updateTask(tasks, { taskId: "2", status: "pending" });
  updateTask(tasks, { taskId: "1", status: "pending" });
});

test("deleting obsolete tasks removes references without reusing IDs or completing dependents", () => {
  const tasks = state();
  createTask(tasks, { subject: "Obsolete" });
  createTask(tasks, { subject: "Keep", blockedBy: ["1"] });
  assert.deepEqual(updateTask(tasks, { taskId: "1", status: "deleted" }), { id: "1", status: "deleted" });
  assert.deepEqual(tasks.items.map(({ id, status, blockedBy }) => ({ id, status, blockedBy })), [
    { id: "2", status: "pending", blockedBy: [] },
  ]);
  assert.equal(createTask(tasks, { subject: "New" }).id, "3");
  assert.throws(() => getTask(tasks, "1"), /No task/);
});

test("the batch schema requires explicit actions, valid task fields and bounded nonempty operations", () => {
  const update = taskExtension.tools!.find((tool) => tool.name === "task_update")!;
  const check = (args: JsonObject) => validateToolArguments(update, { type: "toolCall", id: "test", name: update.name, arguments: args });
  const invalid: JsonObject[] = [
    {}, { operations: [] }, { operations: Array.from({ length: 101 }, () => ({ action: "create", subject: "Task" })) },
    ...([{}, { subject: "Missing action" }, { action: "bad" }, { action: "create", subject: " " },
      { action: "create", subject: "a".repeat(201) }, { action: "create", subject: "Valid", activeForm: " " },
      { action: "create", subject: "Valid", blockedBy: ["1", "1"] }, { action: "create", subject: "Valid", blockedBy: ["0"] },
      { action: "create", subject: "Valid", ref: "1bad" }, { action: "create", subject: "Valid", blockedBy: [{ ref: "" }] },
      { action: "update", taskId: "0" }, { action: "update", taskId: "1", status: "deleted" },
      { action: "update", taskId: "1", status: "blocked" }, { action: "delete" },
    ] as JsonObject[]).map((op) => ({ operations: [op] })),
  ];
  for (const args of invalid) assert.throws(() => check(args), JSON.stringify(args));
  assert.ok(check({ operations: [{ action: "create", subject: "Valid", ref: "auth", blockedBy: ["1", { ref: "setup" }] }] }));
  assert.deepEqual(taskExtension.tools!.map((tool) => tool.name), ["task_update", "task_list", "task_get"]);
});

test("safe batch tools replay the whole saved result without duplicating creates or deletes", async () => {
  let tasks = state();
  const api = { conversationId: 1, taskId: 100,
    commit: async (change: (tx: { doc: () => Promise<TaskState> }) => Promise<unknown>) => {
      const draft = structuredClone(tasks);
      const result = await change({ doc: async () => draft });
      tasks = draft;
      return result;
    },
  } as unknown as ToolExecutionApi;
  const update = taskExtension.tools!.find((tool) => tool.name === "task_update")!;
  assert.equal(update.replay, "safe");
  const args = { operations: [{ action: "create", subject: "First" }, { action: "create", subject: "Second" }] };
  const first = await update.execute(args, api, BACKGROUND_CONTEXT);
  assert.deepEqual(await update.execute(args, api, BACKGROUND_CONTEXT), first);
  assert.equal(tasks.items.length, 2);
  const deleteApi = { ...api, taskId: 101 } as unknown as ToolExecutionApi;
  const deletes = { operations: [{ action: "delete", taskId: "1" }, { action: "delete", taskId: "2" }] };
  const deleted = await update.execute(deletes, deleteApi, BACKGROUND_CONTEXT);
  assert.deepEqual(await update.execute(deletes, deleteApi, BACKGROUND_CONTEXT), deleted);
  assert.equal(tasks.items.length, 0);
  assert.equal(tasks.nextId, 3);
  const before = structuredClone(tasks);
  await assert.rejects(update.execute({ operations: [{ action: "create", subject: "Rollback" }, { action: "delete", taskId: "99" }] },
    { ...api, taskId: 102 } as unknown as ToolExecutionApi, BACKGROUND_CONTEXT));
  assert.deepEqual(tasks, before);

  const legacy = legacyTaskExtension.tools![0]!;
  const legacyApi = { ...api, taskId: 103 } as unknown as ToolExecutionApi;
  const created = await legacy.execute({ subject: "Old create" }, legacyApi, BACKGROUND_CONTEXT);
  assert.deepEqual(await legacy.execute({ subject: "Old create" }, legacyApi, BACKGROUND_CONTEXT), created);
  assert.equal(tasks.items.length, 1);
  const oldUpdateApi = { ...api, taskId: 104 } as unknown as ToolExecutionApi;
  await update.execute({ taskId: "3", status: "completed" }, oldUpdateApi, BACKGROUND_CONTEXT);
  assert.equal(tasks.items[0]?.status, "completed", "saved old intents bypass prepareArguments during recovery");
});

test("legacy single updates normalize without exposing the old schema to the model", () => {
  assert.deepEqual(prepareTaskUpdate({ taskId: "1", status: "completed", activeForm: "Checking" }), {
    operations: [{ action: "update", taskId: "1", status: "completed", activeForm: "Checking" }],
  });
  assert.deepEqual(prepareTaskUpdate({ taskId: "1", status: "deleted" }), { operations: [{ action: "delete", taskId: "1" }] });
  assert.throws(() => prepareTaskUpdate({ subject: "Ambiguous creation" }));
});

test("checklist rendering is bounded, safe and never displays dependency annotations", () => {
  const tasks = state();
  createTask(tasks, { subject: "Inspect auth" });
  createTask(tasks, { subject: "Implement auth", activeForm: "Implementing auth", blockedBy: ["1"] });
  createTask(tasks, { subject: "Run tests", description: "Verify tokens\nincluding expiry", blockedBy: ["2"] });
  updateTask(tasks, { taskId: "1", status: "completed" });
  updateTask(tasks, { taskId: "2", status: "in_progress" });
  assert.equal(taskProgress(tasks.items), "3 tasks (1 done, 1 in progress, 1 open)");
  assert.equal(taskProgress([]), undefined);
  const colored = taskChecklist(tasks.items, 100).join("\n");
  const rendered = stripTerminalSequences(colored);
  assert.match(rendered, /\u2612 Inspect auth/);
  assert.match(rendered, /\u25a0 Implementing auth/);
  assert.match(rendered, /^3 tasks \(1 done, 1 in progress, 1 open\) \(\/tasks\)/);
  assert.match(rendered, /\u2610 Run tests/);
  assert.doesNotMatch(rendered, /\[>\]|\[x\]|\[ \]/);
  assert.match(colored, /\x1b\[32m  \u2612 Inspect auth/);
  assert.ok(colored.includes("  \x1b[38;5;214m\u25a0\x1b[39m \x1b[1m\x1b[30mImplementing auth\x1b[39m\x1b[22m"));
  assert.match(colored, /\x1b\[2m  \u2610 Run tests/);
  assert.doesNotMatch(rendered, /blocked|blockedBy|depends|#\d+/);
  const details = taskDetails(tasks.items, 100).map(stripTerminalSequences).join("\n");
  assert.match(details, /including expiry/);
  assert.doesNotMatch(details, /blocked|blockedBy|depends|#\d+/);
  createTask(tasks, { subject: "Unsafe\x1b[2J\r\n" + "\u754c".repeat(40) });
  for (let i = 0; i < 10; i++) createTask(tasks, { subject: `Later ${i}` });
  for (const width of [1, 8, 24, 80]) {
    for (const max of [0, 1, 2, 4, 6]) {
      const lines = taskChecklist(tasks.items, width, max);
      assert.ok(lines.length <= max);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      assert.ok(!lines.join("").includes("\x1b[2J"));
    }
  }
  const short = taskChecklist(tasks.items, 80, 4).map(stripTerminalSequences).join("\n");
  assert.match(short, /Implementing auth/);
  assert.match(short, /\u2026 \+\d+ pending/);
  assert.deepEqual(taskChecklist([], 80), []);
  assert.match(taskDetails([], 80)[0]!, /No checklist/);
});

test("cached task state is backward compatible, validated and preserved without a state version change", () => {
  const f = temporary();
  try {
    const store = new Store(f.root);
    const project = store.addProject(f.root);
    const session = { id: "cache", projectId: project.id, title: "Cache", status: "completed" as const,
      preview: "Done", createdAt: 1, updatedAt: 1, messages: [] };
    store.state.sessions.push(session); store.save();
    assert.equal(new Store(f.root).state.sessions[0]?.tasks, undefined);
    const tasks = state();
    createTask(tasks, { subject: "Pending", activeForm: "Working", description: "Requirements" });
    store.state.sessions[0]!.tasks = tasks.items; store.save();
    assert.deepEqual(new Store(f.root).state.sessions[0]?.tasks, tasks.items);
    assert.equal(new Store(f.root).state.version, 1);
    const valid = readFileSync(store.file, "utf8");
    for (const invalid of [null, {}, [{ id: "0", subject: "Bad", status: "pending", blockedBy: [] }],
      [{ ...tasks.items[0], status: "blocked" }], [{ ...tasks.items[0], description: 42 }],
      [{ ...tasks.items[0], activeForm: 42 }], [{ ...tasks.items[0], blockedBy: [1] }]]) {
      const corrupt = JSON.parse(valid);
      corrupt.sessions[0].tasks = invalid;
      const content = JSON.stringify(corrupt);
      writeFileSync(store.file, content);
      assert.throws(() => new Store(f.root), /Invalid zz state/);
      assert.equal(readFileSync(store.file, "utf8"), content);
    }
  } finally { f.cleanup(); }
});

test("batches resolve forward references and return final tasks in operation order", () => {
  const tasks = state();
  const created = applyTaskBatch(tasks, { operations: [
    { action: "create", subject: "Implement", ref: "implement", blockedBy: [{ ref: "inspect" }] },
    { action: "create", subject: "Inspect", ref: "inspect", status: "in_progress" },
    { action: "create", subject: "Test", blockedBy: [{ ref: "implement" }] },
  ] });
  assert.deepEqual(created.results.map((result) => result.taskId), ["1", "2", "3"]);
  assert.deepEqual(tasks.items.map((task) => task.blockedBy), [["2"], [], ["1"]]);
  assert.deepEqual(created.results[0], { action: "create", ref: "implement", taskId: "1", status: "pending" });
  const changed = applyTaskBatch(tasks, { operations: [
    { action: "update", taskId: "1", status: "in_progress" },
    { action: "update", taskId: "2", status: "completed" },
  ] });
  assert.deepEqual(changed.results.map((result) => result.status), ["in_progress", "completed"]);
  const deleted = applyTaskBatch(tasks, { operations: [
    { action: "delete", taskId: "1" },
    { action: "update", taskId: "3", description: "Still pending" },
    { action: "create", subject: "Document", blockedBy: ["2"] },
  ] });
  assert.deepEqual(deleted.results[0], { action: "delete", taskId: "1", status: "deleted" });
  assert.deepEqual(getTask(tasks, "3").blockedBy, []);
  assert.equal(getTask(tasks, "3").status, "pending");
  assert.equal(tasks.nextId, 5);
});

test("invalid batches roll back every operation, reserved ID and reference", () => {
  const tasks = state();
  createTask(tasks, { subject: "Existing" });
  const invalid: Parameters<typeof applyTaskBatch>[1][] = [
    { operations: [{ action: "create", subject: "New" }, { action: "delete", taskId: "99" }] },
    { operations: [{ action: "update", taskId: "1", subject: "Changed" }, { action: "create", subject: "New", blockedBy: ["99"] }] },
    { operations: [{ action: "create", subject: "New", ref: "same" }, { action: "create", subject: "Again", ref: "same" }] },
    { operations: [{ action: "create", subject: "New", blockedBy: [{ ref: "missing" }] }] },
    { operations: [{ action: "create", subject: "A", ref: "a", blockedBy: [{ ref: "b" }] },
      { action: "create", subject: "B", ref: "b", blockedBy: [{ ref: "a" }] }] },
    { operations: [{ action: "create", subject: "Self", ref: "self", blockedBy: [{ ref: "self" }] }] },
    { operations: [{ action: "delete", taskId: "1" }, { action: "update", taskId: "1", status: "completed" }] },
    { operations: [{ action: "create", subject: "New", blockedBy: ["1"] }, { action: "delete", taskId: "1" }] },
    { operations: [{ action: "update", taskId: "1", addBlockedBy: ["2"], status: "in_progress" }, { action: "create", subject: "Pending" }] },
  ];
  for (const batch of invalid) {
    const before = structuredClone(tasks);
    assert.throws(() => applyTaskBatch(tasks, batch));
    assert.deepEqual(tasks, before);
  }
  assert.equal(createTask(tasks, { subject: "After rollback" }).id, "2");
});

test("dependency edits and session limits are checked against the final graph", () => {
  const tasks = state();
  createTask(tasks, { subject: "Prerequisite" });
  createTask(tasks, { subject: "Dependent", blockedBy: ["1"] });
  applyTaskBatch(tasks, { operations: [
    { action: "update", taskId: "2", status: "completed" },
    { action: "update", taskId: "1", status: "completed" },
  ] });
  applyTaskBatch(tasks, { operations: [
    { action: "update", taskId: "1", status: "pending" },
    { action: "update", taskId: "2", status: "pending", removeBlockedBy: ["1"], addBlockedBy: [{ ref: "new" }] },
    { action: "create", subject: "New prerequisite", ref: "new" },
  ] });
  assert.deepEqual(getTask(tasks, "2").blockedBy, ["3"]);
  assert.throws(() => applyTaskBatch(tasks, { operations: [{ action: "create", subject: "Another", blockedBy: [{ ref: "new" }] }] }), /Unknown/);

  const full = state();
  full.items = Array.from({ length: 1000 }, (_, i) => ({ id: String(i + 1), subject: "Task", status: "pending", blockedBy: [] }));
  full.nextId = 1001;
  assert.throws(() => applyTaskBatch(full, { operations: [{ action: "create", subject: "Too many" }] }), /1000/);
  assert.equal(full.nextId, 1001);
  applyTaskBatch(full, { operations: [{ action: "create", subject: "Replacement" }, { action: "delete", taskId: "1" }] });
  assert.equal(full.items.length, 1000);
  assert.equal(full.items.at(-1)?.id, "1001");
});

test("large batch receipts retain every generated ID without echoing long task descriptions", async () => {
  const tasks = state();
  const update = taskExtension.tools!.find((tool) => tool.name === "task_update")!;
  const api = { conversationId: 1, taskId: 200,
    commit: async (change: (tx: { doc: () => Promise<TaskState> }) => Promise<unknown>) => change({ doc: async () => tasks }),
  } as unknown as ToolExecutionApi;
  const result = await update.execute({ operations: Array.from({ length: 100 }, (_, index) => ({
    action: "create", subject: `Task ${index}`, description: "x".repeat(16000),
  })) }, api, BACKGROUND_CONTEXT);
  const text = result.output?.find((block) => block.type === "text");
  assert.ok(text?.type === "text");
  const results = JSON.parse(text.text).results;
  assert.equal(results.length, 100);
  assert.equal(results[99].taskId, "100");
  assert.ok(text.text.length < 16000);
  assert.equal(tasks.items[99]?.description?.length, 16000);
});

test("completion deadlines start once for a finished checklist and disappear when work reopens or empties", () => {
  const tasks = state();
  applyTaskBatch(tasks, { operations: [{ action: "create", subject: "Work" }] }, 100);
  assert.equal(tasks.completedAt, undefined);
  applyTaskBatch(tasks, { operations: [{ action: "update", taskId: "1", status: "completed" }] }, 200);
  assert.equal(tasks.completedAt, 200);
  applyTaskBatch(tasks, { operations: [{ action: "update", taskId: "1", description: "Verified" }] }, 300);
  assert.equal(tasks.completedAt, 200, "editing finished work does not extend the grace period");
  const before = structuredClone(tasks);
  assert.throws(() => applyTaskBatch(tasks, { operations: [
    { action: "update", taskId: "1", status: "pending" }, { action: "delete", taskId: "99" },
  ] }, 400));
  assert.deepEqual(tasks, before);
  applyTaskBatch(tasks, { operations: [{ action: "create", subject: "Next work" }] }, 500);
  assert.equal(tasks.completedAt, undefined);
  applyTaskBatch(tasks, { operations: [{ action: "update", taskId: "2", status: "completed" }] }, 600);
  assert.equal(tasks.completedAt, 600);
  applyTaskBatch(tasks, { operations: [{ action: "delete", taskId: "1" }, { action: "delete", taskId: "2" }] }, 700);
  assert.equal(tasks.completedAt, undefined);
});

test("task summaries count all statuses even when checklist rows are truncated", () => {
  const tasks = state();
  for (let i = 0; i < 6; i++) createTask(tasks, { subject: `Work ${i + 1}` });
  updateTask(tasks, { taskId: "1", status: "in_progress" });
  const summary = "6 tasks (0 done, 1 in progress, 5 open)";
  assert.equal(taskProgress(tasks.items), summary);
  assert.equal(stripTerminalSequences(taskChecklist(tasks.items, 80, 3)[0]!), `${summary} (/tasks)`);
  assert.match(taskChecklist(tasks.items, 80, 3).map(stripTerminalSequences).join("\n"), /\+5 pending/);
  assert.equal(taskProgress(undefined), undefined);
  for (const [status, counts] of [
    ["pending", "0 done, 0 in progress, 1 open"],
    ["in_progress", "0 done, 1 in progress, 0 open"],
    ["completed", "1 done, 0 in progress, 0 open"],
  ] as const) {
    assert.equal(taskProgress([{ ...tasks.items[0]!, status }]), `1 task (${counts})`);
  }
});
