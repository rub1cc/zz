import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import type { Session, WorkerUpdate } from "../src/model.js";
import { Store } from "../src/store.js";
import { temporary } from "./helpers.js";

test("worker presentation caches and queue provenance round-trip and reject malformed checkpoints", () => {
  const temp = temporary();
  try {
    const store = new Store(temp.root);
    const project = store.addProject(temp.root);
    const result = { sessionId: "worker", title: "Worker", status: "completed", result: "Tests pass", resultTruncated: false };
    const update: WorkerUpdate = { id: "result:worker", sessionId: "worker", title: "Worker", taskId: "task", runId: 1,
      kind: "result", message: "Done", timestamp: 2, delivery: "acknowledged", result, waitResults: [result], observedSessionIds: ["worker"] };
    const session: Session = { id: "coordinator", projectId: project.id, title: "Coordinator", preview: "Done", createdAt: 1, updatedAt: 2,
      status: "completed", messages: [{ role: "user", text: "Transport", timestamp: 2, source: { sessionId: "owner", title: "Worker updates", kind: "notification" }, workerUpdates: [update] }], workerUpdates: [update], delegation: { parentId: "owner", taskId: "task", runId: 1 },
      queuedInputs: [{ id: 1, text: "Peer message", workerUpdates: [update], source: { sessionId: "peer", title: "Peer", kind: "message" } }] };
    store.state.sessions.push(session); store.save();
    assert.deepEqual(new Store(temp.root).state.sessions[0], session);
    const saved = readFileSync(store.file, "utf8");
    for (const change of [
      (session: Session) => { session.workerUpdates = [null as never]; },
      (session: Session) => { session.messages[0]!.workerUpdates = [null as never]; },
      (session: Session) => { session.queuedInputs![0]!.workerUpdates = [null as never]; },
      (session: Session) => { session.workerUpdates![0]!.delivery = "invented" as never; },
      (session: Session) => { session.workerUpdates![0]!.runId = null as never; },
      (session: Session) => { session.workerUpdates![0]!.result!.resultTruncated = "yes" as never; },
      (session: Session) => { session.workerUpdates![0]!.waitResults = [null as never]; },
      (session: Session) => { session.workerUpdates![0]!.observedSessionIds = [1 as never]; },
      (session: Session) => { session.delegation!.runId = "another" as never; },
      (session: Session) => { session.queuedInputs![0]!.source!.kind = "human" as never; },
    ]) {
      const state = JSON.parse(saved) as typeof store.state;
      change(state.sessions[0]!); const invalid = JSON.stringify(state); writeFileSync(store.file, invalid);
      assert.throws(() => new Store(temp.root), /Invalid zz state/);
      assert.equal(readFileSync(store.file, "utf8"), invalid, "validation must not rewrite bad checkpoints");
    }
  } finally { temp.cleanup(); }
});
