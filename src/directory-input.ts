import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Input, SelectList, matchesKey, type SelectItem } from "@earendil-works/pi-tui";
import { accent, dim, oneLine, warning } from "./format.js";

/** Complete the whole field as a path, not shell words (spaces need no quoting). */
export async function directorySuggestions(value: string, cwd = process.cwd(), home = homedir()): Promise<SelectItem[]> {
  const path = value.trim();
  const browsing = path === "~" ? "~/" : path;
  const slash = browsing.lastIndexOf("/");
  const parent = browsing.slice(0, slash + 1);
  const prefix = browsing.slice(slash + 1);
  const expanded = parent.startsWith("~/") ? join(home, parent.slice(2)) : parent;
  const base = resolve(cwd, expanded || ".");
  try {
    const entries = await readdir(base, { withFileTypes: true });
    const matches = await Promise.all(entries.filter((entry) => entry.name.startsWith(prefix)
      && (!entry.name.startsWith(".") || prefix.startsWith("."))
      // Input renders the inserted path literally; do not insert terminal control bytes.
      && !/[\x00-\x1f\x7f-\x9f]/.test(entry.name))
      .map(async (entry) => {
        let directory = entry.isDirectory();
        if (entry.isSymbolicLink()) {
          try { directory = (await stat(join(base, entry.name))).isDirectory(); } catch { return null; }
        }
        return directory ? { value: `${parent}${entry.name}/`, label: oneLine(`${entry.name}/`) } : null;
      }));
    return matches.filter((item): item is SelectItem => item !== null)
      .sort((a, b) => a.value.localeCompare(b.value));
  } catch { return []; }
}

export class DirectoryInput extends Input {
  private suggestions?: SelectList;
  private revision = 0;

  constructor(private readonly changed: () => void, private readonly cwd = process.cwd(),
    private readonly suggest = directorySuggestions) {
    super({ placeholder: "/path/to/project", placeholderStyle: dim });
    this.refresh();
  }

  override setValue(value: string): void {
    super.setValue(value);
    this.refresh();
  }

  private refresh(): void {
    const revision = ++this.revision;
    this.suggestions = undefined;
    void this.suggest(this.getValue(), this.cwd).then((items) => {
      if (revision !== this.revision) return;
      if (items.length) this.suggestions = new SelectList(items, 5, {
        selectedPrefix: accent, selectedText: accent, description: dim, scrollInfo: dim, noMatch: warning,
      });
      this.changed();
    }).catch(() => { /* Completion is optional; invalid paths can still be edited and submitted. */ });
  }

  /** Escape dismisses completion before the dialog handles cancellation. */
  dismissSuggestions(data: string): boolean {
    if (!matchesKey(data, "escape") || !this.suggestions) return false;
    ++this.revision;
    this.suggestions = undefined;
    return true;
  }

  override handleInput(data: string): void {
    if (this.dismissSuggestions(data)) { this.changed(); return; }
    if (matchesKey(data, "tab")) {
      const item = this.suggestions?.getSelectedItem();
      if (item) {
        this.setValue(item.value);
        super.handleInput("\x05"); // Put the cursor after the completed directory's slash.
      } else this.refresh();
    } else if (this.suggestions && (["up", "down", "ctrl+p", "ctrl+n"] as const).some((key) => matchesKey(data, key))) {
      this.suggestions.handleInput(data);
    } else {
      const before = this.getValue();
      super.handleInput(data);
      if (this.getValue() !== before) this.refresh();
    }
    this.changed();
  }

  override render(width: number): string[] {
    return [...super.render(width), ...(this.suggestions?.render(width) ?? [])];
  }
}
