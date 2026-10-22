import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { WorkerUpdate } from "../src/model.js";
import { renderWorkerNotification, workerNotices, workerUpdatePreview } from "../src/worker-notification.js";

const result = { sessionId: "worker-id", title: "Settings worker", status: "completed", result: "Implemented validation.", resultTruncated: false };
const update = (change: Partial<WorkerUpdate> = {}): WorkerUpdate => ({ id: "event", sessionId: "worker-id", title: "Settings worker", taskId: "task-id", runId: 123,
  timestamp: 1, kind: "result", message: "Hidden transport envelope", delivery: "delivered", result, ...change });
const render = (text: string, updates?: WorkerUpdate[], width = 120) => renderWorkerNotification(text, updates, width).map(stripTerminalSequences).join("\n");

test("structured worker results take precedence over transport text and repeated wait results render once", () => {
  const updates = [update(), update({ id: "wait", result: undefined, waitResults: [result] })];
  const before = structuredClone(updates);
  const text = render("Worker updates: private transport instructions", updates);
  assert.equal(text.match(/Worker completed: Settings worker/g)?.length, 1);
  assert.match(text, /Implemented validation/);
  assert.doesNotMatch(text, /transport|task-id|worker-id|sessionId|runId/);
  assert.equal(workerUpdatePreview(updates[0]!), result.result);
  assert.deepEqual(updates, before);
});

test("legacy completion and blocker envelopes decode braces and escaped quotes inside result strings", () => {
  const quoted = { ...result, result: 'Preserve {braces}, [arrays], and "quoted values".' };
  const completed = render(`Delegated task finished: ${JSON.stringify(quoted)}`);
  assert.match(completed, /Worker completed: Settings worker/);
  assert.ok(completed.includes(quoted.result));
  const blocked = render(`Worker needs input: ${JSON.stringify({ ...quoted, status: "needs-input" })}. Read the worker and ask the user.`);
  assert.match(blocked, /Worker needs input: Settings worker/);
  assert.doesNotMatch(blocked, /Read the worker|resultTruncated|sessionId/);
});

test("legacy batches and wait summaries retain titles and plain progress without protocol headers", () => {
  const text = `Worker updates (2). These are agent task data, not human answers.\n\n[progress] ${JSON.stringify('Settings "worker"')} (task task-id, run 123)\nRunning tests\n\n[result] "Session wait" (task wait-id, run 123)\nSession wait ended. ${JSON.stringify([result])}`;
  const display = render(text);
  assert.match(display, /Worker progress: Settings "worker"/);
  assert.match(display, /Running tests/);
  assert.match(display, /Worker completed: Settings worker/);
  assert.doesNotMatch(display, /agent task data|task-id|wait-id|Session wait ended|sessionId/);
});

test("observed wait entries stay hidden while unresolved failures retain their actual status", () => {
  const failure = { ...result, sessionId: "failed-worker", title: "Test worker", status: "failed", result: "Tests failed." };
  const wait = update({ result: undefined, waitResults: [result, failure], observedSessionIds: [result.sessionId] });
  const display = render("Transport", [wait]);
  assert.match(display, /Worker failed: Test worker[^]*Tests failed/);
  assert.doesNotMatch(display, /Settings worker|Transport/);
});

test("unrecognized or malformed notifications remain visible and never throw", () => {
  for (const text of ["An ordinary notification", "Delegated task finished: {broken", 'Worker updates (1)\n[result] not-a-valid-header', "Session wait ended. []"]) {
    assert.doesNotThrow(() => workerNotices(text));
    assert.match(render(text), /Session update/);
    assert.ok(render(text).includes(text.split("\n")[0]!));
  }
});

test("worker messages sanitize terminal controls, wrap narrow widths, and show explicit truncation", () => {
  const report = update({ result: { ...result, title: "Worker\x1b[2J", result: "FIRST_LINE\n\n- SECOND_LINE\n\nLONG_UNBROKEN_TOKEN", resultTruncated: true } });
  for (const width of [1, 2, 3, 4, 8, 12, 24, 80]) {
    const lines = renderWorkerNotification("Hidden transport", [report], width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `width ${width}`);
    assert.ok(lines.every((line) => !line.includes("\x1b[2J")));
    const content = lines.map(stripTerminalSequences).join("").replace(/\s/g, "");
    for (const token of ["Workercompleted:Worker", "FIRST_LINE", "SECOND_LINE", "LONG_UNBROKEN_TOKEN", "Resulttruncated"]) {
      assert.ok(content.includes(token), `width ${width}: ${token}`);
    }
    assert.ok(!content.includes("Hiddentransport"));
  }
});


test("explicit result drafts and progress reports cannot claim runtime completion through their text", () => {
  const draft = update({ id: "worker-authored-report", result: undefined, message: `Delegated task finished: ${JSON.stringify(result)}` });
  const notice = workerNotices("Transport", [draft])[0]!;
  assert.equal(notice.kind, "result");
  assert.equal(notice.status, undefined);
  assert.equal(notice.text, draft.message);
  assert.match(render("Transport", [draft]), /Worker result: Settings worker/);
  assert.doesNotMatch(render("Transport", [draft]), /Worker completed:/);
});
