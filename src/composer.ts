import { Editor, Input, matchesKey, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import { accent, dim, fit, warning } from "./format.js";
import { editExternally } from "./external-editor.js";
import { ComposerDiscovery, type DiscoveryContext } from "./discovery.js";

/** Multiline prompt editor with the same value API as the dashboard's old Input. */
export class Composer implements Component, Focusable {
  private readonly editor: Editor;
  private readonly placeholder: Input;
  private beforeInput = "";
  private discovery?: ComposerDiscovery;
  private discoveryKey?: string;
  private completionQueued = false;
  editing = false;
  onSubmit?: (text: string) => boolean;

  get focused(): boolean { return this.editor.focused; }
  set focused(value: boolean) { this.editor.focused = value; this.placeholder.focused = value; }

  constructor(
    private readonly tui: TUI,
    placeholder: string,
    private readonly fail: (error: unknown) => void,
    private readonly edit: (text: string) => Promise<string> = (text) => editExternally(tui, text),
  ) {
    this.placeholder = new Input({ placeholder, placeholderStyle: dim });
    this.editor = new Editor(tui, {
      borderColor: dim,
      selectList: { selectedPrefix: accent, selectedText: accent, description: dim, scrollInfo: dim, noMatch: warning },
    });
    this.editor.onSubmit = (text) => {
      this.completionQueued = false;
      // Pi's Editor clears before invoking onSubmit. Restore the exact draft when
      // the controller rejects a reply (e.g. the session is still working).
      if (!this.onSubmit?.(text)) this.setValue(this.beforeInput);
    };
  }

  getValue(): string { return this.editor.getExpandedText(); }
  setValue(text: string): void { this.completionQueued = false; this.editor.setText(text); }

  setDiscovery(context?: DiscoveryContext): void {
    const key = JSON.stringify(context ?? null);
    if (key === this.discoveryKey) return;
    this.discoveryKey = key;
    this.discovery = context && new ComposerDiscovery(context);
    this.completionQueued = false;
    if (this.discovery) this.discovery.onRequest = () => { this.completionQueued = false; };
    this.editor.setAutocompleteProvider(this.discovery ?? {
      getSuggestions: async () => null,
      applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
    });
  }

  get showingSuggestions(): boolean { return this.editor.isShowingAutocomplete(); }

  /** Give menu keys priority over dashboard navigation, but leave global shortcuts alone. */
  handleDiscoveryInput(data: string): boolean {
    if (this.editing) return false;
    if (matchesKey(data, "escape") && (this.showingSuggestions || this.getValue() && (this.discovery?.pending || this.completionQueued))) {
      this.completionQueued = false;
      if (this.discovery) this.editor.setAutocompleteProvider(this.discovery);
      return true;
    }
    if (this.showingSuggestions && (["up", "down", "ctrl+n", "ctrl+p", "tab", "enter"] as const).some((key) => matchesKey(data, key))) {
      // Enter accepts only: even a skill or path suggestion must never send a task.
      const key = matchesKey(data, "enter") ? "\t" : matchesKey(data, "ctrl+n") ? "\x1b[B"
        : matchesKey(data, "ctrl+p") ? "\x1b[A" : data;
      this.completionQueued = false;
      this.editor.handleInput(key);
      return true;
    }
    if (this.discovery && this.getValue() && matchesKey(data, "tab")) {
      this.completionQueued = true;
      this.editor.handleInput(data); return true;
    }
    return false;
  }

  handleInput(data: string): void {
    if (this.editing) return;
    if (this.handleDiscoveryInput(data)) return;
    if (matchesKey(data, "ctrl+g")) { void this.openEditor(); return; }
    this.beforeInput = this.getValue();
    this.editor.handleInput(data);
    if (this.discovery && data.charCodeAt(0) >= 32 && !data.includes("\x1b")) {
      const cursor = this.editor.getCursor();
      const before = (this.editor.getLines()[cursor.line] ?? "").slice(0, cursor.col);
      // Pi debounces @ queries. Escape must cancel that timer before a menu exists.
      this.completionQueued = (cursor.line === 0 && before.startsWith("/")) || /(?:^|\s)@\S*$/.test(before);
    }
  }

  async openEditor(): Promise<void> {
    if (this.editing) return;
    this.editing = true;
    this.completionQueued = false;
    if (this.discovery) this.editor.setAutocompleteProvider(this.discovery);
    try { this.setValue(await this.edit(this.getValue())); }
    catch (error) { this.fail(error); }
    finally { this.editing = false; this.tui.requestRender(); }
  }

  render(width: number): string[] {
    const lines = this.editor.render(Math.max(1, width));
    if (!this.editor.getText()) lines.splice(1, 1, ...this.placeholder.render(Math.max(1, width)));
    return lines.map((line) => fit(line, width));
  }

  invalidate(): void { this.editor.invalidate(); this.placeholder.invalidate(); }
}
