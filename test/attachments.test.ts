import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { getCapabilities, getImageDimensions, setCapabilities, stripTerminalSequences, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { imageMime, imagePath, MAX_IMAGE_FILE_BYTES, prepareImage, prepareImageFile, readClipboard, referencedImages } from "../src/attachments.js";
import { Composer } from "../src/composer.js";
import { Controller } from "../src/controller.js";
import { ImageDisplay } from "../src/image-display.js";
import type { ImageAttachment, Session } from "../src/model.js";
import { isImages, Store } from "../src/store.js";
import { Dashboard } from "../src/ui.js";
import { FakeEngine, FakeTerminal, temporary, tick } from "./helpers.js";
import { image, png } from "./image-fixtures.js";

const until = async (predicate: () => boolean) => {
  const end = Date.now() + 5000;
  while (!predicate()) { assert.ok(Date.now() < end, "Timed out"); await new Promise((resolve) => setTimeout(resolve, 5)); }
};

test("real image preparation validates formats, project-relative paths and resizes large dimensions", async () => {
  const f = temporary();
  try {
    const a = join(f.root, "a"); const b = join(f.root, "b"); mkdirSync(a); mkdirSync(b);
    writeFileSync(join(a, "space image.png"), png(4000, 4));
    writeFileSync(join(b, "space image.png"), png(2, 2));
    const first = await prepareImageFile('"space image.png"', a);
    const second = await prepareImageFile("space\\ image.png", b);
    assert.equal(first.name, "space image.png");
    assert.equal(imageMime(Buffer.from(first.data, "base64")), first.mimeType);
    assert.ok(getImageDimensions(first.data, first.mimeType)!.widthPx <= 2000);
    assert.equal(getImageDimensions(second.data, second.mimeType)!.widthPx, 2);
    assert.ok(isImages([first, second]));
    assert.deepEqual(referencedImages('Review @"space image.png" and @other.jpg but leave @README.md as a path'), ["space image.png", "other.jpg"]);
    assert.equal(imagePath("'photo.png'"), "photo.png");
    assert.equal(imagePath("not an image.txt"), undefined);
  } finally { f.cleanup(); }
});

test("invalid, oversized, truncated and non-regular images are refused without sending model input", async () => {
  const f = temporary();
  try {
    writeFileSync(join(f.root, "fake.png"), "not an image"); mkdirSync(join(f.root, "directory.png"));
    await assert.rejects(prepareImageFile("fake.png", f.root), /Unsupported image/);
    await assert.rejects(prepareImageFile("directory.png", f.root), /regular image/);
    await assert.rejects(prepareImage(Buffer.alloc(MAX_IMAGE_FILE_BYTES + 1)), /20 MiB/);
    await assert.rejects(prepareImage(png().subarray(0, 16)), /decode|resize/);
    const oversizedHeader = png(); oversizedHeader.writeUInt32BE(100_000, 16); oversizedHeader.writeUInt32BE(100_000, 20);
    await assert.rejects(prepareImage(oversizedHeader), /40-megapixel/);
    assert.equal(isImages([{ ...image, data: "not-base64!" }]), false);
    assert.equal(isImages(Array(9).fill(image)), false);
  } finally { f.cleanup(); }
});

function composer(file: (path: string, cwd: string) => Promise<ImageAttachment> = async () => image) {
  const errors: unknown[] = [];
  const tui = new TuiAltScreen(new FakeTerminal());
  const input = new Composer(tui, "describe a task", (error) => errors.push(error), async (text) => text,
    { file, clipboard: async () => ({ images: [image] }) });
  input.setDiscovery({ cwd: process.cwd(), session: false, commands: true });
  return { input, tui, errors };
}

test("clipboard and dragged paths insert image tags; sends clear them, rejections preserve them, and Backspace removes whole tags", async () => {
  const { input, errors } = composer();
  const sent: { text: string; images: ImageAttachment[] }[] = [];
  input.onSubmit = (text, images = []) => { sent.push({ text, images }); return false; };
  input.handleInput("\x16"); await until(() => !input.attachmentLoading);
  assert.equal(input.images.length, 1); assert.equal(sent.length, 0);
  assert.equal(input.getValue(), "[Image #1]");
  input.handleInput("\x16"); await until(() => !input.attachmentLoading);
  assert.equal(input.images.length, 2);
  assert.equal(input.getValue(), "[Image #1][Image #2]");
  input.setValue("explain this"); input.handleInput("\r");
  assert.equal(input.getValue(), "explain this [Image #1] [Image #2]"); assert.equal(input.images.length, 2);
  input.onSubmit = (text, images = []) => { sent.push({ text, images }); return true; };
  input.handleInput("\r"); assert.equal(input.images.length, 0);
  input.handleInput('\x1b[200~"/tmp/space image.png"\x1b[201~'); await until(() => !input.attachmentLoading);
  assert.equal(input.images.length, 1); assert.equal(input.getValue(), "[Image #1]");
  input.handleInput("caption"); input.handleInput("\x7f");
  assert.equal(input.getValue(), "[Image #1]captio"); assert.equal(input.images.length, 1, "Text editing must not remove images");
  input.setValue(""); input.handleInput("\x7f"); assert.equal(input.images.length, 0);
  await input.attachFile("sample.png"); await input.attachFile("sample.png");
  input.handleInput("\x7f"); assert.equal(input.images.length, 1);
  input.handleInput("\x7f"); assert.equal(input.images.length, 0);
  assert.deepEqual(errors, []);
});

test("attachment loading blocks sends; late results and image drafts cannot leak into a different session", async () => {
  let finish!: (image: ImageAttachment) => void;
  const { input } = composer(() => new Promise((resolve) => { finish = resolve; }));
  input.setAttachmentScope("session:a"); input.setValue("draft A");
  input.onSubmit = () => { assert.fail("No submission while image preparation is in progress"); };
  const pending = input.attachFile("sample.png"); input.handleInput("\r");
  assert.equal(input.getValue(), "draft A");
  input.setAttachmentScope("session:b"); finish(image); await pending;
  assert.deepEqual(input.images, []);
  const first = input.attachFile("sample.png"); finish(image); await first;
  assert.equal(input.images.length, 1);
  input.setAttachmentScope("session:a"); assert.equal(input.images.length, 0);
  input.setAttachmentScope("session:b"); assert.equal(input.images.length, 1);
  for (const width of [1, 8, 24, 80]) assert.ok(input.render(width).every((line) => visibleWidth(line) <= width));
});

test("native image rendering preserves inline protocol data and stable IDs, with a readable fallback", () => {
  const previous = getCapabilities();
  const display = new ImageDisplay(() => {});
  try {
    setCapabilities({ images: null, trueColor: true, hyperlinks: false });
    assert.match(display.render([image], "image", 80).map(stripTerminalSequences).join("\n"), /sample.png/);
    display.clear(); setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
    const first = display.render([image], "image", 80);
    assert.ok(first[0]?.includes("\x1b_G"));
    assert.deepEqual(display.render([image], "image", 80), first);
  } finally { setCapabilities(previous); }
});

test("image-only dashboard sends target the selected project, preserve command drafts, and isolate attachments on navigation", async () => {
  const f = temporary(); const previous = getCapabilities();
  const store = new Store(join(f.root, "data")); const project = store.addProject(f.root);
  const engine = new FakeEngine(); const c = new Controller(store, engine);
  const terminal = new FakeTerminal(); const tui = new TuiAltScreen(terminal, false);
  const app = new Dashboard(c, tui, () => {});
  tui.setLayoutRoot(app); tui.setFocus(app); tui.start(); app.sync();
  try {
    writeFileSync(join(f.root, "sample.png"), png());
    await app.composer.attachFile("sample.png");
    app.composer.setValue("/model"); terminal.onInput("\r"); await tick(); terminal.onInput("\x1b");
    assert.equal(app.composer.images.length, 1, "UI commands must not clear image drafts");
    app.composer.setValue(""); terminal.onInput("\r"); await tick();
    assert.equal(engine.calls.length, 1); assert.equal(engine.calls[0]?.project.id, project.id);
    assert.equal(engine.calls[0]?.images?.length, 1); assert.equal(app.composer.images.length, 0);
    c.open();
    setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
    const lines = app.body.render(80);
    assert.ok(lines.some((line) => line.includes("\x1b_G")), "Protocol data must survive transcript and layout truncation");
    assert.ok(lines.join("").includes(image.data));
    await app.composer.attachFile("sample.png"); c.back(); assert.equal(app.composer.images.length, 0);
    c.open(); assert.equal(app.composer.images.length, 1);
    assert.doesNotThrow(() => new Store(store.root));
  } finally { setCapabilities(previous); await c.close(); tui.stop(); f.cleanup(); }
});

test("image and thinking presentation caches round-trip; malformed persisted payloads are not overwritten", () => {
  const f = temporary();
  try {
    const store = new Store(f.root); const p = store.addProject(f.root);
    const s: Session = { id: "images", projectId: p.id, title: "Images", status: "paused", preview: "", createdAt: 1, updatedAt: 1,
      messages: [{ role: "thinking", text: "Reasoning text", thinking: { id: "thinking:1" }, timestamp: 1 },
        { role: "user", text: "Look", images: [image], timestamp: 2 }],
      pendingInput: { requestId: "request", prompt: "look", images: [image], prepared: { content: "look" } } };
    store.state.sessions.push(s); store.state.settings = { replyBehavior: "steer", showThinking: false }; store.save();
    assert.deepEqual(new Store(f.root).state.sessions[0], s);
    assert.equal(new Store(f.root).settings.showThinking, false);
    s.messages[1]!.images![0] = { ...image, data: "invalid!" }; store.save();
    const original = readFileSync(store.file, "utf8");
    assert.throws(() => new Store(f.root), /Invalid zz state/);
    assert.equal(readFileSync(store.file, "utf8"), original);
  } finally { f.cleanup(); }
});

test("clipboard adapters read native images and copied files without relying on terminal paste behavior", async () => {
  const f = temporary();
  try {
    const native = { getText: async () => null, getImage: async () => png() };
    const pasted = await readClipboard(f.root, { platform: "darwin", native });
    assert.equal(pasted.images?.[0]?.data, image.data);
    writeFileSync(join(f.root, "copied image.png"), png());
    const files = await readClipboard(f.root, { platform: "darwin", native: { ...native, getFilePaths: async () => [join(f.root, "copied image.png")] } });
    assert.equal(files.images?.[0]?.name, "copied image.png");
    const text = await readClipboard(f.root, { platform: "darwin", native: { getImage: async () => null, getText: async () => "describe the picture.png" } });
    assert.deepEqual(text, { text: "describe the picture.png" }, "Prose ending in an image extension is not an attachment");
  } finally { f.cleanup(); }
});

test("Wayland clipboard images and text stay on the active backend, never stale X11 contents", async () => {
  const commands: string[] = [];
  const native = { getText: async () => { assert.fail("Must not read stale native/X11 text"); }, getImage: async () => { assert.fail("Must not read stale native/X11 image"); } };
  const text = await readClipboard(process.cwd(), { platform: "linux", env: { WAYLAND_DISPLAY: "wayland-1" }, native,
    command: async (command, args) => { commands.push(command); return Buffer.from(args.includes("--list-types") ? "text/plain\n" : "current Wayland text"); } });
  assert.deepEqual(text, { text: "current Wayland text" }); assert.ok(commands.every((command) => command === "wl-paste"));
  const picture = await readClipboard(process.cwd(), { platform: "linux", env: { WAYLAND_DISPLAY: "wayland-1" }, native,
    command: async (_command, args) => args.includes("--list-types") ? Buffer.from("image/png\n") : png() });
  assert.equal(picture.images?.[0]?.data, image.data);
  await assert.rejects(readClipboard(process.cwd(), { platform: "linux", env: { WAYLAND_DISPLAY: "wayland-1" }, native,
    command: async (_command, args) => args.includes("--list-types") ? Buffer.from("image/png\n") : undefined }), /Could not read clipboard image/);
});

test("unavailable clipboard reports image reference guidance rather than silently dropping the paste", async () => {
  await assert.rejects(readClipboard(process.cwd(), { platform: "linux", native: null, env: {}, command: async () => undefined }), /Clipboard unavailable.*@image/);
});

test("image tags insert at the cursor among multiline captions and send images in reference order", async () => {
  const { input, errors } = composer(async (name) => ({ ...image, name }));
  input.handleInput("while i am typing like this: ");
  await input.attachFile("first.png");
  input.handleInput(" and also can add multiple line like this");
  input.handleInput("\x0a"); input.handleInput("\x0a");
  await input.attachFile("second.png");
  input.handleInput("\x0a"); input.handleInput("\x0a");
  input.handleInput("above is the second attached image.");
  const text = "while i am typing like this: [Image #1] and also can add multiple line like this\n\n[Image #2]\n\nabove is the second attached image.";
  assert.equal(input.getValue(), text);
  assert.match(input.render(100).map(stripTerminalSequences).join("\n"), /\[Image #2\]/);
  assert.doesNotMatch(input.render(100).map(stripTerminalSequences).join("\n"), /attached \/|Image 1:/);
  input.onSubmit = (prompt, images) => {
    assert.equal(prompt, text);
    assert.deepEqual(images?.map((image) => image.name), ["first.png", "second.png"]);
    return true;
  };
  input.handleInput("\r");
  assert.equal(input.getValue(), ""); assert.deepEqual(input.images, []);
  assert.deepEqual(errors, []);
});

test("Backspace removes a middle image tag and payload atomically; undo restores both and the caret", async () => {
  const { input } = composer(async (name) => ({ ...image, name }));
  input.handleInput("before "); await input.attachFile("first.png");
  input.handleInput(" after"); input.handleInput("\x0a"); await input.attachFile("second.png");
  input.handleInput(" end");
  input.handleInput("\x01"); input.handleInput("\x1b[D"); // End of the preceding line.
  for (let i = 0; i < " after".length; i++) input.handleInput("\x1b[D");
  input.handleInput("\x7f");
  assert.equal(input.getValue(), "before  after\n[Image #2] end");
  assert.deepEqual(input.images.map((image) => image.name), ["second.png"]);
  input.handleInput("X");
  assert.equal(input.getValue(), "before X after\n[Image #2] end");
  input.handleInput("\x1f"); input.handleInput("\x1f");
  assert.equal(input.getValue(), "before [Image #1] after\n[Image #2] end");
  assert.deepEqual(input.images.map((image) => image.name), ["first.png", "second.png"]);
  input.handleInput("\x7f");
  assert.equal(input.getValue(), "before  after\n[Image #2] end");
});

test("arrows cross image tags as units, forward delete removes them, and unbound literal tags stay normal text", async () => {
  const { input } = composer();
  input.handleInput("left "); await input.attachFile("sample.png"); input.handleInput(" right");
  for (let i = 0; i < " right".length; i++) input.handleInput("\x1b[D");
  input.handleInput("\x1b[D"); input.handleInput("!");
  assert.equal(input.getValue(), "left ![Image #1] right");
  input.handleInput("\x1b[C"); input.handleInput("?");
  assert.equal(input.getValue(), "left ![Image #1]? right");
  input.handleInput("\x7f"); input.handleInput("\x1b[D"); input.handleInput("\x1b[3~");
  assert.equal(input.getValue(), "left ! right"); assert.deepEqual(input.images, []);
  input.setValue("literal [Image #99]"); input.handleInput("\x7f");
  assert.equal(input.getValue(), "literal [Image #99");
});

test("inline image insertion in the middle of text is one undoable operation", async () => {
  const { input } = composer();
  input.setValue("before after");
  for (let i = 0; i < "after".length; i++) input.handleInput("\x1b[D");
  await input.attachFile("sample.png");
  assert.equal(input.getValue(), "before [Image #1]after");
  input.handleInput("\x1f");
  assert.equal(input.getValue(), "before after"); assert.deepEqual(input.images, []);
  await input.attachFile("sample.png");
  assert.equal(input.getValue(), "before [Image #2]after");
  assert.equal(input.images.length, 1);
});

test("image tag deletion preserves collapsed multiline paste content and Unicode, including through undo", async () => {
  const { input } = composer();
  const pasted = Array.from({ length: 30 }, (_, i) => `line ${i} \u65e5\u672c\u8a9e \u{1f9d1}\u200d\u{1f4bb}`).join("\n");
  input.handleInput(`\x1b[200~${pasted}\x1b[201~`);
  input.handleInput("\x0a"); await input.attachFile("sample.png");
  input.handleInput(" suffix");
  for (let i = 0; i < " suffix".length; i++) input.handleInput("\x1b[D");
  input.handleInput("\x7f");
  assert.equal(input.getValue(), `${pasted}\n suffix`); assert.deepEqual(input.images, []);
  input.handleInput("!");
  assert.equal(input.getValue(), `${pasted}\n! suffix`);
  input.handleInput("\x1f"); input.handleInput("\x1f");
  assert.equal(input.getValue(), `${pasted}\n[Image #1] suffix`);
  assert.equal(input.images.length, 1);
});

test("scope changes restore complete inline drafts and never share image payloads or undo history", async () => {
  const { input } = composer(async (name) => ({ ...image, name }));
  input.setAttachmentScope("session:a");
  input.handleInput("A "); await input.attachFile("a.png");
  input.setAttachmentScope("session:b");
  assert.equal(input.getValue(), ""); assert.equal(input.images.length, 0);
  input.handleInput("\x1f"); assert.equal(input.getValue(), "");
  input.handleInput("B"); input.handleInput("\x0a"); await input.attachFile("b.png");
  input.setAttachmentScope("session:a");
  assert.equal(input.getValue(), "A [Image #1]");
  assert.deepEqual(input.images.map((image) => image.name), ["a.png"]);
  input.setAttachmentScope("session:b");
  assert.equal(input.getValue(), "B\n[Image #1]");
  assert.deepEqual(input.images.map((image) => image.name), ["b.png"]);
});

test("commands omit image tags but restore them afterward; image-only sends retain the default request", async () => {
  const { input } = composer();
  await input.attachFile("sample.png");
  const sent: string[] = [];
  input.onSubmit = (text) => { sent.push(text.trim()); return "command"; };
  input.handleInput("!pwd"); input.handleInput("\r");
  assert.deepEqual(sent, ["!pwd"]);
  assert.equal(input.getValue(), "[Image #1]"); assert.equal(input.images.length, 1);
  input.setValue("/model"); input.handleInput("\r");
  assert.deepEqual(sent, ["!pwd", "/model"]);
  assert.equal(input.getValue(), "[Image #1]");
  input.onSubmit = (text, images) => {
    assert.equal(text.trim(), ""); assert.equal(images?.length, 1); return true;
  };
  input.handleInput("\r");
  assert.equal(input.getValue(), ""); assert.deepEqual(input.images, []);
});

test("removing tags in the external editor removes attachments, and undo can restore them", async () => {
  const tui = new TuiAltScreen(new FakeTerminal());
  const input = new Composer(tui, "describe a task", (error) => { throw error; },
    async (text) => text.replace("[Image #1]", ""),
    { file: async () => image, clipboard: async () => ({}) });
  input.handleInput("caption "); await input.attachFile("sample.png");
  await input.openEditor();
  assert.equal(input.getValue(), "caption "); assert.deepEqual(input.images, []);
  input.handleInput("\x1f");
  assert.equal(input.getValue(), "caption [Image #1]"); assert.equal(input.images.length, 1);
});

test("image limits count active tags, failed loads preserve drafts, and literal tags never bind to new images", async () => {
  const { input, errors } = composer(async (name) => {
    if (name === "bad.png") throw new Error("Could not decode");
    return { ...image, name };
  });
  input.handleInput("literal [Image #1] ");
  await input.attachFile("first.png");
  assert.equal(input.getValue(), "literal [Image #1] [Image #2]");
  await input.attachFile("bad.png");
  assert.equal(input.getValue(), "literal [Image #1] [Image #2]"); assert.equal(input.images.length, 1);
  for (let i = 0; i < 7; i++) await input.attachFile(`${i}.png`);
  const draft = input.getValue();
  await input.attachFile("overflow.png");
  assert.equal(input.getValue(), draft); assert.equal(input.images.length, 8);
  input.handleInput("\x7f"); assert.equal(input.images.length, 7);
  await input.attachFile("replacement.png"); assert.equal(input.images.length, 8);
  assert.equal(errors.length, 2);
});

test("multiple clipboard images insert together and follow tag order when submitted", async () => {
  const tui = new TuiAltScreen(new FakeTerminal());
  const input = new Composer(tui, "describe a task", (error) => { throw error; }, async (text) => text,
    { file: async () => image, clipboard: async () => ({ images: [{ ...image, name: "first.png" }, { ...image, name: "second.png" }] }) });
  input.handleInput("compare ");
  await input.pasteClipboard();
  assert.equal(input.getValue(), "compare [Image #1] [Image #2]");
  input.handleInput("\x1f");
  assert.equal(input.getValue(), "compare "); assert.equal(input.images.length, 0);
  await input.pasteClipboard();
  input.setValue("[Image #4] is above [Image #3]");
  input.onSubmit = (text, images) => {
    assert.equal(text, "[Image #4] is above [Image #3]");
    assert.deepEqual(images?.map((image) => image.name), ["second.png", "first.png"]);
    return true;
  };
  input.handleInput("\r");
});

test("submission navigation never clears or restores tags into a different scope", async () => {
  const { input } = composer(async (name) => ({ ...image, name }));
  input.setAttachmentScope("session:b"); input.handleInput("B "); await input.attachFile("b.png");
  input.setAttachmentScope("session:a"); input.handleInput("A "); await input.attachFile("a.png");
  input.onSubmit = () => { input.setAttachmentScope("session:b"); return true; };
  input.handleInput("\r");
  assert.equal(input.getValue(), "B [Image #1]");
  assert.deepEqual(input.images.map((image) => image.name), ["b.png"]);
  input.setAttachmentScope("session:a");
  assert.equal(input.getValue(), ""); assert.equal(input.images.length, 0);
});
