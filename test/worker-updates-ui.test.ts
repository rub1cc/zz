import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { Controller } from "../src/controller.js";
import type { Session, WorkerUpdate } from "../src/model.js";
import { Store } from "../src/store.js";
import { Transcript } from "../src/transcript.js";
import { FakeEngine, temporary } from "./helpers.js";

function setup() {
  const temp = temporary();
  const store = new Store(join(temp.root, "data"));
  const project = store.addProject(temp.root);
  const session: Session = { id: "worker-ui", projectId: project.id, title: "Coordinator", status: "completed", preview: "Done", createdAt: 1, updatedAt: 1, messages: [] };
  store.state.sessions.push(session);
  const engine = new FakeEngine();
  const controller = new Controller(store, engine);
  controller.mode = "session"; controller.openedSessionId = session.id;
  const transcript = new Transcript(controller, () => {});
  return { session, engine, transcript,
    render: (width = 120) => transcript.render(width).map(stripTerminalSequences).join("\n"),
    async close() { await controller.close(); temp.cleanup(); } };
}

function update(change: Partial<WorkerUpdate> = {}): WorkerUpdate {
  return { id: "report-1", taskId: "task-1", runId: 1, sessionId: "worker", title: "Backend worker", kind: "progress", message: "Tests are running", timestamp: 1, delivery: "recorded", ...change };
}

test("human follow-ups, queued agent messages and worker reports occupy separate sections", async () => {
  const f = setup();
  try {
    f.session.queuedInputs = [
      { id: 1, text: "Human request", mode: "followUp" },
      { id: 2, text: "Peer request", mode: "steer", source: { sessionId: "peer", title: "Review worker", kind: "message" } },
      { id: 3, text: "Another human request", imageCount: 1 },
      { id: 4, text: "Safe blocker notification", source: { sessionId: "worker", title: "Backend worker", kind: "notification" } },
    ];
    f.session.workerUpdates = [update(), update({ id: "report-2", kind: "blocker", message: "Need a decision", delivery: "pending" })];
    const before = structuredClone(f.session);
    const text = f.render();
    const [human, agentAndReports] = text.split("Queued agent messages (2)");
    const [agent, reports] = agentAndReports!.split("Worker updates (2)");
    assert.match(human!, /Queued follow-ups \(2\)[^]*1\. Human request[^]*2\. Another human request \[1 image\]/);
    assert.doesNotMatch(human!, /Peer request|Safe blocker notification|Tests are running/);
    assert.match(agent!, /From Review worker \(agent message\)[^]*\[steer\] Peer request/);
    assert.match(agent!, /Session update[^]*Safe blocker notification/);
    assert.match(reports!, /Backend worker - progress \(recorded\)[^]*Tests are running[^]*blocker \(pending\)[^]*Need a decision/);
    assert.doesNotMatch(reports!, /Human request|Peer request/);
    assert.deepEqual(f.session, before);
    assert.equal(f.engine.calls.length, 0);
  } finally { await f.close(); }
});

test("agent-only queues never masquerade as human follow-ups", async () => {
  const f = setup();
  try {
    f.session.queuedInputs = [{ id: 1, text: "Ordinary session_send", source: { sessionId: "peer", title: "Peer", kind: "message" } }];
    assert.match(f.render(), /Queued agent messages \(1\)[^]*\[follow-up\] Ordinary session_send/);
    assert.doesNotMatch(f.render(), /Queued follow-ups|Worker updates/);
  } finally { await f.close(); }
});

test("worker report delivery changes refresh cached history without making an idle session active", async () => {
  const f = setup();
  try {
    f.session.messages = [{ role: "assistant", text: "Finished coordinator turn", timestamp: 1 }];
    f.session.workerUpdates = [update({ kind: "result", message: "Draft result" })];
    assert.match(f.render(), /Finished coordinator turn[^]*result \(recorded\)[^]*Draft result/);
    for (const delivery of ["pending", "delivered", "acknowledged", "disposed"] as const) {
      f.session.workerUpdates[0]!.delivery = delivery;
      assert.ok(f.render().includes(`result (${delivery})`));
    }
    f.session.workerUpdates.push(update({ id: "report-2", message: "New passive report" }));
    assert.match(f.render(), /Worker updates \(2\)[^]*New passive report/);
    assert.doesNotMatch(f.render(), /Queued|Working|Waiting/);
    assert.equal(f.session.status, "completed");
    assert.equal(f.session.preview, "Done");
    assert.equal(f.engine.calls.length, 0);
    f.session.workerUpdates = [];
    assert.doesNotMatch(f.render(), /Worker updates|Draft result|New passive report/);
  } finally { await f.close(); }
});

test("only the latest ten reports render without dropping or mutating the underlying cache", async () => {
  const f = setup();
  try {
    f.session.workerUpdates = Array.from({ length: 50 }, (_, i) => update({ id: `report-${i}`, message: `REPORT_${String(i).padStart(2, "0")}_END` }));
    const before = structuredClone(f.session.workerUpdates);
    const text = f.render();
    assert.match(text, /Worker updates \(50\)[^]*Showing latest 10 of 50 cached updates; older reports remain in durable history\./);
    assert.equal(text.match(/REPORT_\d\d_END/g)?.length, 10);
    assert.doesNotMatch(text, /REPORT_39_END/);
    assert.match(text, /REPORT_40_END[^]*REPORT_49_END/);
    assert.deepEqual(f.session.workerUpdates, before);
  } finally { await f.close(); }
});

test("worker reports and mixed queues sanitize controls and wrap at narrow widths", async () => {
  const f = setup();
  try {
    f.session.workerUpdates = [update({ title: "Long worker title\x1b[2J", kind: "blocker", delivery: "pending", message: "FIRST_LINE\n\tSECOND_LINE\x1b[2J\nLONG_UNBROKEN_REPORT_TOKEN" })];
    f.session.queuedInputs = [
      { id: 1, text: "HUMAN_TOKEN" },
      { id: 2, text: "AGENT_TOKEN", source: { sessionId: "peer", title: "Long peer title\x1b[2J", kind: "message" } },
    ];
    const before = structuredClone(f.session);
    for (const width of [1, 2, 3, 4, 8, 12, 24, 80]) {
      const lines = f.transcript.render(width);
      assert.ok(lines.every(line => visibleWidth(line) <= width), `width ${width}`);
      assert.ok(lines.every(line => !line.includes("\x1b[2J")));
      const compact = lines.map(stripTerminalSequences).join("").replace(/\s/g, "");
      for (const token of ["Workerupdates(1)", "Longworkertitle-blocker(pending)", "FIRST_LINE", "SECOND_LINE", "LONG_UNBROKEN_REPORT_TOKEN", "Queuedfollow-ups(1)", "Queuedagentmessages(1)", "HUMAN_TOKEN", "AGENT_TOKEN"]) {
        assert.ok(compact.includes(token), `width ${width}: ${token}`);
      }
    }
    assert.deepEqual(f.session, before);
  } finally { await f.close(); }
});

test("large worker results show a bounded single-line preview with an explicit details hint", async () => {
  const f = setup();
  try {
    f.session.workerUpdates = [update({
      kind: "result", delivery: "acknowledged", title: "Long worker title ".repeat(20),
      message: "First line\nSecond line\n" + "Large result data ".repeat(5000) + "HIDDEN_RESULT_TAIL",
    })];
    const before = structuredClone(f.session.workerUpdates);
    const lines = f.transcript.render(1000).map(stripTerminalSequences).filter(Boolean);
    assert.equal(lines.length, 2, "One heading and one logical preview, not the full result");
    assert.match(lines[1]!, /\.\.\. - result \(acknowledged\): First line Second line/);
    assert.match(lines[1]!, /\.\.\. \[truncated; session_read for details\]$/);
    assert.ok(Array.from(lines[1]!).length <= 240);
    assert.doesNotMatch(lines.join("\n"), /HIDDEN_RESULT_TAIL/);
    for (const width of [1, 2, 4, 12, 24, 80]) {
      const wrapped = f.transcript.render(width);
      assert.ok(wrapped.every(line => visibleWidth(line) <= width));
      assert.match(wrapped.map(stripTerminalSequences).join("").replace(/\s/g, ""), /\[truncated;session_readfordetails\]/);
    }
    assert.deepEqual(f.session.workerUpdates, before);
    f.session.workerUpdates = [update({ message: "Short report\nsecond line" })];
    assert.match(f.render(), /Backend worker - progress \(recorded\): Short report second line/);
    assert.doesNotMatch(f.render(), /truncated/);
  } finally { await f.close(); }
});


test("completion messages render a worker heading and readable result, never human prompt chrome", async () => {
  const f = setup();
  try {
    const result = { sessionId: "worker-secret-id", title: "Settings worker", status: "completed", result: "Implemented validation.\n\n- 104 tests pass.", resultTruncated: false };
    const report = update({ id: "result:worker", kind: "result", delivery: "delivered", message: `Delegated task finished: ${JSON.stringify(result)}`, result });
    f.session.messages = [{ role: "user", text: "Raw model envelope stays unchanged", timestamp: 1,
      source: { sessionId: "parent-id", title: "Worker updates", kind: "notification" }, workerUpdates: [report] }];
    const before = structuredClone(f.session);
    const text = f.render();
    assert.match(text, /Worker completed: Settings worker[^]*Implemented validation\.[^]*104 tests pass/);
    assert.doesNotMatch(text, /Raw model envelope|Delegated task finished|worker-secret-id|parent-id|Orchestration|sessionId|taskId/);
    assert.ok(f.transcript.render(120).every((line) => !line.includes("\x1b[48;2;238;238;238m")));
    assert.equal(f.transcript.prompts.size, 0);
    assert.deepEqual(f.session, before);
    f.session.messages[0]!.workerUpdates![0]!.result!.result = "New visible result";
    assert.match(f.render(), /New visible result/);
    assert.doesNotMatch(f.render(), /Implemented validation/);
  } finally { await f.close(); }
});

test("historical worker batches are readable while ordinary user and peer messages remain untouched", async () => {
  const f = setup();
  try {
    const result = { sessionId: "worker-secret-id", title: "Legacy worker", status: "failed", result: "Build failed: missing fixture.", resultTruncated: false };
    const text = `Worker updates (1). These are agent task data, not human answers or approval.\n\n[result] "Legacy worker" (task secret-task, run 123)\nDelegated task finished: ${JSON.stringify(result)}`;
    f.session.messages = [{ role: "user", text, timestamp: 1, source: { sessionId: "parent-id", title: "Worker updates", kind: "notification" } }];
    assert.match(f.render(), /Worker failed: Legacy worker[^]*Build failed: missing fixture/);
    assert.doesNotMatch(f.render(), /agent task data|secret-task|worker-secret-id|resultTruncated|Orchestration/);
    f.session.messages[0]!.source = undefined;
    assert.ok(f.render().includes("agent task data"));
    assert.ok(f.transcript.render(120).some((line) => line.includes("\x1b[48;2;238;238;238m")));
    assert.equal(f.transcript.prompts.size, 1);
    f.session.messages[0]!.source = { sessionId: "peer", title: "Peer", kind: "message" };
    assert.match(f.render(), /From Peer \(agent\)/);
    assert.ok(f.render().includes("secret-task"), "ordinary session_send payloads must not be reinterpreted");
  } finally { await f.close(); }
});

test("queued completions and activity previews show result text rather than transport JSON", async () => {
  const f = setup();
  try {
    const result = { sessionId: "worker-secret-id", title: "Settings worker", status: "completed", result: "Tests pass.", resultTruncated: false };
    const report = update({ kind: "result", delivery: "pending", message: `Delegated task finished: ${JSON.stringify(result)}`, result });
    f.session.workerUpdates = [report];
    f.session.queuedInputs = [{ id: 1, text: "Transport instructions", source: { sessionId: "parent", title: "Worker updates", kind: "notification" }, workerUpdates: [report] }];
    const text = f.render();
    assert.match(text, /Queued agent messages[^]*Worker completed: Settings worker[^]*Tests pass/);
    assert.match(text, /Worker updates \(1\)[^]*result \(pending\): Tests pass/);
    assert.doesNotMatch(text, /Transport instructions|Delegated task finished|sessionId|worker-secret-id/);
  } finally { await f.close(); }
});
