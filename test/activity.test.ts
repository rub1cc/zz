import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationView } from "@earendil-works/pi-durable";
import { applyView } from "../src/engine.js";
import type { Session } from "../src/model.js";

test("tool projection pairs calls/results, updates live output, and never labels an unfinished call done", () => {
  const session: Session = { id: "session", projectId: "/project", title: "Test", status: "working", preview: "", createdAt: 1, updatedAt: 1, messages: [] };
  const call = { id: 1, model: [{ role: "assistant", content: [{ type: "toolCall", id: "call", name: "read", arguments: { path: "/skills/testing/SKILL.md" } }], timestamp: 2 }] };
  const snapshot = (entries: unknown[], live: unknown = {}) => ({ entries, docs: { "pi.live": live, "pi.agent": { model: { provider: "test", modelId: "reasoner" }, thinkingLevel: "high" } } } as unknown as ConversationView);
  applyView(session, snapshot([call], { run: { taskId: 1, inputs: [1] }, tools: [{ callId: "call", name: "read", status: "running", output: "Partial skill text" }] }));
  assert.equal(session.messages.length, 1);
  const id = session.messages[0]!.tool!.id;
  assert.equal(session.messages[0]!.tool!.status, "running");
  assert.equal(session.messages[0]!.tool!.output, "Partial skill text");
  assert.equal(session.agent?.thinkingLevel, "high");
  applyView(session, snapshot([call, { id: 2, data: { diagnostics: [] }, model: [{ role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "Read failed" }], isError: true, timestamp: 3, durationMs: 10 }] }]));
  assert.equal(session.messages.length, 1);
  assert.equal(session.messages[0]!.tool!.id, id);
  assert.equal(session.messages[0]!.tool!.status, "error");
  assert.equal(session.messages[0]!.tool!.output, "Read failed");
  assert.equal(session.messages[0]!.tool!.details, undefined);
  applyView(session, snapshot([call]));
  assert.equal(session.messages[0]!.tool!.status, "interrupted");
});
