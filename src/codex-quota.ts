import type { Models } from "@earendil-works/pi-ai/models";

const REFRESH_MS = 3 * 60_000;
const WEEK_SECONDS = 7 * 24 * 60 * 60;
const supported = (provider?: string) => provider === "openai-codex" || provider === "openai";
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export interface CodexWeeklyQuota { remainingPercent: number; resetAt: number }

export function parseCodexQuota(payload: unknown): CodexWeeklyQuota | undefined {
  const limits = record(record(payload)?.rate_limit);
  for (const candidate of [limits?.primary_window, limits?.secondary_window]) {
    const window = record(candidate);
    if (window?.limit_window_seconds !== WEEK_SECONDS) continue;
    const used = window.used_percent;
    const reset = window.reset_at;
    if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 100
      || typeof reset !== "number" || !Number.isFinite(reset) || reset <= 0 || reset > 8.64e12) continue;
    return { remainingPercent: 100 - used, resetAt: reset * 1000 };
  }
  return undefined;
}

export function formatCodexQuota(quota: CodexWeeklyQuota, now = Date.now()): string | undefined {
  if (quota.resetAt <= now) return undefined;
  const minutes = Math.ceil((quota.resetAt - now) / 60_000);
  const hours = Math.floor(minutes / 60);
  const time = hours >= 24 ? `${Math.floor(hours / 24)}d${hours % 24}h`
    : hours > 0 ? `${hours}h${minutes % 60}m` : `${minutes}m`;
  return `codex ${Math.round(quota.remainingPercent)}% \u21bb ${time}`;
}

/** Account-level data only: no session ledger estimates, persisted tokens, or alternate endpoints. */
export class CodexQuota {
  private provider?: string;
  private quota?: CodexWeeklyQuota;
  private fetchedAt = 0;
  private request?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private changed?: () => void;
  private closed = false;

  constructor(private readonly models: Pick<Models, "checkAuth" | "getAuth">,
    private readonly fetcher: typeof fetch = fetch, private readonly now = Date.now) {}

  start(changed: () => void): void { this.changed = changed; }

  select(provider?: string): void {
    const next = supported(provider) ? provider : undefined;
    if (this.closed || next === this.provider) return;
    this.provider = next;
    this.invalidate();
  }

  value(provider?: string): CodexWeeklyQuota | undefined {
    if (this.closed || provider !== this.provider || !this.quota
      || this.now() - this.fetchedAt >= REFRESH_MS * 2 || this.quota.resetAt <= this.now()) return undefined;
    return this.quota;
  }

  invalidate(provider = this.provider): void {
    if (this.closed || provider !== this.provider) return;
    this.request?.abort();
    this.request = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.quota = undefined;
    this.changed?.();
    if (this.provider && this.changed) void this.refresh(this.provider);
  }

  private async refresh(provider: string): Promise<void> {
    const request = new AbortController();
    this.request = request;
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]);
    let quota: CodexWeeklyQuota | undefined;
    try {
      if ((await this.models.checkAuth(provider, { signal }))?.type === "oauth") {
        signal.throwIfAborted();
        // Pi owns refresh locking/persistence; never read auth.json or refresh tokens ourselves.
        const auth = (await this.models.getAuth(provider, { signal }))?.auth;
        signal.throwIfAborted();
        const token = auth?.apiKey;
        if (token) {
          const claims = record(JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")));
          const account = record(claims?.["https://api.openai.com/auth"])?.chatgpt_account_id;
          if (typeof account === "string" && account.length > 0) {
            const response = await this.fetcher("https://chatgpt.com/backend-api/wham/usage", {
              headers: { Authorization: `Bearer ${token}`, "ChatGPT-Account-Id": account, Accept: "application/json" },
              redirect: "error", signal,
            });
            if (response.ok) quota = parseCodexQuota(await response.json());
            else await response.body?.cancel();
          }
        }
      }
    } catch { /* Quota is optional; never surface provider bodies or credentials in errors. */ }
    if (this.closed || request.signal.aborted || this.request !== request) return;
    this.request = undefined;
    this.quota = quota;
    this.fetchedAt = this.now();
    this.changed?.();
    const delay = quota && quota.resetAt > this.now() ? Math.min(REFRESH_MS, quota.resetAt - this.now()) : REFRESH_MS;
    this.timer = setTimeout(() => { this.timer = undefined; void this.refresh(provider); }, delay);
    this.timer.unref();
  }

  close(): void {
    this.closed = true;
    this.request?.abort();
    if (this.timer) clearTimeout(this.timer);
    this.quota = undefined;
    this.changed = undefined;
  }
}
