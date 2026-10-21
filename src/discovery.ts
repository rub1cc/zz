import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider, fuzzyFilter, type AutocompleteProvider, type SlashCommand } from "@earendil-works/pi-tui";
import { oneLine } from "./format.js";
import { SkillCatalog } from "./skills.js";
import type { SkillOption } from "./model.js";

export interface DiscoveryContext {
  cwd: string;
  /** Peek replies offer files and skills, but do not dispatch dashboard commands. */
  commands: boolean;
  session: boolean;
  /** A session row is selected on the dashboard (not a project header). */
  selectedSession?: boolean;
}

export function composerCommands(session: boolean, selectedSession = false): SlashCommand[] {
  return [
    { name: "model", description: session ? "Choose this session's model" : "Choose the model for new tasks" },
    { name: "thinking", description: session ? "Choose this session's thinking level" : "Choose the thinking level for new tasks" },
    { name: "skills", description: "Find and load a skill" },
    { name: "settings", description: "Configure replies, model, reasoning and auto-compaction" },
    { name: "projects", description: "Manage project directories" },
    { name: "workspace", description: session ? "Inspect this session's checkout" : "Choose main, new worktree, or existing workspace" },
    { name: "login", description: "Sign in to a provider (credentials shared with Pi)" },
    { name: "logout", description: "Remove stored provider credentials from zz and Pi" },
    ...(session || selectedSession ? [
      { name: "answer", description: "Reopen the pending question form" },
      { name: "copy", description: "Copy response text (/copy [N], 1 = latest)" },
      { name: "session", description: `Context, tokens, cache and estimated cost for the ${session ? "open" : "selected"} session` },
      { name: "tasks", description: `View checklist details for the ${session ? "open" : "selected"} session` },
      { name: "compact", description: `Summarize older context in the ${session ? "open" : "selected"} session (optional instructions)` },
      { name: "undo", description: "Choose a checkpoint to restore conversation and tracked file edits" },
      { name: "stop", description: `Stop the ${session ? "open" : "selected"} session without deleting it` },
    ] : []),
    { name: "help", description: "Show commands for this view and keyboard shortcuts" },
    ...(session ? [
      { name: "top", description: "Scroll to the oldest chat output" },
      { name: "bottom", description: "Scroll to bottom and follow output" },
      { name: "expand", description: "Show all tool details" },
      { name: "collapse", description: "Hide all tool details" },
    ] : []),
  ];
}

/** Reuse an installed fd, including Pi's copy. Never download or run project code. */
export async function findFd(): Promise<string | null> {
  const suffix = process.platform === "win32" ? ".exe" : "";
  const candidates = [join(getAgentDir(), "bin", `fd${suffix}`),
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean)
      .flatMap((dir) => [join(dir, `fd${suffix}`), join(dir, `fdfind${suffix}`)])];
  for (const file of candidates) {
    try { await access(file, constants.X_OK); return file; } catch { /* Try the next installed binary. */ }
  }
  return null;
}

/** Pi supplies filtering, quoting, cancellation and completion insertion. */
export class ComposerDiscovery implements AutocompleteProvider {
  readonly triggerCharacters = ["$"];
  private readonly provider: CombinedAutocompleteProvider;
  private readonly fd: Promise<string | null>;
  private files?: CombinedAutocompleteProvider;
  private skillOptions?: Promise<SkillOption[]>;
  pending = false;
  onRequest?: () => void;

  constructor(readonly context: DiscoveryContext, fd: Promise<string | null> = findFd(),
    private readonly skills: Pick<SkillCatalog, "list"> = new SkillCatalog()) {
    this.provider = new CombinedAutocompleteProvider(context.commands ? composerCommands(context.session, context.selectedSession) : [], context.cwd);
    this.fd = fd;
  }

  resetSkills(): void { this.skillOptions = undefined; }

  async getSuggestions(...args: Parameters<AutocompleteProvider["getSuggestions"]>) {
    const [lines, line, col, options] = args;
    this.pending = true;
    this.onRequest?.();
    try {
      // Only resolve fd for @ search; command and skill discovery never wait for it.
      const before = (lines[line] ?? "").slice(0, col);
      const skillPrefix = line === 0 ? /^\s*(\$[^\s]*)$/.exec(before)?.[1] : undefined;
      const at = /(?:^|[\s([<{`])(@(?:"[^"]*|[^\s"]*))$/.exec(before)?.[1];
      let suggestions;
      if (skillPrefix) {
        // Refresh on a new $ menu, then reuse its catalog while filtering.
        if (!this.skillOptions || skillPrefix === "$") {
          this.skillOptions = this.skills.list(this.context.cwd).catch((error: unknown) => {
            this.skillOptions = undefined;
            throw error;
          });
        }
        const matches = fuzzyFilter(await this.skillOptions, skillPrefix.slice(1), (skill) => skill.name);
        suggestions = matches.length ? { prefix: skillPrefix, items: matches.map((skill) => ({
          value: `$${skill.name}`, label: `$${skill.name}`, description: skill.description,
        })) } : null;
      } else if (at) {
        const fd = await this.fd;
        if (options.signal.aborted) return null;
        if (fd) {
          this.files ??= new CombinedAutocompleteProvider([], this.context.cwd, fd);
          suggestions = await this.files.getSuggestions(...args);
        } else {
          // Without fd, @ still browses directories using Pi's ordinary path completion.
          const path = at.slice(1);
          const copy = [...lines];
          copy[line] = before.slice(0, -at.length) + path + (lines[line] ?? "").slice(col);
          const result = await this.provider.getSuggestions(copy, line, col - 1, { ...options, force: true });
          suggestions = result && { prefix: at, items: result.items.map((item) => ({
            ...item, value: `@${item.value}`, description: "Path completion (install fd for recursive search)",
          })) };
        }
      } else {
        // Commands belong to the start of the message, never a later line in a draft.
        if (line > 0 && before.trimStart().startsWith("/") && !options.force) return null;
        suggestions = await this.provider.getSuggestions(...args);
        // At the start of a prompt, an absolute path can otherwise look like a command.
        if (!suggestions && line === 0 && before.startsWith("/") && !before.includes(" ")) {
          suggestions = await this.provider.getSuggestions(lines, line, col, { ...options, force: true });
        }
      }
      if (options.signal.aborted) return null;
      // Filenames are untrusted terminal text; keep insertion values exact, labels safe.
      return suggestions && { ...suggestions, items: suggestions.items.map((item) => ({
        ...item, label: oneLine(item.label), description: item.description && oneLine(item.description),
      })) };
    } finally { this.pending = false; }
  }

  applyCompletion(...args: Parameters<AutocompleteProvider["applyCompletion"]>) {
    const [lines, cursorLine, cursorCol, item, prefix] = args;
    if (prefix.startsWith("$")) {
      const copy = [...lines];
      const before = (lines[cursorLine] ?? "").slice(0, cursorCol - prefix.length);
      copy[cursorLine] = before + item.value + " " + (lines[cursorLine] ?? "").slice(cursorCol);
      return { lines: copy, cursorLine, cursorCol: before.length + item.value.length + 1 };
    }
    // Pi's inserter treats /foo at column zero as a command even when it is a path.
    if (prefix.startsWith("/") && (item.value.startsWith("/") || item.value.startsWith('"/'))) {
      const copy = [...lines];
      const before = (lines[cursorLine] ?? "").slice(0, cursorCol - prefix.length);
      copy[cursorLine] = before + item.value + (lines[cursorLine] ?? "").slice(cursorCol);
      return { lines: copy, cursorLine, cursorCol: before.length + item.value.length
        - (item.label.endsWith("/") && item.value.endsWith('"') ? 1 : 0) };
    }
    return this.provider.applyCompletion(...args);
  }

  shouldTriggerFileCompletion(...args: Parameters<NonNullable<AutocompleteProvider["shouldTriggerFileCompletion"]>>) {
    const [lines, line, col] = args;
    if (line === 0 && /^\s*\$[^\s]*$/.test((lines[line] ?? "").slice(0, col))) return true;
    return this.provider.shouldTriggerFileCompletion(...args);
  }
}
