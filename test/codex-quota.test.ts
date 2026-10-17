import assert from "node:assert/strict";
import { test } from "node:test";
import type { Models } from "@earendil-works/pi-ai/models";
import { stripTerminalSequences, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { CodexQuota, formatCodexQuota, parseCodexQuota } from "../src/codex-quota.js";
import { Controller } from "../src/controller.js";
import { loadPi } from "../src/pi.js";
import { Store } from "../src/store.js";
import { Dashboard } from "../src/ui.js";
import { composerStatus } from "../src/usage.js";
import { FakeEngine, FakeTerminal, temporary, tick } from "./helpers.js";

const now = 1_800_000_000_000;
const resetAt = now + (4 * 24 + 9) * 3_600_000;
const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.signature`;
const window = (used = 28, reset = resetAt / 1000, seconds = 604800) =>
  ({ used_percent: used, reset_at: reset, limit_window_seconds: seconds });
const payload = () => ({ rate_limit: { primary_window: window(50, resetAt / 1000, 18000), secondary_window: window() } });
const models: Pick<Models, "checkAuth" | "getAuth"> = {
  checkAuth: async () => ({ type: "oauth" }), getAuth: async () => ({ auth: { apiKey: token } }),
};

function fixture(fetcher: typeof fetch = async () => Response.json(payload()), runtime = models) {
  let time = now;
  let changes = 0;
  const monitor = new CodexQuota(runtime, fetcher, () => time);
  monitor.start(() => { changes++; });
  return { monitor, setTime: (value: number) => { time = value; }, get changes() { return changes; } };
}

test("only a valid weekly window supplies remaining percentage and an absolute reset", () => {
  assert.deepEqual(parseCodexQuota(payload()), { remainingPercent: 72, resetAt });
  assert.deepEqual(parseCodexQuota({ rate_limit: { primary_window: window(100) } }), { remainingPercent: 0, resetAt });
  assert.deepEqual(parseCodexQuota({ rate_limit: { secondary_window: window(0) } }), { remainingPercent: 100, resetAt });
  for (const value of [null, [], {}, { rate_limit: null }, { rate_limit: { secondary_window: window(28, resetAt / 1000, 18000) } },
    ...[-1, 101, NaN, Infinity, "28", null].map((used) => ({ rate_limit: { secondary_window: { ...window(), used_percent: used } } })),
    ...[0, -1, NaN, Infinity, "1800000000", null, 9e12].map((reset) => ({ rate_limit: { secondary_window: { ...window(), reset_at: reset } } })),
  ]) assert.equal(parseCodexQuota(value), undefined);
});

test("compact display means weekly remaining, handles sub-day countdowns and never assumes a reset", () => {
  const quota = { remainingPercent: 72, resetAt };
  assert.equal(formatCodexQuota(quota, now), "codex 72% \u21bb 4d9h");
  assert.equal(formatCodexQuota({ ...quota, remainingPercent: 0, resetAt: now + 3_660_000 }, now), "codex 0% \u21bb 1h1m");
  assert.equal(formatCodexQuota({ ...quota, resetAt: now + 1 }, now), "codex 72% \u21bb 1m");
  assert.equal(formatCodexQuota(quota, resetAt), undefined);
  assert.equal(formatCodexQuota(quota, resetAt + 1), undefined);
  const future = { ...quota, resetAt: Date.now() + 3_600_000 };
  for (const provider of ["openai-codex", "openai"]) {
    assert.match(stripTerminalSequences(composerStatus({ model: { provider, modelId: "mock" }, thinkingLevel: "off" }, {}, future)), /codex 72% \u21bb 1h0m$/);
  }
  assert.doesNotMatch(composerStatus({ model: { provider: "test", modelId: "mock" }, thinkingLevel: "off" }, {}, future), /codex 72%/);
});

test("requests use Pi-resolved OAuth and the account header, stay cached across renders and never follow redirects", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  let checks = 0; let resolutions = 0;
  const f = fixture(async (url, init) => { calls.push({ url: String(url), init }); return Response.json(payload()); }, {
    checkAuth: async (provider, options) => { checks++; assert.equal(provider, "openai-codex"); assert.ok(options?.signal); return { type: "oauth" }; },
    getAuth: async (provider: unknown, options?: { signal?: AbortSignal }) => {
      resolutions++; assert.equal(provider, "openai-codex"); assert.ok(options?.signal); return { auth: { apiKey: token } };
    },
  });
  try {
    f.monitor.select("openai-codex");
    assert.equal(f.monitor.value("openai-codex"), undefined, "First render never blocks on the request");
    await tick();
    assert.deepEqual(f.monitor.value("openai-codex"), { remainingPercent: 72, resetAt });
    for (let i = 0; i < 10; i++) { f.monitor.select("openai-codex"); f.monitor.value("openai-codex"); }
    assert.equal(checks, 1); assert.equal(resolutions, 1); assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://chatgpt.com/backend-api/wham/usage");
    assert.equal(calls[0]?.init?.redirect, "error");
    const headers = new Headers(calls[0]?.init?.headers);
    assert.equal(headers.get("Authorization"), `Bearer ${token}`);
    assert.equal(headers.get("ChatGPT-Account-Id"), "fixture-account");
    assert.equal(f.monitor.value("openai"), undefined);
    f.setTime(now + 6 * 60_000);
    assert.equal(f.monitor.value("openai-codex"), undefined, "Stale snapshots are not presented as live data");
  } finally { f.monitor.close(); }
});

test("background polling refreshes at three minutes and drops failed or expired measurements", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const f = fixture(async () => { calls++; return calls === 2 ? new Response("private error", { status: 429 }) : Response.json(payload()); });
  try {
    f.monitor.select("openai-codex"); await tick();
    assert.ok(f.monitor.value("openai-codex"));
    t.mock.timers.tick(179_999); await tick(); assert.equal(calls, 1);
    f.setTime(now + 180_000); t.mock.timers.tick(1); await tick();
    assert.equal(calls, 2); assert.equal(f.monitor.value("openai-codex"), undefined);
    f.setTime(now + 360_000); t.mock.timers.tick(180_000); await tick();
    assert.equal(calls, 3); assert.ok(f.monitor.value("openai-codex"));
    f.setTime(resetAt); assert.equal(f.monitor.value("openai-codex"), undefined);
    f.monitor.close(); t.mock.timers.tick(180_000); await tick(); assert.equal(calls, 3);
  } finally { f.monitor.close(); }
});

test("no API-key, unsupported-provider, missing-account or failed-auth request is sent", async () => {
  for (const runtime of [
    { checkAuth: async () => undefined, getAuth: models.getAuth },
    { checkAuth: async () => ({ type: "api_key" as const }), getAuth: models.getAuth },
    { checkAuth: models.checkAuth, getAuth: async () => undefined },
    { checkAuth: models.checkAuth, getAuth: async () => ({ auth: { apiKey: "invalid" } }) },
    { checkAuth: models.checkAuth, getAuth: async () => ({ auth: { apiKey: `h.${Buffer.from("{}").toString("base64url")}.s` } }) },
    { checkAuth: models.checkAuth, getAuth: async () => { throw new Error("secret refresh error"); } },
  ]) {
    let calls = 0;
    const f = fixture(async () => { calls++; throw new Error("Must not fetch"); }, runtime);
    try {
      f.monitor.select("anthropic"); await tick(); assert.equal(calls, 0);
      f.monitor.select("openai-codex"); await tick();
      assert.equal(calls, 0); assert.equal(f.monitor.value("openai-codex"), undefined);
    } finally { f.monitor.close(); }
  }
});

test("network/JSON errors quietly omit quota rather than displaying a made-up zero", async () => {
  for (const fetcher of [
    async () => { throw new Error("private network error"); },
    async () => new Response("not json"),
    async () => Response.json({}),
  ]) {
    const f = fixture(fetcher);
    try { f.monitor.select("openai-codex"); await tick(); assert.equal(f.monitor.value("openai-codex"), undefined); }
    finally { f.monitor.close(); }
  }
});

test("provider changes, invalidation and shutdown abort requests and ignore late results", async () => {
  const pending: { resolve(response: Response): void; signal: AbortSignal }[] = [];
  const f = fixture(async (_url, init) => new Promise<Response>((resolve) => { pending.push({ resolve, signal: init!.signal! }); }));
  try {
    f.monitor.select("openai-codex"); await tick();
    f.monitor.select("openai"); await tick();
    assert.equal(pending[0]?.signal.aborted, true);
    pending[0]?.resolve(Response.json(payload())); await tick();
    assert.equal(f.monitor.value("openai"), undefined);
    pending[1]?.resolve(Response.json(payload())); await tick();
    assert.ok(f.monitor.value("openai"));
    f.monitor.invalidate("openai-codex"); assert.ok(f.monitor.value("openai"), "Unrelated login does not invalidate this account");
    f.monitor.invalidate("openai"); await tick();
    assert.equal(f.monitor.value("openai"), undefined);
    f.monitor.close(); const changes = f.changes;
    assert.equal(pending[2]?.signal.aborted, true);
    pending[2]?.resolve(Response.json(payload())); await tick();
    assert.equal(f.changes, changes); assert.equal(f.monitor.value("openai"), undefined);
  } finally { f.monitor.close(); }
});

test("dashboard, session and peek use the active subscription quota; other providers omit it", async () => {
  const temp = temporary();
  const loaded = await loadPi(temp.root, undefined, temp.root);
  const store = new Store(temp.root); store.addProject(temp.root);
  const engine = new FakeEngine();
  engine.defaults.model = { provider: "openai-codex", modelId: "mock" };
  const monitor = new CodexQuota(models, async () => Response.json({ rate_limit: { secondary_window: window(28, Math.ceil(Date.now() / 1000) + (4 * 24 + 9) * 3600) } }));
  const controller = new Controller(store, engine, { ...loaded.auth, codexQuota: monitor });
  const terminal = new FakeTerminal();
  const tui = new TuiAltScreen(terminal, false);
  const app = new Dashboard(controller, tui, () => {});
  tui.setLayoutRoot(app); tui.setFocus(app); tui.start(); app.sync();
  const screen = () => { tui.renderNow(); return tui.getScreenLines().map(stripTerminalSequences).join("\n"); };
  try {
    await tick(); assert.match(screen(), /codex 72% \u21bb 4d9h/);
    assert.equal(engine.calls.length, 0, "Quota polling sends no model prompt");
    controller.send("task"); await tick(); controller.open();
    assert.match(screen(), /codex 72% \u21bb 4d9h/);
    for (const width of [12, 24, 80, 120]) assert.ok(app.render(width).every((line) => visibleWidth(line) <= width));
    controller.back(); engine.defaults.model = { provider: "test", modelId: "mock" }; controller.changed();
    assert.doesNotMatch(screen(), /codex 72%/);
    controller.select(`session:${store.state.sessions[0]!.id}`); controller.peek(); await tick();
    assert.match(screen(), /codex 72% \u21bb 4d9h/);
    controller.dialog = undefined; controller.changed(); assert.doesNotMatch(screen(), /codex 72%/);
    assert.equal(engine.calls.length, 1);
  } finally { app.dispose(); await controller.close(); tui.stop(); temp.cleanup(); }
});
