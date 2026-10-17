import { Markdown, stripTerminalSequences, truncateToWidth, visibleWidth, type MarkdownTheme } from "@earendil-works/pi-tui";

export const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
export const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
export const accent = (s: string) => `\x1b[36m${s}\x1b[39m`;
export const amber = (s: string) => `\x1b[38;5;214m${s}\x1b[39m`;
export const warning = (s: string) => `\x1b[33m${s}\x1b[39m`;
export const green = (s: string) => `\x1b[32m${s}\x1b[39m`;
export const red = (s: string) => `\x1b[31m${s}\x1b[39m`;
export const plain = (s: string) => stripTerminalSequences(s).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
export const oneLine = (s: string) => plain(s).replace(/\s+/g, " ");
export const fit = (s: string, width: number) => truncateToWidth(s, Math.max(0, width));
export const pad = (s: string, width: number) => s + " ".repeat(Math.max(0, width - visibleWidth(s)));

export const motionEnabled = () => process.env.ZZ_REDUCED_MOTION !== "1" && process.env.NO_COLOR === undefined;

const workingFrames = ["✽", "✻", "✢", "∙", "✢", "✻", "✽"] as const;
export function workingIcon(now = Date.now()): string {
  return workingFrames[motionEnabled() ? Math.floor(now / 160) % workingFrames.length : 0]!;
}

// Terminal equivalent of a linear, two-second highlight sweep over muted text.
export function shimmer(text: string, now = Date.now()): string {
  if (!motionEnabled()) return dim(text);
  const chars = [...text];
  const center = (now % 2000) / 2000 * (chars.length + 6) - 3;
  return chars.map((char, index) => {
    const brightness = Math.round(124 + 116 * Math.max(0, 1 - Math.abs(index - center) / 3));
    return `\x1b[38;2;${brightness};${brightness};${brightness}m${char}`;
  }).join("") + "\x1b[39m";
}

export const markdownTheme: MarkdownTheme = {
  heading: bold, link: accent, linkUrl: dim, code: accent, codeBlock: (s) => s,
  codeBlockBorder: dim, quote: dim, quoteBorder: dim, hr: dim, listBullet: dim,
  bold, italic: (s) => `\x1b[3m${s}\x1b[23m`, strikethrough: dim, underline: (s) => s,
};

export function markdown(text: string, width: number): string[] {
  return new Markdown(plain(text), 0, 0, markdownTheme).render(Math.max(1, width));
}
