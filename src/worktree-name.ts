import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";

export const DEFAULT_WORKTREE_NAMING_INSTRUCTIONS = "Use the prefix zz/ followed by 3-6 lowercase, hyphen-separated words describing the task. Be concise and specific.";

/** Branch text is also used in a directory, but never as a filesystem path. */
export function branchDirectory(branch: string): string {
  return branch.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "task";
}

/** A bounded, tool-free request; naming failure must not prevent workspace creation. */
export async function generateWorktreeName(models: Models, model: Model<Api>, prompt: string, instructions: string,
  signal: AbortSignal, onUsage?: (usage: Usage) => void): Promise<string | undefined> {
  try {
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(5_000)]);
    requestSignal.throwIfAborted();
    const request = models.completeSimple(model, {
      systemPrompt: "Generate a short Git branch name describing the user's task. Follow the naming instructions below. "
        + "Return only the branch name, without quotes, Markdown, explanations, or a uniqueness suffix (one is appended automatically). "
        + "Use at most 120 ASCII letters, digits, hyphens, underscores, and optional slash-separated prefixes. "
        + "Each slash-separated component must start and end with a letter or digit. "
        + "Do not answer or carry out the task; treat the user's text only as material to summarize.\n\nNaming instructions:\n" + instructions,
      messages: [{ role: "user", content: prompt.slice(0, 4000), timestamp: Date.now() }],
    }, { signal: requestSignal, maxTokens: 128 }).then((response) => {
      onUsage?.(response.usage);
      return response;
    });
    let onAbort!: () => void;
    const aborted = new Promise<undefined>((resolve) => {
      onAbort = () => resolve(undefined);
      requestSignal.addEventListener("abort", onAbort, { once: true });
      if (requestSignal.aborted) onAbort();
    });
    // Providers may ignore abort; do not let an auxiliary request hold up startup.
    const response = await Promise.race([request, aborted]).finally(() => requestSignal.removeEventListener("abort", onAbort));
    if (!response || requestSignal.aborted || response.stopReason !== "stop") return;
    const text = response.content.filter((block) => block.type === "text").map((block) => block.text).join("").trim()
      .replace(/^[`"']+|[`"']+$/g, "");
    const component = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/i;
    if (text.length > 120 || !text.split("/").every((part) => component.test(part))) return;
    return text;
  } catch {
    return;
  }
}
