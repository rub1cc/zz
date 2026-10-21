import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model, AssistantMessage } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import { branchDirectory, DEFAULT_WORKTREE_NAMING_INSTRUCTIONS, generateWorktreeName } from "../src/worktree-name.js";
import { emptyUsage } from "../src/usage.js";

const model = {} as Model<Api>;
function runtime(completeSimple: Models["completeSimple"]): Models { return { completeSimple } as Models; }
function response(text: string): AssistantMessage {
  return { role: "assistant", api: "openai-responses", provider: "test", model: "mock", timestamp: 1,
    content: [{ type: "text", text }], stopReason: "stop", usage: emptyUsage() };
}

test("branch generation is tool-free, uses custom instructions and a bounded task prompt, and reports usage", async () => {
  let calls = 0;
  const models = runtime(async (_model, context, options) => {
    calls++;
    assert.match(context.systemPrompt!, /Naming instructions:\nUse feature\/ and include ABC-123/);
    assert.equal(context.messages.length, 1);
    assert.equal(context.messages[0]!.content.length, 4000);
    assert.equal(context.tools, undefined);
    assert.equal(options?.maxTokens, 128);
    return response('"feature/ABC-123-fix-auth"');
  });
  let used = false;
  const name = await generateWorktreeName(models, model, "a".repeat(5000), "Use feature/ and include ABC-123", new AbortController().signal,
    (usage) => { assert.deepEqual(usage, emptyUsage()); used = true; });
  assert.equal(name, "feature/ABC-123-fix-auth");
  assert.equal(calls, 1); assert.equal(used, true);
});

test("invalid, unsafe, overly long and unsuccessful branch responses fall back without hiding recorded usage", async () => {
  for (const text of ["", "../escape", "/absolute", "zz//empty", "zz/foo.lock", "zz/foo\nother", "Here is your branch name", "-bad", "a".repeat(121)]) {
    let used = false;
    const name = await generateWorktreeName(runtime(async () => response(text)), model, "task", DEFAULT_WORKTREE_NAMING_INSTRUCTIONS,
      new AbortController().signal, () => { used = true; });
    assert.equal(name, undefined, text); assert.equal(used, true);
  }
  const failed = runtime(async () => ({ ...response("zz/fix-auth"), stopReason: "error" }));
  assert.equal(await generateWorktreeName(failed, model, "task", "custom", new AbortController().signal), undefined);
  const unavailable = runtime(async () => { throw new Error("auth error"); });
  assert.equal(await generateWorktreeName(unavailable, model, "task", "custom", new AbortController().signal), undefined);
});

test("cancellation returns promptly even when the provider ignores the signal", async () => {
  const abort = new AbortController();
  const pending = generateWorktreeName(runtime(() => new Promise(() => {})), model, "task", "custom", abort.signal);
  abort.abort();
  assert.equal(await pending, undefined);
  const alreadyAborted = runtime(async () => assert.fail("An aborted request must not reach the provider"));
  assert.equal(await generateWorktreeName(alreadyAborted, model, "task", "custom", abort.signal), undefined);
});

test("directory names slugify the entire branch and cannot introduce path components", () => {
  assert.equal(branchDirectory("zz/Fix-Login-a1b2c3d4"), "zz-fix-login-a1b2c3d4");
  assert.equal(branchDirectory("../../feature_name"), "feature-name");
  assert.equal(branchDirectory("..."), "task");
});

test("a provider that never returns cannot delay naming beyond the timeout", { timeout: 6500 }, async () => {
  const keepAlive = setTimeout(() => {}, 6000);
  try {
    assert.equal(await generateWorktreeName(runtime(() => new Promise(() => {})), model, "task", "custom", new AbortController().signal), undefined);
  } finally { clearTimeout(keepAlive); }
});
