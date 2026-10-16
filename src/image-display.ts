import { convertToPng } from "@earendil-works/pi-coding-agent";
import { getCapabilities, Image } from "@earendil-works/pi-tui";
import type { ImageAttachment } from "./model.js";
import { dim, oneLine } from "./format.js";

/** Keep native image components/IDs stable across streaming redraws; non-image terminals get Pi's fallback. */
export class ImageDisplay {
  private cache = new Map<string, { source: ImageAttachment; view: Image; converting?: boolean }>();
  constructor(readonly changed: () => void) {}

  render(images: ImageAttachment[], key: string, width: number): string[] {
    return images.flatMap((image, index) => {
      const id = `${key}:${index}`;
      let cached = this.cache.get(id);
      if (!cached || cached.source.data !== image.data || cached.source.mimeType !== image.mimeType) {
        cached = { source: image, view: this.component(image) };
        this.cache.set(id, cached);
      }
      if (getCapabilities().images === "kitty" && image.mimeType !== "image/png" && !cached.converting) {
        const entry = cached;
        entry.converting = true;
        void convertToPng(image.data, image.mimeType).then((png) => {
          if (png && this.cache.get(id) === entry) { entry.view = this.component({ ...image, ...png }); this.changed(); }
        }).catch(() => { /* Retain the safe textual fallback if conversion is unavailable. */ });
      }
      return cached.view.render(Math.max(1, width));
    });
  }

  private component(image: ImageAttachment): Image {
    return new Image(image.data, image.mimeType, { fallbackColor: dim }, {
      filename: image.name && oneLine(image.name), maxWidthCells: 60, maxHeightCells: 16,
    });
  }

  clear(): void { this.cache.clear(); }
  invalidate(): void { for (const { view } of this.cache.values()) view.invalidate(); }
}
