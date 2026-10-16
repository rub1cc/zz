import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createModels, getSupportedThinkingLevels, type Provider } from "@earendil-works/pi-ai/models";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { loadPi, selectPiModel } from "../src/pi.js";
import { temporary } from "./helpers.js";

const noRequests = () => { throw new Error("These tests must not make model requests."); };

function catalog() {
  const models = createModels();
  const base = getBuiltinModel("openai", "gpt-4.1");
  for (const provider of ["key-provider", "subscription"]) {
    models.setProvider({ id: provider, name: provider,
      stream: noRequests, streamSimple: noRequests,
      getModels: () => [{ ...base, id: "model/with/slash", provider }],
      auth: { apiKey: { name: "fixture", check: async () => ({ type: provider === "subscription" ? "oauth" : "api_key" }),
        resolve: async () => ({ auth: {} }) } },
    } as Provider);
  }
  return models;
}

test("uses Pi's saved available model and prefers subscription login when no default is available", async () => {
  const models = catalog();
  assert.deepEqual(await selectPiModel(models, { provider: "subscription", modelId: "model/with/slash" }),
    { provider: "subscription", modelId: "model/with/slash" });
  assert.deepEqual(await selectPiModel(models, {}), { provider: "subscription", modelId: "model/with/slash" });
  assert.deepEqual(await selectPiModel(models, { provider: "missing", modelId: "gone" }),
    { provider: "subscription", modelId: "model/with/slash" });
  assert.deepEqual(await selectPiModel(models, {}, "subscription/model/with/slash"),
    { provider: "subscription", modelId: "model/with/slash" });
  assert.equal(await selectPiModel(createModels(), {}), undefined);
  await assert.rejects(selectPiModel(models, {}, "invalid"), /provider\/model-id/);
});

test("loads existing Pi OAuth credentials and model settings without an API key or token refresh", async () => {
  const temp = temporary();
  try {
    const auth = { openai: { type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 3_600_000 } };
    const authText = JSON.stringify(auth);
    writeFileSync(join(temp.root, "auth.json"), authText);
    // Any model allowed by this subscription is sufficient; no real account is accessed.
    const first = await loadPi(temp.root, undefined, temp.root);
    const available = await first.models.getAvailable("openai");
    assert.ok(available.length > 0);
    const chosen = available.find((m) => getSupportedThinkingLevels(m).includes("high") && getSupportedThinkingLevels(m).includes("low"))!;
    assert.ok(chosen);
    writeFileSync(join(temp.root, "settings.json"), JSON.stringify({ defaultProvider: chosen.provider, defaultModel: chosen.id,
      defaultThinkingLevel: "low", modelThinkingLevels: { [`${chosen.provider}/${chosen.id}`]: "high" } }));
    const loaded = await loadPi(temp.root, undefined, temp.root);
    assert.deepEqual(loaded.model, { provider: chosen.provider, modelId: chosen.id });
    assert.equal((await loaded.models.checkAuth("openai"))?.type, "oauth");
    assert.equal(loaded.thinkingLevel, "high");
    assert.equal((await loadPi(temp.root, undefined, temp.root, "low")).thinkingLevel, "low");
    await assert.rejects(loadPi(temp.root, undefined, temp.root, "invalid"), /Thinking must be/);
    assert.equal(readFileSync(join(temp.root, "auth.json"), "utf8"), authText);
  } finally { temp.cleanup(); }
});

test("Pi runtime refreshes stored OAuth tokens safely and preserves other providers", async () => {
  const temp = temporary();
  try {
    const other = { type: "oauth", access: "other-access", refresh: "other-refresh", expires: Date.now() + 3_600_000 };
    writeFileSync(join(temp.root, "auth.json"), JSON.stringify({
      fixture: { type: "oauth", access: "expired", refresh: "refresh-before", expires: 0 }, other,
    }));
    const { models } = await loadPi(temp.root, undefined, temp.root);
    let refreshes = 0;
    models.registerNativeProvider({ id: "fixture", name: "Fixture", getModels: () => [],
      stream: noRequests, streamSimple: noRequests,
      auth: { oauth: { name: "Fixture subscription", login: async () => { throw new Error("Login must not be needed"); },
        refresh: async () => { refreshes++; return { type: "oauth", access: "fresh", refresh: "refresh-after", expires: Date.now() + 3_600_000 }; },
        toAuth: async (credential) => ({ apiKey: credential.access }),
      } },
    } as Provider);
    await Promise.all([models.getAuth("fixture"), models.getAuth("fixture")]);
    assert.equal(refreshes, 1);
    const stored = JSON.parse(readFileSync(join(temp.root, "auth.json"), "utf8"));
    assert.equal(stored.fixture.refresh, "refresh-after");
    assert.deepEqual(stored.other, other);
  } finally { temp.cleanup(); }
});
