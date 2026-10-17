import type { AuthEvent, AuthPrompt, AuthType, LoginOptions } from "@earendil-works/pi-ai";
import { CredentialSynchronizationError, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { CodexQuota } from "./codex-quota.js";

export type AuthAction = "login" | "logout";
export type AuthRuntime = Pick<ModelRuntime, "getProviders" | "getProvider" | "getProviderAuthStatus" | "isUsingOAuth" | "listCredentials" | "login" | "logout" | "refresh">;
export interface AuthChoice {
  id: string;
  providerId: string;
  name: string;
  type: AuthType;
  label: string;
  status: string;
  interactive: boolean;
}
export interface AuthAccess { runtime: AuthRuntime; options?: LoginOptions; codexQuota?: CodexQuota }

/** One transient authentication interaction. Never enters conversation history or zz storage. */
export class AuthFlow {
  phase: "loading" | "choose" | "confirm" | "running" | "done" | "error" = "loading";
  choices: AuthChoice[] = [];
  selected?: AuthChoice;
  prompt?: AuthPrompt;
  messages: string[] = [];
  progress = "";
  url?: string;
  private readonly abort = new AbortController();
  private pending?: { resolve(value: string): void; reject(error: Error): void };
  private secrets: string[] = [];
  get disposed(): boolean { return this.abort.signal.aborted; }

  constructor(readonly action: AuthAction, readonly access: AuthAccess,
    readonly changed: () => void, readonly completed: (providerId: string, action: AuthAction) => Promise<string | void> = async () => {}) {}

  private update(): void { if (!this.disposed) this.changed(); }
  safe(text: string): string {
    for (const secret of this.secrets) text = text.replaceAll(secret, "[redacted]");
    return text;
  }

  async start(providerRef?: string): Promise<void> {
    try {
      const runtime = this.access.runtime;
      if (this.action === "logout") {
        this.choices = (await runtime.listCredentials({ signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(15_000)]) }))
          .map(({ providerId, type }) => {
            const name = runtime.getProvider(providerId)?.name ?? providerId;
            return { id: `${providerId}:${type}`, providerId, name, type, label: name, status: `stored ${type === "oauth" ? "account" : "API key"}`, interactive: true };
          });
      } else {
        this.choices = runtime.getProviders().flatMap((provider) => {
          const status = runtime.getProviderAuthStatus(provider.id);
          const configured = status.configured ? `${runtime.isUsingOAuth(provider.id) ? "account" : "API key"}: ${status.label ?? status.source ?? "configured"}` : "not configured";
          return (["oauth", "api_key"] as const).flatMap((type) => {
            const method = type === "oauth" ? provider.auth.oauth : provider.auth.apiKey;
            if (!method) return [];
            const label = type === "oauth" ? provider.auth.oauth?.loginLabel ?? `Sign in with ${provider.auth.oauth?.isSubscription ? "subscription" : "account"}`
              : method.login ? "API key" : "External setup";
            return [{ id: `${provider.id}:${type}`, providerId: provider.id, name: provider.name, type,
              label: `${provider.name} / ${label}`, status: `${configured} / ${method.name}`, interactive: !!method.login }];
          });
        });
      }
      if (this.disposed) return;
      this.choices.sort((a, b) => a.label.localeCompare(b.label));
      if (providerRef) {
        const ref = providerRef.toLowerCase();
        this.choices = this.choices.filter((choice) => choice.providerId.toLowerCase() === ref || choice.name.toLowerCase() === ref);
        if (!this.choices.length) throw new Error(`No ${this.action === "login" ? "login methods" : "stored credentials"} for ${providerRef}. Use /${this.action} to see providers.`);
      }
      this.phase = "choose";
      if (!this.choices.length) this.messages = [this.action === "logout"
        ? "No stored credentials to remove. Environment variables and models.json are unchanged."
        : "No provider login methods available."];
      this.update();
      if (providerRef && this.choices.length === 1) await this.choose(this.choices[0]!.id);
    } catch (error) { this.failure(error); }
  }

  async choose(id: string): Promise<void> {
    if (this.disposed || this.phase !== "choose") return;
    const choice = this.choices.find((item) => item.id === id);
    if (!choice) return;
    this.selected = choice;
    if (this.action === "logout") { this.phase = "confirm"; this.update(); return; }
    if (!choice.interactive) {
      this.phase = "done";
      this.messages = [`${choice.name} uses authentication configured outside zz. Set up its environment/cloud credentials, then reopen zz.`, choice.status];
      this.update(); return;
    }
    await this.run();
  }

  async confirm(): Promise<void> {
    if (this.phase === "confirm" && !this.disposed) await this.run();
  }

  private ask(prompt: AuthPrompt): Promise<string> {
    if (this.disposed || prompt.signal?.aborted) return Promise.reject(new Error("Login cancelled"));
    return new Promise((resolve, reject) => {
      const onAbort = () => finish(undefined, new Error("Login cancelled"));
      const finish = (value?: string, error?: Error) => {
        this.abort.signal.removeEventListener("abort", onAbort);
        prompt.signal?.removeEventListener("abort", onAbort);
        if (this.prompt === prompt) { this.prompt = undefined; this.pending = undefined; }
        this.update();
        if (error) reject(error); else resolve(value!);
      };
      this.pending = { resolve: (value) => finish(value), reject: (error) => finish(undefined, error) };
      this.prompt = prompt;
      this.abort.signal.addEventListener("abort", onAbort, { once: true });
      prompt.signal?.addEventListener("abort", onAbort, { once: true });
      this.update();
    });
  }

  submit(value: string): void {
    if (this.disposed || !this.prompt || !this.pending) return;
    if (this.prompt.type === "select" && !this.prompt.options.some((option) => option.id === value)) return;
    if (!value.trim()) return;
    if (this.prompt.type !== "select") this.secrets.push(value);
    this.pending.resolve(value);
  }

  private notify(event: AuthEvent): void {
    if (this.disposed) return;
    if (event.type === "auth_url") {
      this.url = event.url;
      this.messages = event.instructions ? [event.instructions] : [];
    } else if (event.type === "device_code") {
      this.url = event.verificationUri;
      this.messages = [`Enter code: ${event.userCode}`];
    } else if (event.type === "info") {
      this.messages = [...this.messages, event.message, ...(event.links ?? []).map((link) => `${link.label ? `${link.label}: ` : ""}${link.url}`)].slice(-8);
    } else this.progress = event.message;
    this.update();
  }

  private async run(): Promise<void> {
    const choice = this.selected!;
    this.phase = "running";
    this.messages = [];
    this.progress = this.action === "login" ? "Waiting for authentication..." : "Removing shared credential...";
    this.update();
    let committed = false;
    try {
      const runtime = this.access.runtime;
      if (this.action === "login") {
        await runtime.login(choice.providerId, choice.type, {
          signal: this.abort.signal, prompt: (prompt) => this.ask(prompt), notify: (event) => this.notify(event),
        }, this.access.options);
      } else await runtime.logout(choice.providerId, { signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(15_000)]) });
      committed = true;
      if (this.disposed) return;
      this.url = undefined;
      this.messages = [this.action === "login" ? `Credentials saved for ${choice.name}. Shared with Pi.`
        : `Stored credential removed for ${choice.name}, including in Pi. Environment variables and models.json are unchanged; provider access is not revoked.`];
      if (this.action === "login") {
        this.progress = "Refreshing model catalog...";
        this.update();
        try {
          const result = await runtime.refresh({ providers: [choice.providerId], allowNetwork: true,
            signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(15_000)]) });
          if (result.aborted || result.errors.size) this.messages.push("Model catalog refresh failed or timed out; using cached models. Credentials remain saved.");
        } catch { this.messages.push("Model catalog refresh failed; using cached models. Credentials remain saved."); }
      }
      if (this.disposed) return;
      try {
        const message = await this.completed(choice.providerId, this.action);
        if (message) this.messages.push(message);
      } catch { this.messages.push("Credentials changed, but model selection could not be updated. Use /model."); }
      this.phase = "done";
      this.progress = "";
      if (this.action === "login") this.messages.push("Use /model to choose a model. Existing sessions keep their selections.");
      this.update();
    } catch (error) {
      if (error instanceof CredentialSynchronizationError) {
        this.failure(new Error(`Credentials ${this.action === "login" ? "saved" : "removed"}, but local model state could not be synchronized. Reopen zz before using this provider.`));
      } else if (committed) this.failure(new Error("Credentials changed, but local model state could not be updated. Reopen zz."));
      else this.failure(error);
    }
  }

  private failure(error: unknown): void {
    if (this.disposed) return;
    this.phase = "error";
    this.prompt = undefined;
    this.url = undefined;
    this.progress = "";
    this.messages = [this.safe(error instanceof Error ? error.message : String(error))];
    this.update();
  }

  dispose(): void {
    if (this.disposed) return;
    this.abort.abort();
    this.pending?.reject(new Error("Login cancelled"));
    this.prompt = undefined;
    this.url = undefined;
    this.messages = [];
    this.secrets = [];
  }
}
