import {
  backgroundAnsi, colorToRgb, getTerminalColorMode, mixColors, rgbColor, visibleWidth,
  type RgbColor, type TerminalColorMode,
} from "@earendil-works/pi-tui";

export type DiffChange = "added" | "removed";
const accents = { added: rgbColor(40, 160, 80), removed: rgbColor(210, 65, 75) };
let background: RgbColor | undefined;
let cached: { mode: TerminalColorMode; added: string; removed: string } | undefined;

export function setDiffBackground(color: RgbColor | undefined): boolean {
  if (background?.r === color?.r && background?.g === color?.g && background?.b === color?.b) return false;
  background = color && { ...color };
  cached = undefined;
  return true;
}

export function shadeDiffRow(row: string, width: number, change?: DiffChange): string {
  if (!change || !background || process.env.NO_COLOR !== undefined) return `${row}\x1b[0m`;
  const mode = getTerminalColorMode();
  if (cached?.mode !== mode) {
    const base = rgbColor(background.r, background.g, background.b);
    const channels = [background.r, background.g, background.b];
    const quiet256 = mode === "256color" && Math.max(...channels) < 128 && Math.max(...channels) - Math.min(...channels) < 16;
    const fillFor = (change: DiffChange) => {
      let tint = mixColors(base, accents[change], 0.12, "srgb");
      if (quiet256) {
        // The 256-color cube has no faint dark red/green; use a quiet gray rather than a saturated block.
        const { r, g, b } = colorToRgb(tint);
        const gray = Math.round(r * 0.299 + g * 0.587 + b * 0.114);
        tint = rgbColor(gray, gray, gray);
      }
      return backgroundAnsi(tint, mode);
    };
    cached = { mode, added: fillFor("added"), removed: fillFor("removed") };
  }
  const fill = cached[change];
  const padding = " ".repeat(Math.max(0, width - visibleWidth(row)));
  // A wrapped word can leave inverse active. Close it before painting trailing space.
  return `${fill}${row}\x1b[27m${fill}${padding}\x1b[0m`;
}
