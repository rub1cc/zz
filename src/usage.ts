import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { calculateContextTokens, estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { ContextView, UsageState } from "@earendil-works/pi-durable";
import type { AgentSettings, ContextEstimate, Session, SessionStats } from "./model.js";
import { accent, dim, oneLine, warning } from "./format.js";
import { formatCodexQuota, type CodexWeeklyQuota } from "./codex-quota.js";

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

export function sumUsage(usages: readonly Usage[]): Usage {
  const total = emptyUsage();
  for (const usage of usages) {
    for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
      total[key] += usage[key];
      total.cost[key] += usage.cost[key];
    }
    total.totalTokens += usage.totalTokens;
    total.cost.total += usage.cost.total;
  }
  return total;
}

/** Use the durable ledger, not active messages: retries and compacted-away spend still count. */
export function conversationUsage(ledger?: UsageState): Usage {
  return sumUsage(ledger ? [...Object.values(ledger.models), ...Object.values(ledger.tools)] : []);
}

/** Match the durable harness's estimate, using its derived context (edits and excluded responses applied). */
export function contextEstimate(view: ContextView): ContextEstimate {
  let measured: AssistantMessage | undefined;
  const head = view.head?.id ?? -Infinity;
  for (let index = view.entries.length - 1; index >= 0 && !measured; index--) {
    if (view.entries[index]!.id <= head) continue;
    measured = view.contributions[index]!.findLast((message): message is AssistantMessage =>
      message.role === "assistant" && calculateContextTokens(message.usage) > 0);
  }
  const from = measured ? view.messages.lastIndexOf(measured) + 1 : 0;
  let tokens = measured ? calculateContextTokens(measured.usage) : 0;
  for (const message of view.messages.slice(from)) tokens += estimateMessageTokens(message);
  const prompt = measured ? measured.usage.input + measured.usage.cacheRead + measured.usage.cacheWrite : 0;
  return { tokens, cacheHitRate: prompt > 0 ? measured!.usage.cacheRead / prompt * 100 : undefined };
}

export function sessionStats(session: Session, contextWindow?: number): SessionStats {
  return {
    usage: session.usage || session.titleUsage ? sumUsage([session.usage, session.titleUsage].filter((u): u is Usage => !!u)) : undefined,
    titleUsage: session.titleUsage,
    context: session.context,
    contextWindow: contextWindow && contextWindow > 0 ? contextWindow : undefined,
  };
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(Math.round(count));
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

export function formatCost(cost: number): string {
  return cost > 0 && cost < 0.001 ? "<$0.001" : `$${cost.toFixed(3)}`;
}

/** One quiet status row; unknown measurements stay unknown, never fake zeroes or quota. */
export function composerStatus(settings: AgentSettings, stats: SessionStats, quota?: CodexWeeklyQuota): string {
  const { context, contextWindow, usage } = stats;
  const percent = context && contextWindow ? context.tokens / contextWindow * 100 : undefined;
  const filled = percent === undefined ? 0 : Math.max(0, Math.min(8, Math.floor(percent / 100 * 8)));
  const bar = percent === undefined ? "" : `${"█".repeat(filled)}${"░".repeat(8 - filled)} `;
  const contextText = `${bar}${percent === undefined ? "?" : `~${Math.round(percent)}%`}/${contextWindow ? formatTokens(contextWindow) : "?"}`;
  const model = settings.model ? `${settings.model.provider}/${settings.model.modelId}` : "no model";
  const cost = usage && (usage.cost.total >= 1 ? `$${usage.cost.total.toFixed(2)}` : formatCost(usage.cost.total));
  const quotaText = quota && (settings.model?.provider === "openai-codex" || settings.model?.provider === "openai")
    ? formatCodexQuota(quota) : undefined;
  return [
    dim(oneLine(model)), accent(settings.thinkingLevel),
    percent !== undefined && percent > 70 ? warning(contextText) : dim(contextText),
    dim(`◉ ${context?.cacheHitRate === undefined ? "?" : `${Math.round(context.cacheHitRate)}%`}`),
    dim(cost ? `~${cost}` : "cost ?"),
    ...(quotaText ? [dim(quotaText)] : []),
  ].join(dim(" · "));
}

export function usageDetails(stats: SessionStats): string[] {
  const { context, contextWindow, usage, titleUsage } = stats;
  const contextText = context ? `~${Math.round(context.tokens).toLocaleString("en-US")} tokens` : "unknown until context loads";
  const windowText = contextWindow ? `${formatTokens(contextWindow)} tokens` : "unknown (model unavailable)";
  const lines = [`Context         ${contextText}`, `Context window  ${windowText}`];
  if (context && contextWindow) lines.push(`Context used    ~${(context.tokens / contextWindow * 100).toFixed(1)}%`);
  lines.push("");
  if (usage) {
    const number = (n: number) => Math.round(n).toLocaleString("en-US");
    lines.push(`Input           ${number(usage.input)}`, `Output          ${number(usage.output)}`,
      `Cache read      ${number(usage.cacheRead)}`, `Cache write     ${number(usage.cacheWrite)}`,
      `Total tokens    ${number(usage.totalTokens)}`, `Estimated cost  ${formatCost(usage.cost.total)}`);
    if (context?.cacheHitRate !== undefined) lines.push(`Last cache hit  ${context.cacheHitRate.toFixed(1)}% (conversation prompt)`);
    if (titleUsage) lines.push(`Title included  ${number(titleUsage.totalTokens)} tokens / ${formatCost(titleUsage.cost.total)}`);
  } else lines.push("Usage not available yet.");
  return [...lines, "", "Totals include recorded conversation, tool and title usage.",
    "Context excludes title requests and unsent drafts; not a token limit guarantee.",
    "USD estimates use provider/catalog rates, not subscription charges.",
    "Zero cost may mean unpriced usage. In-flight/unreported spend is not included."];
}
