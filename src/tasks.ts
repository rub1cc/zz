import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTool, section } from "@earendil-works/pi-durable";

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

Creating tasks:
- Create concise, concrete, independently verifiable outcomes. Put scope and completion criteria in the description when useful.
- Use activeForm for ongoing wording, e.g. "Running auth tests".
- Add dependencies only when one outcome requires another. Use returned task IDs; never guess them.

Working:
- Inspect existing tasks when resuming work or when state is unclear. Reuse relevant tasks instead of creating duplicates.
- Mark a task in_progress when beginning its work. Normally keep at most one task in_progress in this session.
- Do not begin tasks with unresolved dependencies.
- Update statuses promptly at meaningful work boundaries, not after every tool call.
- Revise tasks and dependencies when new evidence changes the plan.

Completion and blockers:
- Mark completed only when the stated outcome is achieved and required verification succeeds.
- Failed checks or unavailable required verification do not count as success. Keep the task unfinished and explain the limitation.
- Record external blockers in the description and tell the user. Do not invent dependency tasks or mark blocked work completed.
- Delete tasks only when obsolete or explicitly removed from scope, never to hide unfinished work.

Communication:
- Use task tools for state changes; prose alone changes nothing.
- Do not repeat the full checklist: zz already renders it. Dependency IDs need not be narrated unless relevant to explaining a problem.
- Before your final response, reconcile task state and report remaining work or blockers.
- Ending a response does not automatically complete its tasks.`;

const subject = Type.String({ minLength: 1, maxLength: 200, pattern: "\\S", description: "Concise, verifiable outcome, e.g. Add reset-token validation." });
const description = Type.String({ maxLength: 16000, description: "Scope, completion criteria, or external blockers." });
const activeForm = Type.String({ minLength: 1, maxLength: 200, pattern: "\\S", description: "Ongoing wording shown while active, e.g. Running auth tests." });
const taskId = Type.String({ pattern: "^[1-9][0-9]*$", description: "Generated task ID in this session." });
const dependencies = Type.Array(taskId, { maxItems: 1000, uniqueItems: true, description: "Prerequisite task IDs in this session." });
export const createTaskParameters = Type.Object({
  subject, description: Type.Optional(description), activeForm: Type.Optional(activeForm),
  blockedBy: Type.Optional(dependencies),
}, { additionalProperties: false });
export const updateTaskParameters = Type.Object({
  taskId, subject: Type.Optional(subject), description: Type.Optional(description), activeForm: Type.Optional(activeForm),
  status: Type.Optional(Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed"), Type.Literal("deleted")])),
  addBlockedBy: Type.Optional(dependencies), removeBlockedBy: Type.Optional(dependencies),
}, { additionalProperties: false });

type CreateTask = { subject: string; description?: string; activeForm?: string; blockedBy?: string[] };
type UpdateTask = Partial<Omit<CreateTask, "blockedBy">> & {
  taskId: string; status?: TaskStatus | "deleted"; addBlockedBy?: string[]; removeBlockedBy?: string[];
};

export function getTask(state: Pick<TaskState, "items">, id: string): ChecklistTask {
  const task = state.items.find((item) => item.id === id);
  if (!task) throw new Error(`No task with ID ${id} in this session. Use task_list to inspect existing tasks.`);
  return task;
}

export function unresolvedDependencies(state: Pick<TaskState, "items">, task: ChecklistTask): string[] {
  return task.blockedBy.filter((id) => getTask(state, id).status !== "completed");
}

function validate(state: Pick<TaskState, "items">): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (task: ChecklistTask): void => {
    if (visiting.has(task.id)) throw new Error("Task dependencies must not contain a cycle or self-dependency.");
    if (visited.has(task.id)) return;
    visiting.add(task.id);
    for (const id of task.blockedBy) visit(getTask(state, id));
    visiting.delete(task.id);
    visited.add(task.id);
  };
  for (const task of state.items) {
    visit(task);
    if (task.status !== "pending" && unresolvedDependencies(state, task).length) {
      throw new Error(`Task #${task.id} has unfinished prerequisites. Set dependent tasks to pending before reopening prerequisites, or finish prerequisites first.`);
    }
  }
}

export function createTask(state: TaskState, args: CreateTask): ChecklistTask {
  if (state.items.length >= 1000) throw new Error("A session supports up to 1000 tasks. Delete obsolete tasks first.");
  const task: ChecklistTask = { id: String(state.nextId), subject: args.subject.trim(), status: "pending",
    blockedBy: [...new Set(args.blockedBy ?? [])],
    ...(args.description !== undefined ? { description: args.description } : {}),
    ...(args.activeForm !== undefined ? { activeForm: args.activeForm.trim() } : {}),
  };
  validate({ items: [...state.items, task] });
  state.items.push(task);
  state.nextId++;
  return task;
}

export function updateTask(state: TaskState, args: UpdateTask): ChecklistTask | { id: string; status: "deleted" } {
  const task = getTask(state, args.taskId);
  if (args.status === "deleted") {
    state.items = state.items.filter((item) => item.id !== task.id)
      .map((item) => ({ ...item, blockedBy: item.blockedBy.filter((id) => id !== task.id) }));
    return { id: task.id, status: "deleted" };
  }
  const overlap = args.addBlockedBy?.find((id) => args.removeBlockedBy?.includes(id));
  if (overlap) throw new Error(`Cannot add and remove dependency ${overlap} in the same update.`);
  for (const id of [...args.addBlockedBy ?? [], ...args.removeBlockedBy ?? []]) getTask(state, id);
  const next: ChecklistTask = { ...task,
    ...(args.subject !== undefined ? { subject: args.subject.trim() } : {}),
    ...(args.description !== undefined ? { description: args.description } : {}),
    ...(args.activeForm !== undefined ? { activeForm: args.activeForm.trim() } : {}),
    ...(args.status !== undefined ? { status: args.status } : {}),
    blockedBy: [...new Set([...task.blockedBy.filter((id) => !args.removeBlockedBy?.includes(id)), ...args.addBlockedBy ?? []])],
  };
  const items = state.items.map((item) => item.id === task.id ? next : item);
  validate({ items });
  state.items = items;
  return next;
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
      name: "task_create", description: "Create a pending checklist task for substantial multi-step work. Returns its generated ID. Optional blockedBy lists prerequisite task IDs in this session; it does not start work.",
      parameters: createTaskParameters, replay: "safe",
      execute: async (args, api, ctx) => output(await api.commit(async (tx) => {
        const state = await tx.doc(TasksDoc, api.conversationId);
        const key = String(api.taskId);
        if (state.receipts[key]) return state.receipts[key];
        // Record the result with the mutation so recovery cannot create a duplicate task.
        return state.receipts[key] = JSON.stringify(createTask(state, args));
      }, ctx)),
    }),
    defineTool({
      name: "task_update", description: "Update task details, status, or prerequisite IDs. Start only unblocked tasks; complete only verified work. Use status deleted only for obsolete tasks; deletion removes references to that task. Returns the committed task or deletion confirmation.",
      parameters: updateTaskParameters, replay: "safe",
      execute: async (args, api, ctx) => output(await api.commit(async (tx) => {
        const state = await tx.doc(TasksDoc, api.conversationId);
        const key = String(api.taskId);
        if (state.receipts[key]) return state.receipts[key];
        return state.receipts[key] = JSON.stringify(updateTask(state, args));
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
