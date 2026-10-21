import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { StateWriter, type PrepareSnapshot } from "../src/state-writer.js";
import { Store } from "../src/store.js";
import type { State } from "../src/model.js";
import { temporary, tick } from "./helpers.js";

function gatedWriter() {
  const pending: { release(): void; text: string }[] = [];
  const prepare: PrepareSnapshot = (state, file) => {
    const text = JSON.stringify(state);
    return new Promise<void>((resolve, reject) => {
      pending.push({ text, release: () => { void writeFile(file, text, { mode: 0o600 }).then(resolve, reject); } });
    });
  };
  return { pending, prepare };
}

async function until(predicate: () => boolean) {
  for (let i = 0; i < 1000; i++) { if (predicate()) return; await tick(); }
  assert.fail("Writer did not advance");
}

for (const synchronous of [false, true]) test(`background snapshots cannot overwrite newer ${synchronous ? "synchronous checkpoints" : "queued snapshots"}`, async () => {
  const f = temporary(), gate = gatedWriter();
  const state: State = { version: 2, projects: [], sessions: [], selectedProjectId: "old" };
  const file = join(f.root, "state.json"), writer = new StateWriter(file, () => state, gate.prepare);
  try {
    const first = writer.save();
    await until(() => gate.pending.length === 1);
    state.selectedProjectId = "new";
    let second: Promise<void> | undefined;
    if (synchronous) { writer.invalidate(); writeFileSync(file, JSON.stringify(state)); }
    else second = writer.save();
    gate.pending[0]!.release();
    if (!synchronous) {
      await until(() => gate.pending.length === 2);
      assert.equal(existsSync(file), false, "superseded snapshots are never published");
      gate.pending[1]!.release();
    }
    await Promise.all([first, second, writer.flush()]);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).selectedProjectId, "new");
    assert.deepEqual(readdirSync(f.root), ["state.json"]);
  } finally { await writer.close(); f.cleanup(); }
});

test("same-turn requests coalesce and all waiters observe the final snapshot", async () => {
  const f = temporary(), gate = gatedWriter();
  const state: State = { version: 2, projects: [], sessions: [] };
  const writer = new StateWriter(join(f.root, "state.json"), () => state, gate.prepare);
  try {
    const saves = Array.from({ length: 20 }, (_, i) => { state.selectedProjectId = String(i); return writer.save(); });
    await until(() => gate.pending.length === 1);
    assert.equal(JSON.parse(gate.pending[0]!.text).selectedProjectId, "19");
    gate.pending[0]!.release();
    await Promise.all(saves);
    assert.equal(gate.pending.length, 1);
  } finally { await writer.close(); f.cleanup(); }
});

test("write failures preserve the old checkpoint, clean temporary files, and allow retry", async () => {
  const f = temporary(); let fail = true;
  const state: State = { version: 2, projects: [], sessions: [] }, file = join(f.root, "state.json");
  writeFileSync(file, "old checkpoint");
  const writer = new StateWriter(file, () => state, async (snapshot, temporary) => {
    await writeFile(temporary, JSON.stringify(snapshot));
    if (fail) throw new Error("disk failure");
  });
  try {
    await assert.rejects(writer.save(), /disk failure/);
    assert.equal(readFileSync(file, "utf8"), "old checkpoint");
    assert.deepEqual(readdirSync(f.root), ["state.json"]);
    fail = false; await writer.save();
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), state);
  } finally { await writer.close(); f.cleanup(); }
});

test("Store worker preserves the snapshot format, permissions, and history and flushes on close", async () => {
  const f = temporary(), store = new Store(f.root);
  store.addProject(f.root);
  store.state.sessions.push({ id: "s", projectId: store.state.projects[0]!.id,
    title: "Test", status: "working", preview: "partial", createdAt: 1, updatedAt: 1,
    messages: [{ role: "assistant", text: "retained history", timestamp: 1 }] });
  try {
    const saving = store.saveAsync();
    await store.close(); await saving;
    assert.deepEqual(new Store(f.root).state, store.state);
    assert.equal(statSync(store.file).mode & 0o777, 0o600);
    assert.equal(readdirSync(f.root).some(name => name.endsWith(".tmp")), false);
  } finally { await store.close(); f.cleanup(); }
});

test("worker serialization errors reject without destroying the last checkpoint and can be retried", async () => {
  const f = temporary(), store = new Store(f.root);
  const state = store.state as State & { circular?: unknown };
  store.save();
  const original = readFileSync(store.file, "utf8");
  try {
    state.circular = state;
    await assert.rejects(store.saveAsync(), /circular/i);
    assert.equal(readFileSync(store.file, "utf8"), original);
    delete state.circular;
    await store.saveAsync();
    assert.deepEqual(new Store(f.root).state, store.state);
  } finally { await store.close(); f.cleanup(); }
});
