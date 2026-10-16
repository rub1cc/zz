import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Provider } from "@earendil-works/pi-ai/models";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { CredentialSynchronizationError } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { AuthFlow } from "../src/auth.js";
import { AuthDialog, browserUrl } from "../src/auth-dialog.js";
import { Controller } from "../src/controller.js";
import { loadPi } from "../src/pi.js";
import { Store } from "../src/store.js";
import { Dashboard } from "../src/ui.js";
import { FakeEngine, FakeTerminal, temporary, tick } from "./helpers.js";

const oauthCredential = { type: "oauth" as const, access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 3_600_000 };
const noRequests = () => { throw new Error("No model requests allowed in authentication tests."); };

async function fixture() {
  const temp = temporary();
  const loaded = await loadPi(temp.root, undefined, temp.root);
  const provider: Provider = {
    id: "fixture", name: "Fixture", getModels: () => [{ ...getBuiltinModel("openai", "gpt-4.1"), provider: "fixture", id: "mock" }],
    stream: noRequests, streamSimple: noRequests,
    auth: {
      apiKey: { name: "Fixture key", login: async (interaction) => ({ type: "api_key", key: await interaction.prompt({ type: "secret", message: "API key" }) }),
        check: async ({ credential }) => credential?.key ? { type: "api_key", source: "stored" } : undefined,
        resolve: async ({ credential }) => credential?.key ? { auth: { apiKey: credential.key } } : undefined },
      oauth: { name: "Fixture account", isSubscription: true,
        login: async () => oauthCredential, refresh: async () => oauthCredential, toAuth: async (credential) => ({ apiKey: credential.access }) },
    },
  } as Provider;
  loaded.models.registerNativeProvider(provider);
  return { ...temp, ...loaded, provider };
}

function dialog(flow: AuthFlow, rows = 32) {
  const terminal = new FakeTerminal(); terminal.rows = rows;
  const tui = new TuiAltScreen(terminal, false);
  const closed: boolean[] = [];
  const opened: string[] = [];
  const copied: string[] = [];
  const component = new AuthDialog(flow, tui, () => { closed.push(true); flow.dispose(); },
    (url) => { opened.push(url); }, async (url) => { copied.push(url); });
  component.focused = true;
  const text = (width = 80) => component.render(width).map(stripTerminalSequences).join("\n");
  return { component, text, terminal, tui, closed, opened, copied };
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 5)); }
  assert.ok(predicate(), "Timed out waiting for authentication state");
}

test("API-key login persists through Pi's store, refreshes models, masks input, and leaves conversation storage untouched", async (t) => {
  const f = await fixture();
  try {
    const other = { type: "api_key", key: "other-key" };
    writeFileSync(join(f.root, "auth.json"), JSON.stringify({ other }));
    const refresh = f.models.refresh.bind(f.models);
    const calls: Parameters<typeof refresh>[0][] = [];
    t.mock.method(f.models, "refresh", async (options: Parameters<typeof refresh>[0]) => { calls.push(options); return refresh(options); });
    const completed: string[] = [];
    const flow = new AuthFlow("login", f.auth, () => {}, async (providerId) => { completed.push(providerId); });
    await flow.start("fixture");
    assert.equal(flow.phase, "choose");
    assert.equal(flow.choices.length, 2);
    const running = flow.choose("fixture:api_key");
    await waitFor(() => !!flow.prompt);
    const d = dialog(flow);
    d.component.handleInput("test-secret-key");
    assert.match(d.text(), /\*{15}/);
    assert.doesNotMatch(d.text(), /test-secret-key/);
    for (const width of [12, 24, 80]) assert.ok(d.component.render(width).every((line) => visibleWidth(line) <= width));
    d.component.handleInput("\r");
    await running;
    assert.equal(flow.phase, "done");
    assert.deepEqual(completed, ["fixture"]);
    const stored = JSON.parse(readFileSync(join(f.root, "auth.json"), "utf8"));
    assert.deepEqual(stored.fixture, { type: "api_key", key: "test-secret-key" });
    assert.deepEqual(stored.other, other);
    assert.ok(calls.some((options) => options?.allowNetwork === true && options.providers?.[0] === "fixture"));
    assert.ok((await f.models.getAvailable("fixture")).some((model) => model.id === "mock"));
    assert.doesNotMatch(d.text(), /test-secret-key/);
    flow.dispose();
  } finally { f.cleanup(); }
});

test("OAuth delegates select/text/manual-code and device events, uses a stable Pi device id, and supports URL actions", async () => {
  const f = await fixture();
  try {
    const deviceIds: string[] = [];
    f.provider.auth.oauth!.login = async (interaction, options) => {
      deviceIds.push(options!.getDeviceId!());
      assert.equal(options?.agentName, "zz");
      assert.equal(await interaction.prompt({ type: "select", message: "Sign-in method", options: [{ id: "device", label: "Copy code" }, { id: "browser", label: "Browser" }] }), "device");
      interaction.notify({ type: "auth_url", url: "https://example.test/login?state=fixture", instructions: "Authorize in your browser" });
      interaction.notify({ type: "device_code", userCode: "ABCD-EFGH", verificationUri: "https://example.test/device" });
      interaction.notify({ type: "progress", message: "Waiting for approval" });
      interaction.notify({ type: "info", message: "Headless login supported", links: [{ label: "Help", url: "https://example.test/help" }] });
      assert.equal(await interaction.prompt({ type: "text", message: "Account" }), "my-account");
      assert.equal(await interaction.prompt({ type: "manual_code", message: "Paste callback" }), "callback-code");
      return oauthCredential;
    };
    const flow = new AuthFlow("login", f.auth, () => {});
    await flow.start("Fixture");
    const running = flow.choose("fixture:oauth");
    await waitFor(() => flow.prompt?.type === "select");
    const d = dialog(flow);
    d.component.handleInput("\r");
    await waitFor(() => flow.prompt?.type === "text");
    assert.match(d.text(), /ABCD-EFGH/);
    assert.match(d.text(), /Waiting for approval/);
    d.component.handleInput("\x0f");
    d.component.handleInput("\x18"); await tick();
    assert.deepEqual(d.opened, ["https://example.test/device"]);
    assert.deepEqual(d.copied, d.opened);
    d.component.handleInput("my-account"); d.component.handleInput("\r");
    await waitFor(() => flow.prompt?.type === "manual_code");
    d.component.handleInput("callback-code"); d.component.handleInput("\r");
    await running;
    assert.equal(flow.phase, "done");
    assert.doesNotMatch(d.text(), /callback-code|my-account/);
    assert.deepEqual(JSON.parse(readFileSync(join(f.root, "auth.json"), "utf8")).fixture, oauthCredential);
    const reloaded = await loadPi(f.root, undefined, f.root);
    assert.equal(reloaded.auth.options!.getDeviceId!(), deviceIds[0]);
    assert.ok(deviceIds[0]);
    flow.dispose();
  } finally { f.cleanup(); }
});

test("logout requires confirmation, removes unknown stored providers too, and preserves other credentials", async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.root, "auth.json"), JSON.stringify({ oldExtension: { type: "api_key", key: "old" }, other: oauthCredential }));
    const flow = new AuthFlow("logout", f.auth, () => {});
    await flow.start("oldExtension");
    assert.equal(flow.phase, "confirm");
    assert.ok(JSON.parse(readFileSync(join(f.root, "auth.json"), "utf8")).oldExtension);
    const d = dialog(flow);
    assert.match(d.text(), /both zz and Pi/);
    assert.match(d.text(), /does not revoke/);
    d.component.handleInput("\r");
    await waitFor(() => flow.phase === "done");
    assert.deepEqual(JSON.parse(readFileSync(join(f.root, "auth.json"), "utf8")), { other: oauthCredential });
    flow.dispose();
  } finally { f.cleanup(); }
});

test("Escape cancels a pending login, closes the prompt, and prevents credential writes or late UI updates", async () => {
  const f = await fixture();
  try {
    let changes = 0;
    const flow = new AuthFlow("login", f.auth, () => { changes++; });
    await flow.start("fixture");
    const running = flow.choose("fixture:api_key");
    await waitFor(() => !!flow.prompt);
    const d = dialog(flow);
    d.component.handleInput("do-not-save");
    d.component.handleInput("\x1b");
    const count = changes;
    await running;
    assert.equal(flow.disposed, true);
    assert.equal(flow.prompt, undefined);
    assert.equal(changes, count);
    assert.deepEqual(await f.models.listCredentials(), []);
    assert.equal(d.closed.length, 1);
    assert.doesNotMatch(d.text(), /do-not-save/);
  } finally { f.cleanup(); }
});

test("out-of-band prompt cancellation clears the old input and allows a later prompt", async () => {
  const f = await fixture();
  try {
    const promptAbort = new AbortController();
    f.provider.auth.oauth!.login = async (interaction) => {
      await assert.rejects(interaction.prompt({ type: "manual_code", message: "Callback or code", signal: promptAbort.signal }), /cancelled/);
      assert.equal(await interaction.prompt({ type: "secret", message: "Second step" }), "new-secret");
      return oauthCredential;
    };
    const flow = new AuthFlow("login", f.auth, () => {});
    await flow.start("fixture");
    const running = flow.choose("fixture:oauth");
    await waitFor(() => flow.prompt?.type === "manual_code");
    const d = dialog(flow);
    d.component.handleInput("stale-code");
    promptAbort.abort();
    await waitFor(() => flow.prompt?.type === "secret");
    assert.doesNotMatch(d.text(), /stale-code/);
    d.component.handleInput("new-secret"); d.component.handleInput("\r");
    await running;
    assert.equal(flow.phase, "done");
    flow.dispose();
  } finally { f.cleanup(); }
});

test("provider failures redact submitted values, persistence failures are not reported as successful logins", async (t) => {
  const f = await fixture();
  try {
    f.provider.auth.apiKey!.login = async (interaction) => {
      const value = await interaction.prompt({ type: "secret", message: "Key" });
      throw new Error(`Rejected key ${value}`);
    };
    const flow = new AuthFlow("login", f.auth, () => {});
    await flow.start("fixture");
    const running = flow.choose("fixture:api_key");
    await waitFor(() => !!flow.prompt);
    flow.submit("sensitive-key"); await running;
    assert.equal(flow.phase, "error");
    assert.match(flow.messages.join(), /\[redacted\]/);
    assert.doesNotMatch(dialog(flow).text(), /sensitive-key/);
    assert.deepEqual(await f.models.listCredentials(), []);
    flow.dispose();
    t.mock.method(f.models, "login", async () => { throw new Error("auth.json is locked"); });
    const failed = new AuthFlow("login", f.auth, () => {});
    await failed.start("fixture"); await failed.choose("fixture:api_key");
    assert.equal(failed.phase, "error");
    assert.match(failed.messages.join(), /auth.json is locked/);
    assert.doesNotMatch(failed.messages.join(), /Credentials saved/);
    failed.dispose();
  } finally { f.cleanup(); }
});

test("catalog refresh failure does not undo a successful login; synchronization errors distinguish committed credentials", async (t) => {
  const f = await fixture();
  try {
    t.mock.method(f.models, "refresh", async () => ({ aborted: false, errors: new Map([["fixture", new Error("offline")]]) }));
    const flow = new AuthFlow("login", f.auth, () => {});
    await flow.start("fixture"); await flow.choose("fixture:oauth");
    assert.equal(flow.phase, "done");
    assert.match(flow.messages.join(), /Credentials saved/);
    assert.match(flow.messages.join(), /using cached models/);
    assert.ok((await f.models.listCredentials()).some((info) => info.providerId === "fixture"));
    flow.dispose();
    t.mock.method(f.models, "logout", async () => { throw new CredentialSynchronizationError("fixture", "logout", undefined, { cause: new Error("snapshot") }); });
    const logout = new AuthFlow("logout", f.auth, () => {});
    await logout.start("fixture"); await logout.confirm();
    assert.equal(logout.phase, "error");
    assert.match(logout.messages.join(), /Credentials removed.*could not be synchronized/);
    logout.dispose();
  } finally { f.cleanup(); }
});

test("empty logout, unknown providers, external setup, and configured status are explicit", async () => {
  const f = await fixture();
  try {
    const empty = new AuthFlow("logout", f.auth, () => {}); await empty.start();
    assert.match(empty.messages.join(), /No stored credentials/); empty.dispose();
    const unknown = new AuthFlow("login", f.auth, () => {}); await unknown.start("not-a-provider");
    assert.equal(unknown.phase, "error"); assert.match(unknown.messages.join(), /No login methods/); unknown.dispose();
    f.provider.auth.apiKey!.login = undefined;
    const ambient = new AuthFlow("login", f.auth, () => {}); await ambient.start("fixture"); await ambient.choose("fixture:api_key");
    assert.equal(ambient.phase, "done"); assert.match(ambient.messages.join(), /outside zz/); ambient.dispose();
    const login = new AuthFlow("login", f.auth, () => {}); await login.start("fixture"); await login.choose("fixture:oauth"); login.dispose();
    const configured = new AuthFlow("login", f.auth, () => {}); await configured.start("fixture");
    assert.ok(configured.choices.every((choice) => choice.status.startsWith("account:"))); configured.dispose();
  } finally { f.cleanup(); }
});

test("auth commands work in dashboard and session without becoming model prompts; shutdown cancels auth", async () => {
  const f = await fixture();
  const store = new Store(join(f.root, "data")); store.addProject(f.root);
  const engine = new FakeEngine(); engine.defaults = { thinkingLevel: "off" };
  engine.listModels = async () => [{ provider: "fixture", modelId: "mock", name: "Mock", thinkingLevels: ["off"] }];
  const c = new Controller(store, engine, f.auth);
  const terminal = new FakeTerminal(); const tui = new TuiAltScreen(terminal, false);
  const app = new Dashboard(c, tui, () => {});
  tui.setLayoutRoot(app); tui.setFocus(app); tui.start(); app.sync();
  try {
    app.composer.setValue("/login fixture"); terminal.onInput("\r");
    assert.equal(c.dialog?.kind, "auth");
    let flow = c.dialog.kind === "auth" ? c.dialog.flow : undefined;
    assert.ok(flow); await waitFor(() => flow!.phase === "choose");
    await flow.choose("fixture:oauth");
    assert.deepEqual(engine.configuration().model, { provider: "fixture", modelId: "mock" });
    assert.match(flow.messages.join(), /New tasks use fixture\/mock/);
    assert.equal(engine.calls.length, 0); assert.equal(store.state.sessions.length, 0);
    terminal.onInput("\r"); assert.equal(c.dialog, undefined);
    c.send("real task"); await tick(); c.open();
    app.composer.setValue("/logout fixture"); terminal.onInput("\r");
    flow = (c as Controller).dialog?.kind === "auth" ? ((c as Controller).dialog as { flow: AuthFlow }).flow : undefined;
    assert.ok(flow); await waitFor(() => flow!.phase === "confirm");
    terminal.onInput("\x1b"); assert.equal(c.dialog, undefined);
    assert.ok((await f.models.listCredentials()).some((info) => info.providerId === "fixture"));
    app.composer.setValue("/login fixture"); terminal.onInput("\r");
    flow = (c as Controller).dialog?.kind === "auth" ? ((c as Controller).dialog as { flow: AuthFlow }).flow : undefined;
    assert.ok(flow); await waitFor(() => flow!.phase === "choose");
    const running = flow.choose("fixture:api_key"); await waitFor(() => !!flow!.prompt);
    assert.equal(engine.calls.length, 1);
    assert.doesNotMatch(readFileSync(join(store.root, "state.json"), "utf8"), /fixture-access|fixture-refresh/);
    await c.close(); await running;
    assert.equal(flow.disposed, true);
  } finally { await c.close(); tui.stop(); f.cleanup(); }
});

test("provider filtering selects the intended method and cancellation leaves credentials untouched", async () => {
  const f = await fixture();
  try {
    const flow = new AuthFlow("login", f.auth, () => {}); await flow.start();
    const d = dialog(flow);
    d.component.handleInput("Fixture");
    assert.match(d.text(), /Fixture/);
    assert.doesNotMatch(d.text(), /Anthropic/);
    d.component.handleInput("\r");
    await waitFor(() => flow.prompt?.type === "secret");
    assert.equal(flow.selected?.id, "fixture:api_key");
    d.component.handleInput("\x1b");
    await tick();
    assert.deepEqual(await f.models.listCredentials(), []);
  } finally { f.cleanup(); }
});

test("narrow and resized dialogs retain prompts and scroll long confirmations and selection lists", async () => {
  const f = await fixture();
  try {
    f.provider.auth.oauth!.login = async (interaction) => {
      interaction.notify({ type: "auth_url", url: `https://example.test/${"long/".repeat(30)}` });
      interaction.notify({ type: "progress", message: "Waiting ".repeat(20) });
      const selected = await interaction.prompt({ type: "select", message: "Choose account", options: Array.from({ length: 8 }, (_, id) => ({ id: String(id), label: `Account ${id}` })) });
      assert.equal(selected, "7");
      return oauthCredential;
    };
    const flow = new AuthFlow("login", f.auth, () => {}); await flow.start("fixture");
    const running = flow.choose("fixture:oauth"); await waitFor(() => flow.prompt?.type === "select");
    const d = dialog(flow);
    for (const rows of [18, 24, 32]) {
      d.terminal.rows = rows;
      for (const width of [18, 40, 80]) {
        const rendered = d.component.render(width);
        assert.ok(rendered.length <= Math.floor(rows * 0.85), `${width}x${rows}: ${rendered.length} lines`);
        assert.ok(rendered.every((line) => visibleWidth(line) <= width));
        assert.match(rendered.map(stripTerminalSequences).join("\n"), /Choose account/);
      }
    }
    for (let i = 0; i < 7; i++) d.component.handleInput("\x1b[B");
    assert.match(d.text(), /Account 7/);
    d.component.handleInput("\r"); await running;
    flow.dispose();
    const logout = new AuthFlow("logout", f.auth, () => {}); await logout.start("fixture");
    const confirmation = dialog(logout, 18);
    assert.ok(confirmation.component.render(18).length <= Math.floor(18 * 0.85));
    const initial = confirmation.text(18);
    confirmation.component.handleInput("\x1b[6~");
    assert.notEqual(confirmation.text(18), initial);
    logout.dispose();
  } finally { f.cleanup(); }
});

test("logout leaves ambient authentication available instead of promising the provider is disconnected", async () => {
  const f = await fixture();
  const previous = process.env.ZZ_TEST_AUTH_KEY;
  try {
    process.env.ZZ_TEST_AUTH_KEY = "ambient-key";
    f.provider.auth.apiKey!.check = async ({ ctx, credential }) => credential?.key || await ctx.env("ZZ_TEST_AUTH_KEY") ? { type: "api_key", source: "ZZ_TEST_AUTH_KEY" } : undefined;
    f.provider.auth.apiKey!.resolve = async ({ ctx, credential }) => ({ auth: { apiKey: credential?.key ?? await ctx.env("ZZ_TEST_AUTH_KEY") } });
    writeFileSync(join(f.root, "auth.json"), JSON.stringify({ fixture: { type: "api_key", key: "stored-key" } }));
    const flow = new AuthFlow("logout", f.auth, () => {}); await flow.start("fixture"); await flow.confirm();
    assert.equal(flow.phase, "done");
    assert.deepEqual(await f.models.listCredentials(), []);
    assert.equal((await f.models.getAuth("fixture"))?.auth.apiKey, "ambient-key");
    assert.match(flow.messages.join(), /Environment variables and models.json are unchanged/);
    flow.dispose();
  } finally {
    if (previous === undefined) delete process.env.ZZ_TEST_AUTH_KEY; else process.env.ZZ_TEST_AUTH_KEY = previous;
    f.cleanup();
  }
});

test("closing during a catalog refresh suppresses late selection updates without undoing committed credentials", async (t) => {
  const f = await fixture();
  try {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    t.mock.method(f.models, "refresh", async () => { await pending; return { aborted: false, errors: new Map() }; });
    let completed = false;
    const flow = new AuthFlow("login", f.auth, () => {}, async () => { completed = true; });
    await flow.start("fixture");
    const running = flow.choose("fixture:oauth");
    await waitFor(() => flow.progress === "Refreshing model catalog...");
    flow.dispose(); finish(); await running;
    assert.equal(completed, false);
    assert.ok((await f.models.listCredentials()).some((info) => info.providerId === "fixture"));
  } finally { f.cleanup(); }
});

test("unsafe URL protocols and terminal control sequences cannot be launched", () => {
  for (const url of [undefined, "file:///etc/passwd", "javascript:alert(1)", "https://example.test/\x1b]bad", "https://example.test/a b", "https://example.test/\x9dunsafe", "--help"]) assert.equal(browserUrl(url), undefined);
  assert.equal(browserUrl("https://example.test/login?one=1&two=2"), "https://example.test/login?one=1&two=2");
});
