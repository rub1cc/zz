import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ProgramStatus, Terminal } from "@earendil-works/pi-tui";
import type { Engine } from "../src/controller.js";
import { sessionStats } from "../src/usage.js";
import type { ImageAttachment, AgentSettings, CompactResult, ModelOption, Project, Session, SkillOption } from "../src/model.js";

export function temporary(): { root: string; cleanup(): void } {
  const root = mkdtempSync(join(process.cwd(), ".zz-test-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export class FakeEngine implements Engine {
  defaults: AgentSettings = { model: { provider: "test", modelId: "mock" }, thinkingLevel: "off" };
  configuration(session?: Session): AgentSettings { return { ...(session?.agent ?? this.defaults) }; }
  stats(session?: Session) { return session ? sessionStats(session, 100_000) : { contextWindow: 100_000 }; }
  async listModels(): Promise<ModelOption[]> {
    return [{ provider: "test", modelId: "mock", name: "Mock", thinkingLevels: ["off"] },
      { provider: "test", modelId: "reasoner", name: "Reasoner", thinkingLevels: ["off", "low", "high"] }];
  }
  async listSkills(_project: Project): Promise<SkillOption[]> { return [{ name: "testing", description: "Test your code", filePath: "/skills/testing/SKILL.md" }]; }
  async configure(change: Partial<AgentSettings>, session?: Session): Promise<void> {
    const next = { ...this.configuration(session), ...change };
    if (session) session.agent = next; else this.defaults = next;
  }
  calls: { session: Session; project: Project; prompt: string; images?: ImageAttachment[] }[] = [];
  compactions: { session: Session; instructions?: string }[] = [];
  async compact(session: Session, instructions?: string): Promise<CompactResult> {
    this.compactions.push({ session, instructions });
    return "compacted" as const;
  }
  undos: Session[] = [];
  undoIds: string[] = [];
  async undoCheckpoints(_session: Session) {
    return [{ id: "latest", turn: 2, prompt: "Latest prompt", turns: 1, files: 1, shell: false },
      { id: "older", turn: 1, prompt: "Older prompt", turns: 2, files: 2, shell: true }];
  }
  async undo(session: Session, checkpointId: string) {
    this.undos.push(session); this.undoIds.push(checkpointId);
    return { prompt: "Restored prompt", files: 1, shell: false };
  }
  stopped: string[] = [];
  cancelled: string[] = [];
  async run(session: Session, project: Project, prompt: string, _changed?: () => void, images: ImageAttachment[] = []): Promise<void> {
    this.calls.push({ session, project, prompt, ...(images.length ? { images } : {}) });
    session.status = "completed";
    session.preview = "Done";
    session.messages.push({ role: "assistant", text: `Reply to ${prompt}`, timestamp: Date.now() });
  }
  async stop(id: string): Promise<void> { this.stopped.push(id); }
  async cancel(id: string): Promise<void> { this.cancelled.push(id); }
  async close(): Promise<void> {}
}

export class FakeTerminal implements Terminal {
  columns = 120;
  rows = 32;
  kittyProtocolActive = false;
  onInput: (data: string) => void = () => {};
  onResize: () => void = () => {};
  start(input: (data: string) => void, resize: () => void): void { this.onInput = input; this.onResize = resize; }
  stop(): void {}
  write(_data: string): void {}
  moveBy(_lines: number): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearFromCursorToEnd(): void {}
  clearScreen(): void {}
  async drainInput(): Promise<void> {}
  setTitle(_title: string): void {}
  setProgress(_active: boolean): void {}
  setProgramStatus(_status: ProgramStatus): void {}
}

export const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
