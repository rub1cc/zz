import { Editor, Input, matchesKey, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import { accent, dim, fit, oneLine, warning } from "./format.js";
import { editExternally } from "./external-editor.js";
import { MAX_ATTACHMENTS, imagePath, prepareImageFile, readClipboard, type ClipboardContent } from "./attachments.js";
import type { ImageAttachment } from "./model.js";
import { ComposerDiscovery, type DiscoveryContext } from "./discovery.js";

/** Multiline prompt editor with the same value API as the dashboard's old Input. */
export class Composer implements Component, Focusable {
  private editor: Editor;
  private readonly placeholder: Input;
  private beforeInput = "";
  private discovery?: ComposerDiscovery;
  private discoveryKey?: string;
  private completionQueued = false;
  editing = false;
  private attachmentScope = "default";
  private attachmentEpoch = 0;
  private attachmentDrafts = new Map<string, ImageAttachment[]>();
  attachmentLoading = false;
  get images(): ImageAttachment[] { return this.attachmentDrafts.get(this.attachmentScope) ?? []; }
  get hasContent(): boolean { return !!this.getValue() || !!this.images.length || this.attachmentLoading; }
  onSubmit?: (text: string, images?: ImageAttachment[]) => boolean | "command";

  get focused(): boolean { return this.editor.focused; }
  set focused(value: boolean) { this.editor.focused = value; this.placeholder.focused = value; }

  constructor(
    private readonly tui: TUI,
    placeholder: string,
    private readonly fail: (error: unknown) => void,
    private readonly edit: (text: string) => Promise<string> = (text) => editExternally(tui, text),
    private readonly attachments: { file: (path: string, cwd: string) => Promise<ImageAttachment>; clipboard: (cwd: string) => Promise<ClipboardContent> }
      = { file: prepareImageFile, clipboard: readClipboard },
  ) {
    this.placeholder = new Input({ placeholder, placeholderStyle: dim });
    this.editor = this.createEditor();
  }

  private createEditor(): Editor {
    const editor = new Editor(this.tui, {
      borderColor: dim,
      selectList: { selectedPrefix: accent, selectedText: accent, description: dim, scrollInfo: dim, noMatch: warning },
    });
    editor.onSubmit = (text) => {
      this.completionQueued = false;
      // Pi's Editor clears before invoking onSubmit. Restore the exact draft when
      // the controller rejects a reply (e.g. the session is still working).
      const accepted = this.onSubmit?.(text, this.images);
      if (!accepted) this.setValue(this.beforeInput);
      else if (accepted !== "command") {
        this.attachmentDrafts.delete(this.attachmentScope);
        editor.addToHistory(text);
      } else if (text.trimStart().startsWith("!")) editor.addToHistory(text);
    };
    return editor;
  }

  /** Replace history when switching sessions; never leak another session's prompts. */
  setHistory(texts: readonly string[]): void {
    const value = this.getValue();
    const focused = this.focused;
    this.editor = this.createEditor();
    for (const text of texts) this.editor.addToHistory(text);
    if (this.discovery) this.editor.setAutocompleteProvider(this.discovery);
    this.setValue(value);
    this.focused = focused;
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

  setAttachmentScope(scope: string): void {
    if (scope === this.attachmentScope) return;
    this.attachmentScope = scope;
    this.attachmentEpoch++;
    this.attachmentLoading = false;
  }

  private async loadAttachments(load: () => Promise<ClipboardContent>): Promise<void> {
    if (this.attachmentLoading || this.editing) return;
    const epoch = this.attachmentEpoch;
    const focused = this.focused;
    this.attachmentLoading = true;
    this.tui.requestRender();
    try {
      const result = await load();
      if (epoch !== this.attachmentEpoch || focused && !this.focused) return;
      if (result.images?.length) {
        if (this.images.length + result.images.length > MAX_ATTACHMENTS) throw new Error(`Attach at most ${MAX_ATTACHMENTS} images per message.`);
        this.attachmentDrafts.set(this.attachmentScope, [...this.images, ...result.images]);
      }
      if (result.text) this.editor.insertTextAtCursor(result.text);
    } catch (error) { if (epoch === this.attachmentEpoch) this.fail(error); }
    finally { if (epoch === this.attachmentEpoch) this.attachmentLoading = false; this.tui.requestRender(); }
  }

  async attachFile(path: string): Promise<void> {
    const cwd = this.discovery?.context.cwd ?? process.cwd();
    await this.loadAttachments(async () => ({ images: [await this.attachments.file(path, cwd)] }));
  }

  async pasteClipboard(): Promise<void> {
    const cwd = this.discovery?.context.cwd ?? process.cwd();
    await this.loadAttachments(() => this.attachments.clipboard(cwd));
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
    if (matchesKey(data, "ctrl+v")) { void this.pasteClipboard(); return; }
    if (this.attachmentLoading && matchesKey(data, "enter")) return;
    if (!this.getValue() && this.images.length && matchesKey(data, "backspace")) {
      this.attachmentDrafts.set(this.attachmentScope, this.images.slice(0, -1));
      this.tui.requestRender(); return;
    }
    const pasted = data.startsWith("\x1b[200~") && data.endsWith("\x1b[201~") ? data.slice(6, -6).trim() : data.trim();
    const singlePath = /^(?:"[^"\n]+"|'[^'\n]+')$/.test(pasted) || !/(?<!\\)\s/.test(pasted);
    if (!pasted.startsWith("!") && singlePath && (data.startsWith("\x1b[200~") || /^(?:\/|~\/|\.\/|["'])/.test(pasted)) && imagePath(pasted)) {
      void this.attachFile(pasted); return;
    }
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
    if (this.getValue().trimStart().startsWith("!")) lines.push(dim("Local shell / Enter runs directly / no model request"));
    if (this.attachmentLoading) lines.push(dim("Preparing image..."));
    if (this.images.length) lines.push(...this.images.slice(0, 2).map((image, index) => dim(`Image ${index + 1}: ${oneLine(image.name ?? "image")}`)),
      dim(`${this.images.length} attached / Ctrl+V paste / Backspace on empty draft removes last`));
    return lines.map((line) => fit(line, width));
  }

  invalidate(): void { this.editor.invalidate(); this.placeholder.invalidate(); }
}
