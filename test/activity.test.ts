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

test("streaming thinking remains separate from replies and never exposes redacted payloads or signatures", () => {
  const session: Session = { id: "thinking", projectId: "/project", title: "Thinking", status: "working", preview: "", createdAt: 1, updatedAt: 1, messages: [] };
  const snapshot = (text: string) => ({ entries: [], docs: { "pi.live": { run: { taskId: 1, inputs: [1] }, generation: { message: {
    role: "assistant", timestamp: 2, content: [{ type: "thinking", thinking: text, thinkingSignature: "opaque-live-signature" },
      { type: "thinking", thinking: "hidden-encrypted-data", redacted: true, thinkingSignature: "encrypted" }],
  } } } } } as unknown as ConversationView);
  applyView(session, snapshot("partial reasoning"));
  assert.equal(session.messages[0]?.role, "thinking");
  const id = session.messages[0]?.thinking?.id;
  assert.equal(session.messages[0]?.text, "partial reasoning");
  applyView(session, snapshot("partial reasoning expanded"));
  assert.equal(session.messages[0]?.thinking?.id, id);
  assert.match(session.messages[0]?.text ?? "", /expanded/);
  assert.equal(session.messages[1]?.thinking?.redacted, true);
  assert.doesNotMatch(JSON.stringify(session.messages), /hidden-encrypted-data|opaque-live-signature|"encrypted"/);
  assert.equal(session.status, "working");
});

test("question tools restore waiting state from history, but only structured sets request a wizard", async () => {
  const { pendingQuestion } = await import("../src/questions.js");
  const direct = { question: "Continue?" };
  const multiple = { question: "Preferences", questions: [{ id: "name", question: "Name?", type: "input" }] };
  for (const [name, arguments_, form] of [
    ["ask_question", direct, false], ["ask_multiple_questions", multiple, true],
    ["ask_user", direct, false], ["ask_user", multiple, true],
  ] as const) {
    const s: Session = { id: name, projectId: "/project", title: "Test", status: "completed", preview: "", createdAt: 1, updatedAt: 1, messages: [] };
    const entries = [{ id: 1, model: [{ role: "assistant", timestamp: 2, content: [{ type: "toolCall", id: "question", name, arguments: arguments_ }] }] },
      { id: 2, model: [{ role: "toolResult", toolCallId: "question", toolName: name, content: [{ type: "text", text: "Continue?" }], timestamp: 3 }] }];
    applyView(s, { entries, docs: {} } as unknown as ConversationView);
    assert.equal(s.status, "needs-input");
    assert.equal(s.messages.at(-1)?.text, "Continue?");
    assert.equal(!!pendingQuestion(s), form);
    applyView(s, { entries: [...entries, { id: 3, model: [{ role: "user", content: "yes", timestamp: 4 }] }], docs: {} } as unknown as ConversationView);
    assert.equal(s.status, "completed");
    assert.equal(pendingQuestion(s), undefined);
  }
});

test("failed question tool results do not display an unanswered chat question or request a form", () => {
  for (const name of ["ask_question", "ask_multiple_questions", "ask_user"]) {
    const s: Session = { id: name, projectId: "/project", title: "Test", status: "working", preview: "", createdAt: 1, updatedAt: 1, messages: [] };
    applyView(s, { entries: [{ id: 1, model: [{ role: "toolResult", toolCallId: "bad", toolName: name, content: [{ type: "text", text: "Invalid question" }], isError: true, timestamp: 2 }] }], docs: {} } as unknown as ConversationView);
    assert.equal(s.status, "completed");
    assert.equal(s.messages.some((message) => message.role === "assistant"), false);
    assert.equal(s.messages[0]?.tool?.status, "error");
  }
});

test("projection retains interleaved prose/thinking/call boundaries and streaming call identity", () => {
  const session: Session = { id: "ordered", projectId: "/project", title: "Order", status: "working", preview: "", createdAt: 1, updatedAt: 1, messages: [] };
  const content = [
    { type: "text", text: "Before" }, { type: "toolCall", id: "a", name: "read", arguments: { path: "a.ts" } },
    { type: "thinking", thinking: "Between" }, { type: "toolCall", id: "b", name: "read", arguments: { path: "b.ts" } },
    { type: "text", text: "After" },
  ];
  const message = { role: "assistant", content, timestamp: 2 };
  applyView(session, { entries: [], docs: { "pi.live": { run: { taskId: 1, inputs: [1] }, generation: { message } } } } as unknown as ConversationView);
  assert.deepEqual(session.messages.map(m => m.role), ["assistant", "tool", "thinking", "tool", "assistant"]);
  const ids = session.messages.flatMap(m => m.tool ? [m.tool.id] : []);
  assert.ok(session.messages.filter(m => m.tool).every(m => m.tool?.preparing));
  applyView(session, { entries: [{ id: 5, model: [message] }], docs: { "pi.live": { run: { taskId: 1, inputs: [1] } } } } as unknown as ConversationView);
  assert.deepEqual(session.messages.flatMap(m => m.tool ? [m.tool.id] : []), ids);
  assert.ok(session.messages.filter(m => m.tool).every(m => !m.tool?.preparing));
  assert.deepEqual(session.messages.map(m => m.role), ["assistant", "tool", "thinking", "tool", "assistant"]);
});

test("presentation identity remains unique when providers reuse native call IDs", () => {
  const session: Session = { id: "repeated", projectId: "/project", title: "Repeated", status: "completed", preview: "", createdAt: 1, updatedAt: 1, messages: [] };
  const call = { role: "assistant", timestamp: 2, content: [{ type: "toolCall", id: "same", name: "read", arguments: { path: "a.ts" } }] };
  const result = { role: "toolResult", timestamp: 3, toolCallId: "same", toolName: "read", content: [{ type: "text", text: "source" }] };
  applyView(session, { entries: [{ id: 1, model: [call] }, { id: 2, model: [result] }, { id: 3, model: [call] }, { id: 4, model: [result] }], docs: {} } as unknown as ConversationView);
  assert.equal(new Set(session.messages.flatMap(m => m.tool ? [m.tool.id] : [])).size, 2);
});

test("execution order is observed at projection time, not at completion or paint time", () => {
  const session: Session = { id: "starts", projectId: "/project", title: "Starts", status: "working", preview: "", createdAt: 1, updatedAt: 1, messages: [] };
  const entries = [{ id: 1, model: [{ role: "assistant", timestamp: 2, content: [
    { type: "toolCall", id: "a", name: "read", arguments: { path: "a.ts" } },
    { type: "toolCall", id: "b", name: "read", arguments: { path: "b.ts" } },
  ] }] }];
  const view = (a: string, b: string) => ({ entries, docs: { "pi.live": { run: { taskId: 1, inputs: [1] }, tools: [
    { callId: "a", name: "read", status: a, taskId: 10 }, { callId: "b", name: "read", status: b, taskId: 11 },
  ] } } } as unknown as ConversationView);
  applyView(session, view("running", "pending"));
  applyView(session, view("running", "running"));
  applyView(session, view("running", "done"));
  applyView(session, view("done", "done"));
  const orders = session.messages.flatMap(m => m.tool ? [m.tool.executionOrder] : []);
  assert.deepEqual(orders, [1, 2]);
});
