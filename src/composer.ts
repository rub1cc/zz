import { Editor, Input, matchesKey, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { accent, dim, fit, warning } from "./format.js";
import { editExternally } from "./external-editor.js";
import { MAX_ATTACHMENTS, imagePath, prepareImageFile, readClipboard, type ClipboardContent } from "./attachments.js";
import type { ImageAttachment } from "./model.js";
import { ComposerDiscovery, composerCommands, type DiscoveryContext } from "./discovery.js";
import type { SkillCatalog } from "./skills.js";

interface AttachmentDraft {
  text: string;
  images: Map<number, ImageAttachment>;
  nextId: number;
}

function imageTags(text: string, draft?: AttachmentDraft) {
  return [...text.matchAll(/\[Image #(\d+)\]/g)].filter((match) => draft?.images.has(Number(match[1])));
}

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
  private attachmentDrafts = new Map<string, AttachmentDraft>();
  private history: readonly string[] = [];
  attachmentLoading = false;
  private get attachmentDraft(): AttachmentDraft | undefined { return this.attachmentDrafts.get(this.attachmentScope); }
  private get imageIds(): number[] { return [...new Set(imageTags(this.getValue(), this.attachmentDraft).map((tag) => Number(tag[1])))]; }
  get images(): ImageAttachment[] { return this.imageIds.map((id) => this.attachmentDraft!.images.get(id)!); }
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
    this.placeholder = new Input({ prompt: "\u276f ", placeholder, placeholderStyle: dim });
    this.editor = this.createEditor();
  }

  private createEditor(): Editor {
    const editor = new Editor(this.tui, {
      borderColor: dim,
      selectList: { selectedPrefix: accent, selectedText: accent, description: dim, scrollInfo: dim, noMatch: warning },
    }, { paddingX: 2 });
    editor.onSubmit = (text) => {
      this.completionQueued = false;
      this.discovery?.resetSkills();
      const scope = this.attachmentScope;
      const draft = this.attachmentDraft;
      const ids = [...new Set(imageTags(text, draft).map((tag) => Number(tag[1])))];
      const images = ids.map((id) => draft!.images.get(id)!);
      const plainText = this.withoutImageTags(text, draft);
      const command = /^[!/]/.test(plainText.trimStart());
      const prompt = command || !plainText.trim() ? plainText : text;
      // Pi clears before onSubmit; capture the scope before the controller can navigate.
      const accepted = this.onSubmit?.(prompt, images);
      if (!accepted) {
        if (scope === this.attachmentScope) editor.setText(this.beforeInput);
        else if (draft) draft.text = this.beforeInput;
      } else if (accepted !== "command") {
        this.attachmentDrafts.delete(scope);
        editor.addToHistory(plainText);
      } else {
        const markers = ids.map((id) => `[Image #${id}]`).join(" ");
        if (scope === this.attachmentScope) editor.setText(markers);
        else if (draft) draft.text = markers;
        if (plainText.trimStart().startsWith("!")) editor.addToHistory(plainText);
      }
    };
    return editor;
  }

  /** Replace history when switching sessions; never leak another session's prompts. */
  setHistory(texts: readonly string[]): void {
    const value = this.getValue();
    this.history = texts;
    this.replaceEditor(value);
  }

  private replaceEditor(value: string): void {
    this.completionQueued = false;
    this.discovery?.resetSkills();
    const focused = this.focused;
    this.editor = this.createEditor();
    for (const text of this.history) this.editor.addToHistory(text);
    if (this.discovery) this.editor.setAutocompleteProvider(this.discovery);
    this.editor.setText(value);
    this.focused = focused;
  }

  getValue(): string { return this.editor.getExpandedText(); }
  setValue(text: string): void {
    this.completionQueued = false;
    this.discovery?.resetSkills();
    // Programmatic prompt/command replacements retain staged images, as before.
    const present = new Set(imageTags(text, this.attachmentDraft).map((tag) => Number(tag[1])));
    const missing = this.imageIds.filter((id) => !present.has(id));
    if (missing.length) text += `${text && !/\s$/.test(text) ? " " : ""}${missing.map((id) => `[Image #${id}]`).join(" ")}`;
    this.editor.setText(text);
  }

  private withoutImageTags(text: string, draft = this.attachmentDraft): string {
    return text.replace(/\[Image #(\d+)\]/g, (tag, id: string) => draft?.images.has(Number(id)) ? "" : tag);
  }

  setDiscovery(context?: DiscoveryContext, skills?: Pick<SkillCatalog, "list">): void {
    const key = JSON.stringify(context ?? null);
    if (key === this.discoveryKey) return;
    this.discoveryKey = key;
    this.discovery = context && new ComposerDiscovery(context, undefined, skills);
    this.completionQueued = false;
    if (this.discovery) this.discovery.onRequest = () => { this.completionQueued = false; };
    this.editor.setAutocompleteProvider(this.discovery ?? {
      getSuggestions: async () => null,
      applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
    });
  }

  setAttachmentScope(scope: string): void {
    if (scope === this.attachmentScope) return;
    const draft = this.attachmentDraft ?? { text: "", images: new Map(), nextId: 1 };
    draft.text = this.getValue();
    this.attachmentDrafts.set(this.attachmentScope, draft);
    this.attachmentScope = scope;
    this.attachmentEpoch++;
    this.attachmentLoading = false;
    this.replaceEditor(this.attachmentDraft?.text ?? "");
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
        const draft = this.attachmentDraft ?? { text: "", images: new Map(), nextId: 1 };
        const markers = result.images.map((image) => {
          // Do not turn an existing literal tag into a reference to a new image.
          while (this.getValue().includes(`[Image #${draft.nextId}]`)) draft.nextId++;
          const id = draft.nextId++;
          draft.images.set(id, image);
          return `[Image #${id}]`;
        });
        this.attachmentDrafts.set(this.attachmentScope, draft);
        this.snapImageCursor();
        this.editor.insertTextAtCursor(markers.join(" "));
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

  private snapImageCursor(direction = 1): void {
    const cursor = this.editor.getCursor();
    const tag = imageTags(this.editor.getLines()[cursor.line] ?? "", this.attachmentDraft)
      .find((tag) => tag.index < cursor.col && cursor.col < tag.index + tag[0].length);
    if (!tag) return;
    const target = direction < 0 ? tag.index : tag.index + tag[0].length;
    while (direction < 0 ? this.editor.getCursor().col > target : this.editor.getCursor().col < target) {
      const before = this.editor.getCursor().col;
      this.editor.handleInput(direction < 0 ? "\x1b[D" : "\x1b[C");
      if (this.editor.getCursor().col === before) break;
    }
  }

  private removeImageTag(forward: boolean): boolean {
    const cursor = this.editor.getCursor();
    const tag = imageTags(this.editor.getLines()[cursor.line] ?? "", this.attachmentDraft)
      .find((tag) => forward ? tag.index <= cursor.col && cursor.col < tag.index + tag[0].length
        : tag.index < cursor.col && cursor.col <= tag.index + tag[0].length);
    if (!tag) return false;
    let text = this.getValue();
    let offset = this.editor.getLines().slice(0, cursor.line).reduce((sum, line) => sum + line.length + 1, 0) + cursor.col;
    if (text !== this.editor.getText()) {
      // Resolve the caret through Pi's collapsed pastes without accessing SDK internals.
      const probe = randomUUID();
      this.editor.insertTextAtCursor(probe);
      offset = this.getValue().indexOf(probe);
      this.editor.handleInput("\x1f");
    }
    const start = offset - (cursor.col - tag.index);
    text = text.slice(0, start) + text.slice(start + tag[0].length);
    // One setText snapshot makes the entire deletion a single undo step.
    this.editor.setText(text);
    const prefix = text.slice(0, start).split("\n");
    const line = prefix.length - 1;
    const col = prefix[line]!.length;
    while (this.editor.getCursor().line > line) {
      this.editor.handleInput("\x01");
      this.editor.handleInput("\x1b[D");
    }
    this.editor.handleInput("\x01");
    while (this.editor.getCursor().col < col) this.editor.handleInput("\x1b[C");
    this.tui.requestRender();
    return true;
  }

  /** Give menu keys priority over dashboard navigation, but leave global shortcuts alone. */
  handleDiscoveryInput(data: string): boolean {
    if (this.editing) return false;
    if (matchesKey(data, "escape") && (this.showingSuggestions || this.getValue() && (this.discovery?.pending || this.completionQueued))) {
      this.completionQueued = false;
      if (this.discovery) {
        this.discovery.resetSkills();
        this.editor.setAutocompleteProvider(this.discovery);
      }
      return true;
    }
    if (this.showingSuggestions && (["up", "down", "ctrl+n", "ctrl+p", "tab", "enter"] as const).some((key) => matchesKey(data, key))) {
      const enter = matchesKey(data, "enter");
      const key = enter ? "\t" : matchesKey(data, "ctrl+n") ? "\x1b[B"
        : matchesKey(data, "ctrl+p") ? "\x1b[A" : data;
      this.completionQueued = false;
      this.editor.handleInput(key);
      // Fill first, then execute only a complete built-in command, never a file or prompt.
      const context = this.discovery?.context;
      if (enter && !this.attachmentLoading && !this.showingSuggestions && context?.commands
        && composerCommands(context.session, context.selectedSession).some(({ name }) => this.getValue().trim() === `/${name}`)) {
        this.beforeInput = this.getValue();
        this.editor.handleInput("\r");
      }
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
    if ((matchesKey(data, "backspace") || matchesKey(data, "shift+backspace") || matchesKey(data, "ctrl+w") || matchesKey(data, "alt+backspace"))
      && this.removeImageTag(false)) return;
    if ((matchesKey(data, "delete") || matchesKey(data, "shift+delete") || matchesKey(data, "ctrl+d") || matchesKey(data, "alt+d") || matchesKey(data, "alt+delete"))
      && this.removeImageTag(true)) return;
    const pasted = data.startsWith("\x1b[200~") && data.endsWith("\x1b[201~") ? data.slice(6, -6).trim() : data.trim();
    const singlePath = /^(?:"[^"\n]+"|'[^'\n]+')$/.test(pasted) || !/(?<!\\)\s/.test(pasted);
    if (!pasted.startsWith("!") && singlePath && (data.startsWith("\x1b[200~") || /^(?:\/|~\/|\.\/|["'])/.test(pasted)) && imagePath(pasted)) {
      void this.attachFile(pasted); return;
    }
    if (this.handleDiscoveryInput(data)) return;
    if (matchesKey(data, "ctrl+g")) { void this.openEditor(); return; }
    this.beforeInput = this.getValue();
    if (!this.beforeInput.trim()) this.discovery?.resetSkills();
    this.editor.handleInput(data);
    const movingLeft = (["left", "ctrl+b", "alt+left", "ctrl+left", "alt+b"] as const).some((key) => matchesKey(data, key));
    this.snapImageCursor(movingLeft ? -1 : 1);
    if (this.discovery && data.charCodeAt(0) >= 32 && !data.includes("\x1b")) {
      const cursor = this.editor.getCursor();
      const before = (this.editor.getLines()[cursor.line] ?? "").slice(0, cursor.col);
      // Pi debounces symbol queries. Escape must cancel that timer before a menu exists.
      this.completionQueued = (cursor.line === 0 && (/^\s*\$\S*$/.test(before) || before.startsWith("/"))) || /(?:^|\s)@\S*$/.test(before);
    }
  }

  async openEditor(): Promise<void> {
    if (this.editing) return;
    this.editing = true;
    this.completionQueued = false;
    if (this.discovery) this.editor.setAutocompleteProvider(this.discovery);
    try { this.editor.setText(await this.edit(this.getValue())); }
    catch (error) { this.fail(error); }
    finally { this.editing = false; this.tui.requestRender(); }
  }

  render(width: number): string[] {
    const lines = this.editor.render(Math.max(1, width));
    if (!this.editor.getText()) lines.splice(1, 1, ...this.placeholder.render(Math.max(1, width)));
    // Reuse editor padding without shifting its wrapping or hardware cursor marker.
    else if (width >= 5 && lines[1]) lines[1] = accent("\u276f ") + lines[1].slice(2);
    if (this.getValue().trimStart().startsWith("!")) lines.push(dim("Local shell / Enter runs directly / no model request"));
    if (this.attachmentLoading) lines.push(dim("Preparing image..."));
    return lines.map((line) => fit(line, width));
  }

  invalidate(): void { this.editor.invalidate(); this.placeholder.invalidate(); }
}
