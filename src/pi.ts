import { join } from "node:path";
import { getAgentDir, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { Models } from "@earendil-works/pi-ai/models";
import type { ModelRef } from "@earendil-works/pi-durable";
import { clampThinkingLevel } from "@earendil-works/pi-ai/models";
import type { AuthAccess } from "./auth.js";
import { isThinkingLevel } from "./model.js";

export async function selectPiModel(
  models: Models,
  defaults: { provider?: string; modelId?: string },
  override?: string,
): Promise<ModelRef | undefined> {
  if (override !== undefined) {
    const separator = override.indexOf("/");
    if (separator < 1 || separator === override.length - 1) throw new Error("Use --model provider/model-id.");
    const model = { provider: override.slice(0, separator), modelId: override.slice(separator + 1) };
    if (!models.getModel(model.provider, model.modelId)) throw new Error(`Pi does not know model ${override}. Choose a model configured in Pi.`);
    return model;
  }

  const available = await models.getAvailable();
  const saved = available.find((m) => m.provider === defaults.provider && m.id === defaults.modelId);
  if (saved) return { provider: saved.provider, modelId: saved.id };
  // Prefer a logged-in subscription over ambient API keys when Pi has no usable default.
  const checks = new Map(await Promise.all([...new Set(available.map((m) => m.provider))]
    .map(async (provider) => [provider, await models.checkAuth(provider)] as const)));
  const fallback = available.find((m) => checks.get(m.provider)?.type === "oauth") ?? available[0];
  return fallback ? { provider: fallback.provider, modelId: fallback.id } : undefined;
}

export async function loadPi(cwd: string, override?: string, agentDir = getAgentDir(), thinkingOverride?: string) {
  const models = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    allowModelNetwork: false,
  });
  const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const errors = settings.drainErrors();
  if (errors.length) throw errors[0]!.error;
  const model = await selectPiModel(models, {
    provider: settings.getDefaultProvider(), modelId: settings.getDefaultModel(),
  }, override);
  const preferred = thinkingOverride ?? (model && settings.getModelThinkingLevel(model.provider, model.modelId))
    ?? settings.getDefaultThinkingLevel() ?? "medium";
  if (!isThinkingLevel(preferred)) throw new Error("Thinking must be off, minimal, low, medium, high, xhigh, or max.");
  const catalogModel = model && models.getModel(model.provider, model.modelId);
  const thinkingLevel = catalogModel ? clampThinkingLevel(catalogModel, preferred) : preferred;
  const auth: AuthAccess = { runtime: models, options: { getDeviceId: () => settings.getOrCreateDeviceId(), agentName: "zz" } };
  return { models, model, thinkingLevel, auth };
}
