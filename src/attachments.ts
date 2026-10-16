import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { getImageDimensions, getNativeClipboard, type NativeClipboard } from "@earendil-works/pi-tui";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { DEFAULT_IMAGE_LIMITS, type ImageProcessor } from "@earendil-works/pi-durable/tools";
import type { ImageAttachment } from "./model.js";

export const MAX_ATTACHMENTS = 8;
export const MAX_IMAGE_FILE_BYTES = 20 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
let processor: Promise<ImageProcessor> | undefined;
export function getImageProcessor(): Promise<ImageProcessor> {
  // Buffer.slice() aliases pooled, non-transferable storage. The SDK worker expects Uint8Array.slice() to copy.
  processor ??= createNodePhotonImages().then((images) => ({
    prepare: (bytes, mimeType, limits) => images.prepare(Uint8Array.from(bytes), mimeType, limits),
  }));
  return processor;
}

export function imageMime(bytes: Uint8Array): string | undefined {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 16));
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return "image/jpeg";
  if (/^GIF8[79]a/.test(b.toString("ascii"))) return "image/gif";
  if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (b.toString("ascii", 0, 2) === "BM") return "image/bmp";
}

export function imagePath(value: string): string | undefined {
  const text = value.trim().replace(/^@/, "");
  const path = ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))
    ? text.slice(1, -1) : text.replace(/\\([ \\'"()])/g, "$1");
  return !/[\r\n\x00]/.test(path) && /\.(png|jpe?g|gif|webp|bmp)$/i.test(path) ? path : undefined;
}

export function referencedImages(prompt: string): string[] {
  // Only explicit @image references, not ordinary paths mentioned in prose/code.
  return [...prompt.matchAll(/(?:^|\s)@("[^"\n]+"|'[^'\n]+'|[^\s]+)/g)]
    .map((match) => imagePath(match[1]!)).filter((path): path is string => !!path);
}

export async function prepareImage(bytes: Uint8Array, name = "clipboard image"): Promise<ImageAttachment> {
  if (!bytes.length || bytes.length > MAX_IMAGE_FILE_BYTES) throw new Error("Images must be nonempty and at most 20 MiB before resizing.");
  const mimeType = imageMime(bytes);
  if (!mimeType) throw new Error(`Unsupported image: ${name}. Use PNG, JPEG, GIF, WebP or BMP.`);
  const dimensions = getImageDimensions(Buffer.from(bytes).toString("base64"), mimeType);
  const bmp = mimeType === "image/bmp" && bytes.length >= 26 ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) : undefined;
  const pixels = dimensions ? dimensions.widthPx * dimensions.heightPx : bmp ? Math.abs(bmp.readInt32LE(18) * bmp.readInt32LE(22)) : 0;
  if (pixels > MAX_PIXELS) throw new Error("Image exceeds the 40-megapixel decode limit.");
  const image = await (await getImageProcessor()).prepare(bytes, mimeType, DEFAULT_IMAGE_LIMITS);
  if (!image) throw new Error(`Could not decode or resize image: ${name}`);
  return { type: "image", data: image.data, mimeType: image.mimeType, name };
}

export async function prepareImageFile(value: string, cwd: string): Promise<ImageAttachment> {
  const path = imagePath(value);
  if (!path) throw new Error("Use an image path (PNG, JPEG, GIF, WebP or BMP); quote paths with spaces.");
  const absolute = resolve(cwd, path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path);
  const file = await open(absolute, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_IMAGE_FILE_BYTES) throw new Error("Choose a regular image file of at most 20 MiB.");
    const buffer = Buffer.alloc(Math.min(info.size + 1, MAX_IMAGE_FILE_BYTES + 1));
    let length = 0;
    while (length < buffer.length) {
      const read = await file.read(buffer, length, buffer.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > info.size) throw new Error("Image changed while reading; attach it again.");
    return await prepareImage(buffer.subarray(0, length), basename(absolute));
  } finally { await file.close(); }
}

/** Bounded, shell-free clipboard helpers. Undefined = unavailable; null = empty. */
async function clipboardCommand(command: string, args: string[]): Promise<Buffer | undefined> {
  return new Promise((resolve) => execFile(command, args, { encoding: "buffer", timeout: 2000, maxBuffer: MAX_IMAGE_FILE_BYTES },
    (error, stdout) => resolve(error ? undefined : stdout)));
}

export interface ClipboardContent { images?: ImageAttachment[]; text?: string }
interface ClipboardOptions {
  native?: NativeClipboard | null;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  command?: typeof clipboardCommand;
}
export async function readClipboard(cwd: string, options: ClipboardOptions = {}): Promise<ClipboardContent> {
  const native = options.native === undefined ? getNativeClipboard() : options.native;
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const command = options.command ?? clipboardCommand;
  const files = await native?.getFilePaths?.();
  if (files?.length) {
    if (files.every((file) => imagePath(file))) {
      if (files.length > MAX_ATTACHMENTS) throw new Error(`Attach at most ${MAX_ATTACHMENTS} images per message.`);
      return { images: await Promise.all(files.map((file) => prepareImageFile(file, cwd))) };
    }
    return { text: files.map((file) => JSON.stringify(file)).join(" ") };
  }
  let bytes: Uint8Array | null | undefined;
  let readText = () => native?.getText();
  if (platform === "linux") {
    const wayland = !!env.WAYLAND_DISPLAY || env.XDG_SESSION_TYPE === "wayland";
    const types = wayland ? await command("wl-paste", ["--list-types"]) : undefined;
    const targets = types ?? await command("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"]);
    if (targets !== undefined) {
      const mime = targets.toString().split(/\r?\n/).find((type) => /^image\/(png|jpeg|webp|gif|bmp)$/.test(type));
      bytes = mime ? await command(types !== undefined ? "wl-paste" : "xclip", types !== undefined
        ? ["--type", mime, "--no-newline"] : ["-selection", "clipboard", "-t", mime, "-o"]) : null;
      if (mime && bytes === undefined) throw new Error("Could not read clipboard image. Paste an image path or use @image.png instead.");
      // Read text from the same backend: an empty Wayland clipboard must not use stale X11 data.
      readText = async () => (await command(types !== undefined ? "wl-paste" : "xclip", types !== undefined
        ? ["--no-newline"] : ["-selection", "clipboard", "-o"]))?.toString("utf8");
    }
  }
  if (bytes === undefined) bytes = await native?.getImage();
  if (bytes?.length) return { images: [await prepareImage(bytes)] };
  const text = await readText();
  if (text === undefined) throw new Error("Clipboard unavailable. Use @image.png or paste an image path (on Linux, install wl-clipboard or xclip for Ctrl+V).");
  if (text && imagePath(text) && (/^(?:"[^"\n]+"|'[^'\n]+')$/.test(text.trim()) || !/(?<!\\)\s/.test(text.trim()))) {
    return { images: [await prepareImageFile(text, cwd)] };
  }
  return { text: text ?? "" };
}
