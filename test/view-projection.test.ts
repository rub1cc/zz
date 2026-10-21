import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationView } from "@earendil-works/pi-durable";
import { applyView, createViewProjector } from "../src/engine.js";
import type { Session } from "../src/model.js";

const session = (): Session => ({ id: "s", projectId: "p", title: "Test", status: "working", preview: "", createdAt: 1, updatedAt: 1, messages: [] });
const view = (entries: unknown[], live: unknown = {}, docs = {}) => ({ entries, docs: { ...docs, "pi.live": live } }) as unknown as ConversationView;
const call = { id: 2, model: [{ role: "assistant", timestamp: 2,
  content: [{ type: "toolCall", id: "read", name: "read", arguments: { path: "file.txt" } }] }] };
const user = { id: 1, model: [{ role: "user", content: "Read file", timestamp: 1 }] };
const run = { taskId: 1, inputs: [1] };

test("live updates reuse committed projections without rescanning entries or mutating prior tool snapshots", () => {
  const s = session(), project = createViewProjector(s);
  let scans = 0;
  const entry = { id: 1, get model() { scans++; return user.model; } };
  const entries = [entry, call];
  assert.equal(project(view(entries, { run, tools: [{ callId: "read", name: "read", status: "running", output: "first" }] })), true);
  const scansBefore = scans, committed = s.messages[0], first = s.messages[1];
  assert.equal(project(view(entries, { run, tools: [{ callId: "read", name: "read", status: "running", output: "second" }] })), false);
  assert.equal(scans, scansBefore);
  assert.equal(s.messages[0], committed);
  assert.equal(first?.tool?.output, "first");
  assert.equal(s.messages[1]?.tool?.output, "second");
  assert.notEqual(first, s.messages[1]);
  assert.equal(project(view(entries)), true);
  assert.equal(s.messages[1]?.tool?.status, "interrupted");
  assert.equal(s.messages[1]?.tool?.output, "");
});

test("cached and uncached projection agree through streaming, results, questions, compaction and history replacement", () => {
  const cached = session(), uncached = session(), project = createViewProjector(cached);
  const entries = [user, call];
  const result = { id: 3, model: [{ role: "toolResult", toolCallId: "read", toolName: "read", timestamp: 3,
    content: [{ type: "text", text: "Saved result" }], isError: false }] };
  const completed = [...entries, result];
  const question = [...completed, { id: 4, model: [{ role: "assistant", timestamp: 4, content: [
    { type: "toolCall", id: "ask", name: "ask_question", arguments: { question: "Continue?" } },
  ] }] }, { id: 5, model: [{ role: "toolResult", toolCallId: "ask", toolName: "ask_question", timestamp: 5,
    content: [{ type: "text", text: "Continue?" }] }] }];
  const snapshots = [view(entries, { run }), view(entries, { run, tools: [{ callId: "read", status: "running", output: "live" }] }),
    view(entries, { run, generation: { message: { role: "assistant", timestamp: 3,
      content: [{ type: "thinking", thinking: "reasoning", thinkingSignature: "secret" }, { type: "text", text: "partial" }] } } }),
    view(completed, { run }), view(completed), view(question), view(question),
    view([{ id: 6, kind: "pi.compaction", data: { reason: "manual" }, model: [{ role: "assistant", timestamp: 6,
      content: [{ type: "text", text: "Summary" }] }] }]),
    view([user]), view([user], { run }), view([user, { id: 7, kind: "zz.workspace_failed", data: { message: "handoff failure" } }]),
  ];
  for (const snapshot of snapshots) {
    project(snapshot); applyView(uncached, snapshot);
    assert.deepEqual(cached, uncached);
  }
});

test("metadata changes persist, while changing streamed text alone does not", () => {
  const s = session(), project = createViewProjector(s), entries = [user];
  const agent = { model: { provider: "test", modelId: "mock" }, thinkingLevel: "off" };
  const docs = { "pi.agent": agent };
  const live = (text: string) => ({ run, generation: { message: { role: "assistant", timestamp: 2, content: [{ type: "text", text }] } } });
  assert.equal(project(view(entries, live("a"), docs)), true);
  assert.equal(project(view(entries, live("b"), docs)), false);
  assert.equal(s.messages.at(-1)?.text, "b");
  assert.equal(project(view(entries, live("b"), { "pi.agent": { ...agent, thinkingLevel: "high" } })), true);
  assert.equal(s.agent?.thinkingLevel, "high");
  assert.equal(project(view([...entries], live("c"), docs)), true, "history replacement invalidates even at the same length");
});
