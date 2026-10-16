import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import type { Message, Usage } from "@earendil-works/pi-ai";
import { estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { ContextView, ConversationView } from "@earendil-works/pi-durable";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { applyView } from "../src/engine.js";
import type { Session } from "../src/model.js";
import { Store } from "../src/store.js";
import { composerStatus, contextEstimate, emptyUsage, formatCost, formatTokens, sessionStats, usageDetails } from "../src/usage.js";
import { temporary } from "./helpers.js";

const usage: Usage = { input: 100, output: 50, cacheRead: 300, cacheWrite: 50, totalTokens: 500,
  cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04, total: 0.1 } };
const assistant: Message = { role: "assistant", api: "openai-responses", provider: "test", model: "mock",
  content: [{ type: "text", text: "response" }], stopReason: "stop", usage, timestamp: 2 };
const user: Message = { role: "user", content: "a trailing user message", timestamp: 3 };

function context(messages: Message[], head?: number): ContextView {
  return { head: head === undefined ? undefined : { id: head },
    entries: messages.map((_, i) => ({ id: i + 1 })), contributions: messages.map((m) => [m]), messages } as unknown as ContextView;
}

function session(): Session {
  return { id: "s", projectId: "/project", title: "Usage", preview: "", status: "completed", createdAt: 1, updatedAt: 1, messages: [] };
}

test("context estimates add trailing content, but never reuse pre-head usage", () => {
  assert.equal(contextEstimate(context([assistant])).tokens, 500);
  assert.equal(contextEstimate(context([assistant, user])).tokens, 500 + estimateMessageTokens(user));
  assert.equal(contextEstimate(context([assistant])).cacheHitRate, 300 / 450 * 100);
  // A new summary/reset invalidates old measurements even if retained in the derived context.
  const view = context([assistant, user], 2);
  const estimate = contextEstimate(view);
  assert.equal(estimate.tokens, estimateMessageTokens(assistant) + estimateMessageTokens(user));
  assert.equal(estimate.cacheHitRate, undefined);
  assert.equal(contextEstimate(context([])).tokens, 0);
  const zero = { ...assistant, usage: emptyUsage() };
  assert.equal(contextEstimate(context([zero, user])).tokens, estimateMessageTokens(zero) + estimateMessageTokens(user));
  const system: Message = { role: "system", content: "system instructions", timestamp: 1,
    toolsAdded: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} } }] };
  assert.ok(contextEstimate(context([system, user])).tokens > estimateMessageTokens(user));
});

test("projection uses ledger totals without double counting visible messages, tools, retries or partials", () => {
  const s = session(); s.titleUsage = structuredClone(usage);
  const view = { entries: [{ id: 1, model: [assistant] }], docs: {
    "pi.usage": { models: { "test/mock": usage, "test/summary": usage }, tools: { helper: usage } },
    "pi.live": { generation: { message: assistant } },
  } } as unknown as ConversationView;
  applyView(s, view);
  const stats = sessionStats(s, 1000);
  assert.equal(stats.usage?.totalTokens, 2000);
  assert.equal(stats.usage?.cost.total, 0.4);
  applyView(s, view);
  assert.deepEqual(sessionStats(s, 1000), stats, "replayed snapshots must not accumulate usage");
});

test("footer distinguishes pending, unavailable, zero-cost and high context; details explain estimates", () => {
  const settings = { model: { provider: "test", modelId: "mock" }, thinkingLevel: "high" as const };
  assert.equal(stripTerminalSequences(composerStatus(settings, {})), "test/mock · high · ?/? · ◉ ? · cost ?");
  const s = session(); s.usage = emptyUsage(); s.context = { tokens: 950, cacheHitRate: 0 };
  const stats = sessionStats(s, 1000);
  assert.match(composerStatus(settings, stats), /\x1b\[33m███████░ ~95%\/1\.0k/);
  assert.equal(stripTerminalSequences(composerStatus(settings, stats)), "test/mock · high · ███████░ ~95%/1.0k · ◉ 0% · ~$0.000");
  assert.equal(sessionStats(s, 0).contextWindow, undefined);
  assert.match(usageDetails(stats).join("\n"), /not subscription charges/);
  assert.match(usageDetails(stats).join("\n"), /unpriced usage/);
  assert.equal(formatCost(0.000001), "<$0.001");
  assert.equal(formatCost(0), "$0.000");
  assert.equal(formatTokens(500), "500");
  assert.equal(formatTokens(128000), "128k");
});

test("status bars clamp at capacity, distinguish unknown from zero and never invent subscription quota", () => {
  const settings = { model: { provider: "openai-codex", modelId: "gpt-6.1-sol" }, thinkingLevel: "high" as const };
  const recorded = emptyUsage(); recorded.cost.total = 13.37;
  const status = (tokens: number) => composerStatus(settings, { contextWindow: 500_000,
    context: { tokens, cacheHitRate: 99 }, usage: recorded });
  assert.equal(stripTerminalSequences(status(450_000)), "openai-codex/gpt-6.1-sol · high · ███████░ ~90%/500k · ◉ 99% · ~$13.37");
  assert.match(stripTerminalSequences(status(0)), /░░░░░░░░ ~0%\/500k/);
  assert.match(stripTerminalSequences(status(500_000)), /████████ ~100%\/500k/);
  assert.match(stripTerminalSequences(status(600_000)), /████████ ~120%\/500k/);
  assert.match(stripTerminalSequences(composerStatus(settings, { contextWindow: 500_000 })), /\?\/500k · ◉ \? · cost \?/);
  assert.match(stripTerminalSequences(composerStatus({ thinkingLevel: "off" }, {})), /^no model · off/);
  assert.doesNotMatch(stripTerminalSequences(status(450_000)), /↻|86%|shortcuts|\/session/);
});

test("cached usage is backwards compatible, validated and persists without changing the state version", () => {
  const temp = temporary();
  try {
    const store = new Store(temp.root); const s = session(); store.state.sessions.push(s); store.save();
    assert.equal(new Store(temp.root).state.sessions[0]?.usage, undefined);
    s.usage = structuredClone(usage); s.titleUsage = emptyUsage(); s.context = { tokens: 500, cacheHitRate: 50 };
    store.save();
    assert.deepEqual(new Store(temp.root).state.sessions[0], s);
    for (const change of [
      (value: Session) => { value.usage!.input = -1; },
      (value: Session) => { value.titleUsage!.cost.total = NaN; },
      (value: Session) => { value.context!.cacheHitRate = 101; },
    ]) {
      const state = structuredClone(store.state); change(state.sessions[0]!);
      const json = JSON.stringify(state); writeFileSync(store.file, json);
      assert.throws(() => new Store(temp.root), /Invalid zz state/);
    }
  } finally { temp.cleanup(); }
});
