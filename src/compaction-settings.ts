import { DEFAULT_COMPACTION_POLICY, type CompactionPolicy } from "@earendil-works/pi-durable";

export type CompactionTokenField = "reserveTokens" | "keepRecentTokens" | "backgroundTokens";
export const compactionTokenFields: readonly CompactionTokenField[] = ["reserveTokens", "keepRecentTokens", "backgroundTokens"];
export const isCompactionTokenField = (value: string): value is CompactionTokenField => compactionTokenFields.includes(value as CompactionTokenField);

/** Resolve each field explicitly so omitted settings keep the installed SDK's defaults. */
export function compactionPolicy(settings?: Partial<CompactionPolicy>): CompactionPolicy {
  return {
    enabled: settings?.enabled ?? DEFAULT_COMPACTION_POLICY.enabled,
    reserveTokens: settings?.reserveTokens ?? DEFAULT_COMPACTION_POLICY.reserveTokens,
    keepRecentTokens: settings?.keepRecentTokens ?? DEFAULT_COMPACTION_POLICY.keepRecentTokens,
    backgroundTokens: settings?.backgroundTokens ?? DEFAULT_COMPACTION_POLICY.backgroundTokens,
  };
}

export function compactionSettingsError(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "Invalid auto-compaction settings.";
  const settings = value as Partial<CompactionPolicy>;
  if (Object.keys(settings).some((key) => key !== "enabled" && !isCompactionTokenField(key))) return "Unknown auto-compaction setting.";
  if (settings.enabled !== undefined && typeof settings.enabled !== "boolean") return "Auto-compaction must be On or Off.";
  // Summary budgets are floor(0.8 * reserveTokens), so the reserve must leave at least one token.
  for (const field of compactionTokenFields) {
    const tokens = settings[field];
    if (tokens !== undefined && (!Number.isSafeInteger(tokens) || tokens < (field === "reserveTokens" ? 2 : 0))) {
      return field === "reserveTokens" ? "Compaction reserve must be a whole number of at least 2 tokens."
        : "Compaction token values must be nonnegative whole numbers.";
    }
  }
  const policy = compactionPolicy(settings);
  if (!Number.isSafeInteger(policy.reserveTokens + policy.backgroundTokens)) return "Combined reserve and background lead are too large.";
}
