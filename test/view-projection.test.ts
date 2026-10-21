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

test("cached streaming calls preserve block order and identity through admission without rescanning history", () => {
  const s = session(), project = createViewProjector(s), entries = [user];
  const content = [{ type: "text", text: "Before" },
    { type: "toolCall", id: "a", name: "read", arguments: { path: "a.ts" } },
    { type: "thinking", thinking: "Between" },
    { type: "toolCall", id: "b", name: "read", arguments: { path: "b.ts" } },
    { type: "text", text: "After" }];
  const message = { role: "assistant", timestamp: 2, content };
  assert.equal(project(view(entries, { run, generation: { message } })), true);
  const preparing = s.messages.filter(item => item.tool);
  const ids = preparing.map(item => item.tool!.id);
  assert.deepEqual(s.messages.map(item => item.role), ["user", "assistant", "tool", "thinking", "tool", "assistant"]);
  assert.ok(preparing.every(item => item.tool!.preparing));
  assert.equal(project(view(entries, { run, generation: { message: { ...message, content: [...content, { type: "text", text: "More" }] } } })), false);
  assert.deepEqual(s.messages.filter(item => item.tool).map(item => item.tool!.id), ids);
  const admitted = [...entries, { id: 2, model: [message] }];
  assert.equal(project(view(admitted, { run })), true);
  assert.deepEqual(s.messages.filter(item => item.tool).map(item => item.tool!.id), ids);
  assert.ok(s.messages.filter(item => item.tool).every(item => !item.tool!.preparing));
  assert.ok(preparing.every(item => item.tool!.preparing), "admission does not mutate earlier streamed snapshots");
});

test("cached execution order survives result commits and never mutates prior snapshots or the base cache", () => {
  const s = session(), project = createViewProjector(s);
  const entries = [{ id: 1, model: [{ role: "assistant", timestamp: 2, content: [
    { type: "toolCall", id: "a", name: "read", arguments: { path: "a.ts" } },
    { type: "toolCall", id: "b", name: "read", arguments: { path: "b.ts" } },
  ] }] }];
  const slots = (a: string, b: string) => [{ callId: "a", name: "read", status: a, taskId: 10 },
    { callId: "b", name: "read", status: b, taskId: 11 }];
  project(view(entries, { run, tools: slots("running", "pending") }));
  const first = s.messages;
  project(view(entries, { run, tools: slots("done", "running") }));
  assert.deepEqual(s.messages.map(item => item.tool?.executionOrder), [1, 2]);
  assert.equal(first[1]?.tool?.executionOrder, undefined);
  const completed = [...entries, { id: 2, model: ["a", "b"].map(toolCallId => ({ role: "toolResult", timestamp: 3,
    toolCallId, toolName: "read", content: [{ type: "text", text: "Done" }], isError: false })) }];
  project(view(completed, { run, tools: slots("done", "done") }));
  assert.deepEqual(s.messages.map(item => item.tool?.executionOrder), [1, 2]);
  assert.ok(s.messages.every(item => item.tool?.status === "done"));
  const previous = s.messages;
  project(view(completed, { run: { ...run, taskId: 2 } }));
  assert.deepEqual(s.messages.map(item => item.tool?.executionOrder), [undefined, undefined], "new runs do not inherit cached execution metadata");
  assert.deepEqual(previous.map(item => item.tool?.executionOrder), [1, 2]);
});

test("cached projections preserve agent provenance without duplicating tool cards or rescanning live updates", () => {
  const s = session(), project = createViewProjector(s);
  const source = { sessionId: "peer", title: "Backend", kind: "message" as const };
  let scans = 0;
  const input = { id: 1, kind: "zz.agent_input", data: { prompt: "API details", source },
    get model() { scans++; return [{ role: "user", content: "Agent-authored message envelope", timestamp: 1 }]; } };
  const entries = [input, call];
  project(view(entries, { run, tools: [{ callId: "read", name: "read", status: "running", output: "first" }] }));
  assert.equal(s.messages[0]?.text, "API details"); assert.deepEqual(s.messages[0]?.source, source);
  assert.equal(s.messages.filter((message) => message.tool).length, 1);
  const scansBefore = scans, cachedInput = s.messages[0];
  assert.equal(project(view(entries, { run, tools: [{ callId: "read", name: "read", status: "running", output: "second" }] })), false);
  assert.equal(scans, scansBefore); assert.equal(s.messages[0], cachedInput);
  assert.equal(s.messages.find((message) => message.tool)?.tool?.output, "second");
  assert.equal(s.messages.filter((message) => message.tool).length, 1);
});
