import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { accent, bold, dim, fit, green, oneLine, plain } from "./format.js";
import type { ChecklistTask } from "./tasks.js";

export function taskProgress(tasks: readonly ChecklistTask[] | undefined): string | undefined {
  if (!tasks?.length) return;
  return `${tasks.filter((task) => task.status === "completed").length}/${tasks.length}`;
}

/** Dependencies remain model-visible but are deliberately absent from the checklist UI. */
export function taskChecklist(tasks: readonly ChecklistTask[] | undefined, width: number, maxLines = 6): string[] {
  const progress = taskProgress(tasks);
  if (!progress || !tasks || maxLines < 1) return [];
  const lines = [fit(bold(`Tasks - ${progress} complete`) + dim(" (/tasks)"), width)];
  if (maxLines === 1) return lines;
  const count = tasks.length <= maxLines - 1 ? tasks.length : Math.max(0, maxLines - 2);
  const visible = tasks.length <= count ? tasks : [...tasks].sort((a, b) => {
    const priority = { in_progress: 0, pending: 1, completed: 2 };
    return priority[a.status] - priority[b.status];
  });
  for (const task of visible.slice(0, count)) {
    const color = task.status === "completed" ? green : task.status === "in_progress" ? accent : dim;
    const mark = task.status === "completed" ? "\u2612" : "\u2610";
    const label = task.status === "in_progress" ? task.activeForm ?? task.subject : task.subject;
    lines.push(fit(color(`  ${mark} #${task.id} ${oneLine(label)}`), width));
  }
  if (tasks.length > count) lines.push(fit(dim(`  +${tasks.length - count} more (/tasks)`), width));
  return lines;
}

export function taskDetails(tasks: readonly ChecklistTask[] | undefined, width: number): string[] {
  if (!tasks?.length) return ["No checklist tasks in this session."];
  return tasks.flatMap((task) => [
    ...wrapTextWithAnsi(bold(`#${task.id} ${oneLine(task.subject)}`), Math.max(1, width)),
    ...wrapTextWithAnsi(dim(task.status === "in_progress" ? "In progress" : task.status === "completed" ? "Completed" : "Pending"), Math.max(1, width)),
    ...(task.description ? wrapTextWithAnsi(plain(task.description), Math.max(1, width)) : []),
    "",
  ]);
}
