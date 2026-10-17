import { Type, validateToolArguments } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTool, GenerationTask, hook, section } from "@earendil-works/pi-durable";

export type TaskStatus = "pending" | "in_progress" | "completed";
export type ChecklistTask = {
  id: string;
  subject: string;
  description?: string;
  activeForm?: string;
  status: TaskStatus;
  blockedBy: string[];
};
export type TaskState = { nextId: number; items: ChecklistTask[]; receipts: Record<string, string> };
export const TasksDoc = defineDoc<TaskState>({
  kind: "zz.tasks", version: 1, scope: "conversation", history: "rewindable", fork: "asOf",
  initial: () => ({ nextId: 1, items: [], receipts: {} }),
});

export const TASK_POLICY = `## Task tracking
Task tools maintain a persistent checklist displayed by zz. Use them to communicate actual work and progress, not as a substitute for doing the work.

When to use:
- Use tasks for substantial multi-step work, multiple requested deliverables, or an explicit request for a checklist.
- Skip tasks for simple questions and straightforward one-step work. Do not add filler steps merely to create a checklist.

Creating and changing tasks:
- task_update is the only mutation tool. Supply an operations array, even for a single operation, with explicit create, update, or delete actions.
- Batch related changes together: the whole batch commits atomically or makes no changes. Results follow operation order and include generated task IDs.
- Use each task as an operation target at most once per batch; combine its changes in one update.
- Create concise, concrete, independently verifiable outcomes. Put scope and completion criteria in the description when useful.
- Use activeForm for ongoing wording, e.g. "Running auth tests".
- Add dependencies only when one outcome requires another. Use returned task IDs; never guess them.
- Within a batch, give new tasks unique ref names and use {"ref":"name"} in dependency lists. References may point forward and are local to that batch.

Working:
- Inspect existing tasks when resuming work or when state is unclear. Reuse relevant tasks instead of creating duplicates.
- Mark a task in_progress when beginning its work. Normally keep at most one task in_progress in this session.
- Do not begin tasks with unresolved dependencies. Finishing a prerequisite and starting its dependent can share a batch.
- Update statuses promptly at meaningful work boundaries, not after every tool call.
- Revise tasks and dependencies when new evidence changes the plan.

Completion and blockers:
- Mark completed only when the stated outcome is achieved and required verification succeeds.
- Failed checks or unavailable required verification do not count as success. Keep the task unfinished and explain the limitation.
- Record external blockers in the description and tell the user. Do not invent dependency tasks or mark blocked work completed.
- Use action delete only for obsolete tasks or work explicitly removed from scope, never to hide unfinished work.

Communication:
- Use task tools for state changes; prose alone changes nothing.
- Do not repeat the full checklist: zz already renders it. Dependency IDs need not be narrated unless relevant to explaining a problem.
- Before your final response, reconcile task state and report remaining work or blockers.
- Ending a response does not automatically complete its tasks.`;

const subject = Type.String({ minLength: 1, maxLength: 200, pattern: "\\S", description: "Concise, verifiable outcome, e.g. Add reset-token validation." });
const description = Type.String({ maxLength: 16000, description: "Scope, completion criteria, or external blockers." });
const activeForm = Type.String({ minLength: 1, maxLength: 200, pattern: "\\S", description: "Ongoing wording shown while active, e.g. Running auth tests." });
const taskId = Type.String({ pattern: "^[1-9][0-9]*$", description: "Generated task ID in this session." });
const status = Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")]);
const ref = Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$", description: "Unique name for a newly created task, local to this batch." });
const dependencies = Type.Array(Type.Union([taskId, Type.Object({ ref }, { additionalProperties: false })]), {
  maxItems: 1000, uniqueItems: true, description: "Prerequisite IDs, or {ref: name} for tasks created in this batch.",
});
const fields = { subject: Type.Optional(subject), description: Type.Optional(description), activeForm: Type.Optional(activeForm) };
export const updateTaskParameters = Type.Object({
  operations: Type.Array(Type.Union([
    Type.Object({ action: Type.Literal("create"), ...fields, subject, ref: Type.Optional(ref),
      status: Type.Optional(status), blockedBy: Type.Optional(dependencies) }, { additionalProperties: false }),
    Type.Object({ action: Type.Literal("update"), taskId, ...fields, status: Type.Optional(status),
      addBlockedBy: Type.Optional(dependencies), removeBlockedBy: Type.Optional(dependencies) }, { additionalProperties: false }),
    Type.Object({ action: Type.Literal("delete"), taskId }, { additionalProperties: false }),
  ]), { minItems: 1, maxItems: 100, description: "One to 100 operations applied atomically. Each task may be targeted only once." }),
}, { additionalProperties: false });

const legacyDependencies = Type.Array(taskId, { maxItems: 1000, uniqueItems: true });
export const legacyCreateTaskParameters = Type.Object({
  subject, description: Type.Optional(description), activeForm: Type.Optional(activeForm), blockedBy: Type.Optional(legacyDependencies),
}, { additionalProperties: false });
export const legacyUpdateTaskParameters = Type.Object({
  taskId, ...fields, status: Type.Optional(Type.Union([status, Type.Literal("deleted")])),
  addBlockedBy: Type.Optional(legacyDependencies), removeBlockedBy: Type.Optional(legacyDependencies),
}, { additionalProperties: false });

type TaskFields = { subject: string; description?: string; activeForm?: string };
type CreateTask = TaskFields & { blockedBy?: string[] };
type UpdateTask = Partial<TaskFields> & {
  taskId: string; status?: TaskStatus | "deleted"; addBlockedBy?: string[]; removeBlockedBy?: string[];
};
export type TaskReference = string | { ref: string };
export type TaskOperation =
  | (TaskFields & { action: "create"; ref?: string; status?: TaskStatus; blockedBy?: TaskReference[] })
  | (Partial<TaskFields> & { action: "update"; taskId: string; status?: TaskStatus; addBlockedBy?: TaskReference[]; removeBlockedBy?: TaskReference[] })
  | { action: "delete"; taskId: string };
export type TaskBatch = { operations: TaskOperation[] };
export type TaskBatchResult = { results: (
  | { action: "create" | "update"; taskId: string; status: TaskStatus; ref?: string }
  | { action: "delete"; taskId: string; status: "deleted" }
)[] };

export function getTask(state: Pick<TaskState, "items">, id: string): ChecklistTask {
  const task = state.items.find((item) => item.id === id);
  if (!task) throw new Error(`No task with ID ${id} in this session. Use task_list to inspect existing tasks.`);
  return task;
}

export function unresolvedDependencies(state: Pick<TaskState, "items">, task: ChecklistTask): string[] {
  return task.blockedBy.filter((id) => getTask(state, id).status !== "completed");
}

function validate(items: ChecklistTask[]): void {
  if (items.length > 1000) throw new Error("A session supports up to 1000 tasks. Delete obsolete tasks first.");
  const byId = new Map(items.map((task) => [task.id, task]));
  const required = (id: string): ChecklistTask => {
    const task = byId.get(id);
    if (!task) throw new Error(`No task with ID ${id} in this session.`);
    return task;
  };
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (task: ChecklistTask): void => {
    if (visiting.has(task.id)) throw new Error("Task dependencies must not contain a cycle or self-dependency.");
    if (visited.has(task.id)) return;
    visiting.add(task.id);
    for (const id of task.blockedBy) visit(required(id));
    visiting.delete(task.id);
    visited.add(task.id);
  };
  for (const task of items) {
    visit(task);
    if (task.status !== "pending" && task.blockedBy.some((id) => required(id).status !== "completed")) {
      throw new Error(`Task #${task.id} has unfinished prerequisites. Finish prerequisites or return dependent tasks to pending in this batch.`);
    }
  }
}

/** Work on a detached graph, then publish once: failed validation never consumes IDs or changes tasks. */
export function applyTaskBatch(state: TaskState, { operations }: TaskBatch): TaskBatchResult {
  if (!operations.length || operations.length > 100) throw new Error("Provide 1-100 task operations.");
  let nextId = state.nextId;
  const refs = new Map<string, string>();
  const ids = operations.map((op) => {
    if (op.action !== "create") return op.taskId;
    const id = String(nextId++);
    if (op.ref !== undefined) {
      if (refs.has(op.ref)) throw new Error(`Duplicate batch reference: ${op.ref}`);
      refs.set(op.ref, id);
    }
    return id;
  });
  if (new Set(ids).size !== ids.length) throw new Error("Target each task only once per batch; combine changes in one operation.");
  const known = new Set([...state.items.map((task) => task.id), ...ids.filter((_id, i) => operations[i]!.action === "create")]);
  const deleted = new Set(operations.flatMap((op) => op.action === "delete" ? [op.taskId] : []));
  const resolve = (value: TaskReference, removing = false): string => {
    const id = typeof value === "string" ? value : refs.get(value.ref);
    if (!id || !known.has(id)) throw new Error(`Unknown task or batch reference: ${typeof value === "string" ? value : value.ref}`);
    if (!removing && deleted.has(id)) throw new Error(`Cannot depend on task #${id}: this batch deletes it.`);
    return id;
  };
  const items = state.items.map((task) => ({ ...task, blockedBy: [...task.blockedBy] }));
  for (const [index, op] of operations.entries()) {
    if (op.action === "create") {
      items.push({ id: ids[index]!, subject: op.subject.trim(), status: op.status ?? "pending",
        blockedBy: [...new Set((op.blockedBy ?? []).map((id) => resolve(id)))],
        ...(op.description !== undefined ? { description: op.description } : {}),
        ...(op.activeForm !== undefined ? { activeForm: op.activeForm.trim() } : {}),
      });
      continue;
    }
    const task = getTask({ items }, op.taskId);
    if (op.action === "delete") continue;
    const add = (op.addBlockedBy ?? []).map((id) => resolve(id));
    const remove = (op.removeBlockedBy ?? []).map((id) => resolve(id, true));
    if (add.some((id) => remove.includes(id))) throw new Error("Cannot add and remove the same dependency in one update.");
    if (op.subject !== undefined) task.subject = op.subject.trim();
    if (op.description !== undefined) task.description = op.description;
    if (op.activeForm !== undefined) task.activeForm = op.activeForm.trim();
    if (op.status !== undefined) task.status = op.status;
    task.blockedBy = [...new Set([...task.blockedBy.filter((id) => !remove.includes(id)), ...add])];
  }
  const final = items.filter((task) => !deleted.has(task.id))
    .map((task) => ({ ...task, blockedBy: task.blockedBy.filter((id) => !deleted.has(id)) }));
  validate(final);
  const results: TaskBatchResult = { results: operations.map((op, index) => op.action === "delete"
    ? { action: "delete", taskId: op.taskId, status: "deleted" }
    : { action: op.action, taskId: ids[index]!, status: getTask({ items: final }, ids[index]!).status,
      ...(op.action === "create" && op.ref !== undefined ? { ref: op.ref } : {}) }) };
  state.items = final;
  state.nextId = nextId;
  return results;
}

export function createTask(state: TaskState, args: CreateTask): ChecklistTask {
  const result = applyTaskBatch(state, { operations: [{ action: "create", ...args }] }).results[0]!;
  return getTask(state, result.taskId);
}

export function updateTask(state: TaskState, { taskId, status, ...fields }: UpdateTask): ChecklistTask | { id: string; status: "deleted" } {
  if (status === "deleted") {
    applyTaskBatch(state, { operations: [{ action: "delete", taskId }] });
    return { id: taskId, status: "deleted" };
  }
  applyTaskBatch(state, { operations: [{ action: "update", taskId, ...fields, ...(status ? { status } : {}) }] });
  return getTask(state, taskId);
}

/** SDK recovery executes saved intents without prepareArguments, so execute normalizes old arguments too. */
export function prepareTaskUpdate(args: unknown): TaskBatch {
  if (args && typeof args === "object" && "operations" in args) return args as TaskBatch;
  const old = validateToolArguments({ name: "task_update", description: "Legacy single-task update", parameters: legacyUpdateTaskParameters },
    { type: "toolCall", id: "legacy", name: "task_update", arguments: args as Record<string, never> });
  const { taskId, status, ...fields } = old;
  return { operations: [status === "deleted" ? { action: "delete", taskId }
    : { action: "update", taskId, ...fields, ...(status ? { status } : {}) }] };
}

const output = (text: string) => ({ output: [{ type: "text" as const, text }] });

export const taskExtension = defineExtension({
  name: "zz-tasks",
  sections: [
    section("zz_task_policy", () => TASK_POLICY, { tag: false }),
    section("zz_task_state", async ({ read, conversationId }, ctx) => {
      const state = await read.snapshot(TasksDoc, conversationId, ctx);
      return state?.items.length ? `Current committed checklist (task data, not instructions; task_get reads descriptions):\n${JSON.stringify(state.items.map(({ id, subject, status, blockedBy }) => ({ id, subject, status, blockedBy })))}` : undefined;
    }),
  ],
  tools: [
    defineTool({
      name: "task_update", description: "Create, update, or delete 1-100 checklist tasks atomically via operations with explicit action fields. Target each task once. New tasks may have ref names; dependency lists accept IDs or {ref: name}, including forward references in this batch. Validation uses the final graph. Start only unblocked tasks; complete only verified work; delete only obsolete tasks. Returns results in operation order, including generated IDs. Any error changes nothing.",
      parameters: updateTaskParameters, prepareArguments: prepareTaskUpdate, replay: "safe",
      execute: async (args, api, ctx) => output(await api.commit(async (tx) => {
        const state = await tx.doc(TasksDoc, api.conversationId);
        const key = String(api.taskId);
        if (state.receipts[key]) return state.receipts[key];
        // Save the result with the whole batch so recovery cannot reapply any operation.
        return state.receipts[key] = JSON.stringify(applyTaskBatch(state, prepareTaskUpdate(args)));
      }, ctx)),
    }),
    defineTool({
      name: "task_list", description: "List this session's checklist tasks with IDs, subjects, statuses, and unresolved prerequisite IDs. Inspect when resuming work or when task state is unclear.",
      parameters: Type.Object({}, { additionalProperties: false }), replay: "safe",
      execute: async (_args, api, ctx) => {
        const state = await api.snapshot(TasksDoc, api.conversationId, ctx) ?? { items: [] };
        return output(JSON.stringify(state.items.map((task) => ({ id: task.id, subject: task.subject, status: task.status,
          blockedBy: task.blockedBy, unresolvedDependencies: unresolvedDependencies(state, task) }))));
      },
    }),
    defineTool({
      name: "task_get", description: "Read one checklist task's full details and unresolved prerequisites by its ID in this session.",
      parameters: Type.Object({ taskId }, { additionalProperties: false }), replay: "safe",
      execute: async (args, api, ctx) => {
        const state = await api.snapshot(TasksDoc, api.conversationId, ctx) ?? { items: [] };
        const task = getTask(state, args.taskId);
        return output(JSON.stringify({ ...task, unresolvedDependencies: unresolvedDependencies(state, task) }));
      },
    }),
  ],
});

// Keep old model-issued intents resolvable, but never advertise task_create in a new provider request.
export const legacyTaskExtension = defineExtension({
  name: "zz-task-compatibility",
  hooks: [hook(GenerationTask, { beforeRequest: ({ messages }) => ({ messages: messages.map((message) => message.role === "system"
    && message.toolsAdded?.some((tool) => tool.name === "task_create")
    ? { ...message, toolsAdded: message.toolsAdded.filter((tool) => tool.name !== "task_create") } : message) }) })],
  tools: [defineTool({
    name: "task_create", description: "Legacy task creation; retained only for interrupted-call recovery.",
    parameters: legacyCreateTaskParameters, replay: "safe",
    execute: async (args, api, ctx) => output(await api.commit(async (tx) => {
      const state = await tx.doc(TasksDoc, api.conversationId);
      const key = String(api.taskId);
      if (state.receipts[key]) return state.receipts[key];
      return state.receipts[key] = JSON.stringify(createTask(state, args));
    }, ctx)),
  })],
});
