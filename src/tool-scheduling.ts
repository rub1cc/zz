import type { Context } from "@earendil-works/chord/context";
import {
  defineExtension, hook, LiveDoc, ToolTask, wrapTool,
  type ConversationId, type Harness, type Registry, type TaskId, type ToolSlot,
} from "@earendil-works/pi-durable";

export const TOOL_CONCURRENCY = 4;

/** A closed allowlist: replay safety alone says nothing about concurrency safety. */
export function isParallelTool(name: string): boolean {
  return name === "read" || name === "task_list" || name === "task_get";
}

/** Fixed windows keep admission deterministic even when callbacks arrive out of order or after a restart. */
export function toolDependencies(slots: readonly ToolSlot[], index: number, limit: number): readonly ToolSlot[] {
  if (!isParallelTool(slots[index]!.name)) return slots.slice(0, index);
  let start = index;
  while (start > 0 && isParallelTool(slots[start - 1]!.name)) start--;
  const window = start + Math.floor((index - start) / limit) * limit;
  return slots.slice(0, window);
}

export function createToolSchedulingExtension(registry: Registry, harness: () => Harness, limit = TOOL_CONCURRENCY) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Tool concurrency must be a positive integer.");

  const admit = async (taskId: TaskId, conversationId: ConversationId, context: Context) => {
    const host = harness();
    const live = await host.snapshot(LiveDoc, conversationId, context);
    const slots = live?.tools ?? [];
    const index = slots.findIndex((slot) => slot.taskId === taskId);
    // Nested calls run inside their parent's reservation; waiting on that parent would deadlock.
    if (index < 0 && live?.nestedTools?.some((slot) => slot.taskId === taskId)) return;
    if (index < 0) throw new Error("Tool call has no durable scheduling slot.");
    const dependencies = toolDependencies(slots, index, limit);
    await Promise.all(dependencies.map(async (slot) => {
      if (slot.taskId !== undefined) await host.waitForTask(slot.taskId, context);
      else if (slot.status !== "done") throw new Error("Preceding tool has not been admitted.");
    }));
    context.abortSignal?.throwIfAborted();
  };

  return defineExtension({
    name: "zz-tool-scheduling",
    hooks: [hook(ToolTask, { beforeTool: async (call, api, context) => {
      if (!call.parent) await admit(api.taskId, api.conversationId, context);
      return undefined;
    } })],
    // Recovery of replay-safe intents skips beforeTool, so gate execution as well.
    wraps: [...new Map(registry.snapshot().tools().map(({ tool }) => [tool.name, tool])).values()]
      .map((tool) => wrapTool(tool, (original) => ({
        ...original,
        execute: async (args, api, context) => {
          await admit(api.taskId, api.conversationId, context);
          return original.execute(args, api, context);
        },
      }))),
  });
}
