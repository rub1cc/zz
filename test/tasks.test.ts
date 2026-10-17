import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonObject } from "@earendil-works/pi-durable";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { createTask, getTask, taskExtension, unresolvedDependencies, updateTask, type TaskState } from "../src/tasks.js";
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

test("tool schemas reject malformed tasks and dependency lists", () => {
  const create = taskExtension.tools!.find((tool) => tool.name === "task_create")!;
  const update = taskExtension.tools!.find((tool) => tool.name === "task_update")!;
  const check = (tool: typeof create, args: JsonObject) => validateToolArguments(tool, { type: "toolCall", id: "test", name: tool.name, arguments: args });
  for (const args of [{}, { subject: " " }, { subject: "a".repeat(201) }, { subject: "Valid", activeForm: " " },
    { subject: "Valid", blockedBy: ["1", "1"] }, { subject: "Valid", blockedBy: ["0"] }] as JsonObject[]) {
    assert.throws(() => check(create, args));
  }
  for (const args of [{ taskId: "0" }, { taskId: "1", status: "blocked" }, { taskId: "1", addBlockedBy: ["bad"] }] as JsonObject[]) {
    assert.throws(() => check(update, args));
  }
  assert.ok(check(create, { subject: "Valid", blockedBy: ["1"] }));
});

test("safe task tools return saved receipts on replay instead of reapplying mutations", async () => {
  let tasks = state();
  const api = { conversationId: 1, taskId: 100,
    commit: async (change: (tx: { doc: () => Promise<TaskState> }) => Promise<unknown>) => {
      const draft = structuredClone(tasks);
      const result = await change({ doc: async () => draft });
      tasks = draft;
      return result;
    },
  } as unknown as ToolExecutionApi;
  const create = taskExtension.tools!.find((tool) => tool.name === "task_create")!;
  const update = taskExtension.tools!.find((tool) => tool.name === "task_update")!;
  assert.equal(create.replay, "safe");
  assert.equal(update.replay, "safe");
  const first = await create.execute({ subject: "Once" }, api, BACKGROUND_CONTEXT);
  const replayed = await create.execute({ subject: "Once" }, api, BACKGROUND_CONTEXT);
  assert.deepEqual(first, replayed);
  assert.equal(tasks.items.length, 1);
  const deleteApi = { ...api, taskId: 101 } as unknown as ToolExecutionApi;
  const deleted = await update.execute({ taskId: "1", status: "deleted" }, deleteApi, BACKGROUND_CONTEXT);
  assert.deepEqual(await update.execute({ taskId: "1", status: "deleted" }, deleteApi, BACKGROUND_CONTEXT), deleted);
  assert.equal(tasks.items.length, 0);
  assert.equal(tasks.nextId, 2);
});

test("checklist rendering is bounded, safe and never displays dependency annotations", () => {
  const tasks = state();
  createTask(tasks, { subject: "Inspect auth" });
  createTask(tasks, { subject: "Implement auth", activeForm: "Implementing auth", blockedBy: ["1"] });
  createTask(tasks, { subject: "Run tests", description: "Verify tokens\nincluding expiry", blockedBy: ["2"] });
  updateTask(tasks, { taskId: "1", status: "completed" });
  updateTask(tasks, { taskId: "2", status: "in_progress" });
  assert.equal(taskProgress(tasks.items), "1/3");
  assert.equal(taskProgress([]), undefined);
  const colored = taskChecklist(tasks.items, 100).join("\n");
  const rendered = stripTerminalSequences(colored);
  assert.match(rendered, /\u2612 #1 Inspect auth/);
  assert.match(rendered, /\u2610 #2 Implementing auth/);
  assert.match(rendered, /\u2610 #3 Run tests/);
  assert.doesNotMatch(rendered, /\[>\]|\[x\]|\[ \]/);
  assert.match(colored, /\x1b\[32m  \u2612 #1 Inspect auth/);
  assert.match(colored, /\x1b\[36m  \u2610 #2 Implementing auth/);
  assert.match(colored, /\x1b\[2m  \u2610 #3 Run tests/);
  assert.doesNotMatch(rendered, /blocked|blockedBy|depends/);
  const details = taskDetails(tasks.items, 100).map(stripTerminalSequences).join("\n");
  assert.match(details, /including expiry/);
  assert.doesNotMatch(details, /blocked|blockedBy|depends/);
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
  assert.match(short, /more/);
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
