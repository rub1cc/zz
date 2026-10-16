import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, defineExtension, GenerationTask, hook, LiveDoc, ToolTask, wrapTool,
  type ConversationId, type Harness, type ToolRegistration } from "@earendil-works/pi-durable";
import { createEditTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import type { UndoCheckpoint } from "./model.js";

const ctx = BACKGROUND_CONTEXT;
export type UndoPoint = { id: string; run: number; at?: number; prompt: string; timestamp?: number };
export const UndoDoc = defineDoc<{ points: UndoPoint[]; restoring?: boolean; restoreTo?: string }>({
  kind: "zz.undo", version: 1, scope: "conversation", history: "latest", fork: "current",
  initial: () => ({ points: [] }),
});

type FileVersion = { content: string; mode: number };
type Parent = { path: string; dev: number; ino: number };
type FileChange = { path: string; before: FileVersion | null; after: string; afterMode: number; parents: Parent[] };
type Journal = { files: FileChange[]; shell: boolean };
const hash = (content: Uint8Array): string => createHash("sha256").update(content).digest("hex");

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }

/** Refuse links at every existing component, including a parent replaced since the edit. */
function safePath(path: string): void {
  let current = path;
  while (true) {
    try {
      const info = lstatSync(current);
      if (info.isSymbolicLink() || current === path && (!info.isFile() || info.nlink !== 1)) {
        throw new Error(`Undo cannot safely track a linked or non-regular file: ${path}`);
      }
    } catch (error) { if (!missing(error)) throw error; }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function parents(path: string): Parent[] {
  const result: Parent[] = [];
  let current = dirname(path);
  while (true) {
    try {
      const info = lstatSync(current);
      result.push({ path: current, dev: info.dev, ino: info.ino });
    } catch (error) { if (!missing(error)) throw error; }
    const parent = dirname(current);
    if (parent === current) return result;
    current = parent;
  }
}

function version(path: string): FileVersion | null {
  safePath(path);
  try { return { content: readFileSync(path).toString("base64"), mode: lstatSync(path).mode & 0o777 }; }
  catch (error) { if (missing(error)) return null; throw error; }
}

function same(a: FileVersion | null, b: FileVersion | null): boolean {
  return a === null || b === null ? a === b : a.content === b.content && a.mode === b.mode;
}

/** Persistent per-turn backups. Shell effects are deliberately not claimed as reversible. */
export class UndoHistory {
  harness!: Harness;
  readonly root: string;
  constructor(root: string) {
    this.root = join(realpathSync(root), "undo");
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  readonly extension = defineExtension({
    name: "zz-undo",
    hooks: [hook(GenerationTask, { beforeRequest: async (_request, api) => {
      await this.checkpoint(api.conversationId);
      return undefined;
    } }), hook(ToolTask, { beforeTool: async (call, api) => {
      if (call.name !== "bash") return;
      const point = await this.checkpoint(api.conversationId);
      if (point) this.markShell(point);
      return undefined;
    } })],
    wraps: ([createWriteTool(), createEditTool()] as ToolRegistration[]).map((tool) => wrapTool(tool, (original) => ({
      ...original,
      execute: async (args, api, context) => {
        const point = await this.checkpoint(api.conversationId);
        if (!point || !api.env) throw new Error("Cannot edit without an undo checkpoint.");
        const env = api.env;
        // Intercept inside the tool's file-mutation queue, after its own path normalization.
        const tracked = Object.create(env) as typeof env;
        tracked.writeFile = async (path, content, writeContext) => {
          const absolute = await env.absolutePath(path, writeContext);
          if (!absolute.ok) return absolute;
          const target = absolute.value;
          if (target === dirname(this.root) || target.startsWith(`${dirname(this.root)}/`)) {
            throw new Error("Agent file edits may not overwrite zz's own session storage.");
          }
          const before = version(target);
          const journal = this.read(point);
          const existing = journal.files.find((file) => file.path === target);
          if (existing && !same(before, existing.before)
            && (before === null || hash(Buffer.from(before.content, "base64")) !== existing.after || before.mode !== existing.afterMode)) {
            throw new Error(`File changed outside this turn; refusing to overwrite it: ${target}`);
          }
          const after = hash(typeof content === "string" ? Buffer.from(content) : content);
          const afterMode = before?.mode ?? (0o666 & ~process.umask());
          if (existing) { existing.after = after; existing.afterMode = afterMode; }
          else journal.files.push({ path: target, before, after, afterMode, parents: parents(target) });
          // Save intent before the write: a crash cannot lose the original file contents.
          this.write(point, journal);
          const result = await env.writeFile(path, content, writeContext);
          if (result.ok) {
            // Include any parent directories the tool just created. Re-read because other
            // files in the same turn may have been written concurrently during the await.
            const completed = this.read(point);
            completed.files.find((file) => file.path === target)!.parents = parents(target);
            this.write(point, completed);
          }
          return result;
        };
        return original.execute(args, { ...api, env: tracked }, context);
      },
    }))),
  });

  async checkpoint(id: ConversationId): Promise<UndoPoint | undefined> {
    const live = await this.harness.snapshot(LiveDoc, id, ctx);
    const run = live?.run?.inputs[0];
    if (run === undefined) return;
    const state = await this.harness.snapshot(UndoDoc, id, ctx);
    if (state?.restoring) throw new Error("Finish the interrupted /undo before editing files.");
    const existing = state?.points.find((point) => point.run === run);
    if (existing) return existing;
    const submission = await (await this.harness.submission(run, ctx))?.status(ctx);
    if (submission?.entry === undefined) throw new Error("Undo input is missing.");
    const conversation = (await this.harness.conversation(id, ctx))!;
    const entries = (await conversation.entries({ maxEntryId: submission.entry }, 2, undefined, ctx)).items;
    const input = entries[0]!;
    const data = input.data as { prompt?: string } | undefined;
    const prompt = data?.prompt ?? input.model?.filter((message) => message.role === "user")
      .map((message) => typeof message.content === "string" ? message.content
        : message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n")).join("\n") ?? "";
    const point: UndoPoint = { id: randomUUID(), run, prompt, timestamp: input.model?.[0]?.timestamp ?? Date.now(),
      ...(entries[1] ? { at: entries[1].id } : {}) };
    this.write(point, { files: [], shell: false });
    return this.harness.commit(async (tx) => {
      const doc = await tx.doc(UndoDoc, id);
      const found = doc.points.find((item) => item.run === run);
      if (found) return { ...found };
      doc.points.push(point);
      return point;
    }, ctx);
  }

  markShell(point: UndoPoint): void {
    const journal = this.read(point);
    journal.shell = true;
    this.write(point, journal);
  }

  read(point: UndoPoint): Journal { return JSON.parse(readFileSync(this.file(point), "utf8")) as Journal; }
  private file(point: UndoPoint): string {
    if (!/^[a-f0-9-]{36}$/.test(point.id)) throw new Error("Invalid undo checkpoint.");
    return join(this.root, `${point.id}.json`);
  }
  private write(point: UndoPoint, journal: Journal): void {
    const file = this.file(point);
    const temporary = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(journal), { mode: 0o600 });
    renameSync(temporary, file);
  }

  async checkpoints(id: ConversationId): Promise<UndoCheckpoint[]> {
    const state = await this.harness.snapshot(UndoDoc, id, ctx);
    const points = state?.points ?? [];
    const pending = state?.restoring ? state.restoreTo ?? points.at(-1)?.id : undefined;
    const result: UndoCheckpoint[] = [];
    const files = new Set<string>();
    let shell = false;
    for (let index = points.length - 1; index >= 0; index--) {
      const point = points[index]!;
      const journal = this.read(point);
      for (const file of journal.files) files.add(file.path);
      shell ||= journal.shell;
      if (pending && point.id !== pending) continue;
      result.push({ id: point.id, prompt: point.prompt, timestamp: point.timestamp, turn: index + 1,
        turns: points.length - index, files: files.size, shell, ...(pending ? { pending: true } : {}) });
    }
    return result;
  }

  /** Merge an entire suffix so preflight runs before ANY file is restored. */
  private plan(points: UndoPoint | readonly UndoPoint[]): Journal {
    const files = new Map<string, FileChange>();
    let shell = false;
    for (const point of Array.isArray(points) ? points : [points as UndoPoint]) {
      const journal = this.read(point);
      shell ||= journal.shell;
      for (const file of journal.files) {
        const previous = files.get(file.path);
        if (!previous) { files.set(file.path, structuredClone(file)); continue; }
        // A manual/shell edit between turns must not be silently swallowed by a long rewind.
        if (file.before === null || hash(Buffer.from(file.before.content, "base64")) !== previous.after
          || file.before.mode !== previous.afterMode) {
          throw new Error(`Undo refused: file changed between checkpoints: ${file.path}. Restore a newer checkpoint first.`);
        }
        for (const parent of previous.parents) {
          const next = file.parents.find((item) => item.path === parent.path);
          if (!next || next.dev !== parent.dev || next.ino !== parent.ino) {
            throw new Error(`Undo refused: parent directory changed between checkpoints: ${file.path}`);
          }
        }
        previous.after = file.after;
        previous.afterMode = file.afterMode;
        previous.parents = file.parents;
      }
    }
    return { files: [...files.values()], shell };
  }

  /** Preflight every file before changing any; accept already-restored files for crash recovery. */
  preflight(points: UndoPoint | readonly UndoPoint[]): Journal {
    const journal = this.plan(points);
    for (const file of journal.files) this.validate(file);
    return journal;
  }

  private validate(file: FileChange): FileVersion | null {
    const current = version(file.path);
    for (const parent of file.parents) {
      const info = lstatSync(parent.path);
      if (info.dev !== parent.dev || info.ino !== parent.ino) {
        throw new Error(`Undo refused: parent directory changed since the edit: ${file.path}`);
      }
    }
    if (!same(current, file.before) && (current === null || hash(Buffer.from(current.content, "base64")) !== file.after
      || current.mode !== file.afterMode)) {
      throw new Error(`Undo refused: file changed since the agent edited it: ${file.path}. Conversation and remaining files are unchanged.`);
    }
    return current;
  }

  restore(points: UndoPoint | readonly UndoPoint[]): { files: number; shell: boolean } {
    const journal = this.preflight(points);
    for (const file of journal.files) {
      if (same(this.validate(file), file.before)) continue;
      if (file.before === null) unlinkSync(file.path);
      else {
        // Atomic replacement avoids leaving a truncated original if restoration is interrupted.
        const temporary = join(dirname(file.path), `.zz-undo-${randomUUID()}.tmp`);
        try {
          writeFileSync(temporary, Buffer.from(file.before.content, "base64"), { flag: "wx", mode: 0o600 });
          chmodSync(temporary, file.before.mode);
          renameSync(temporary, file.path);
        } finally {
          try { unlinkSync(temporary); } catch (error) { if (!missing(error)) throw error; }
        }
      }
    }
    return { files: journal.files.length, shell: journal.shell };
  }
}
