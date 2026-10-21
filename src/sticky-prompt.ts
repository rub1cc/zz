import type { Component, ScrollView, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { dim, fit, oneLine } from "./format.js";
import type { Transcript } from "./transcript.js";

/** Uses transcript row positions, never saved prompt metadata or a separate scroll model. */
export class StickyPrompt implements Component {
  private target?: number;
  private lastKey = "";

  constructor(
    private readonly transcript: Transcript,
    private readonly scroll: ScrollView,
    private readonly enabled: () => boolean,
    private readonly changed: () => void,
  ) {}

  private current(): [number, string] | undefined {
    if (!this.enabled() || this.scroll.isFollowingEnd || this.scroll.viewportHeight < 2
      || this.scroll.scrollTop + this.scroll.viewportHeight >= this.transcript.lineCount) return;
    const prompts = [...this.transcript.prompts];
    const prompt = prompts.findLast(([line]) => line <= this.scroll.scrollTop);
    return prompt && prompt[0] < this.scroll.scrollTop ? prompt : undefined;
  }

  refresh(): void {
    const current = this.current();
    const key = current ? `${current[0]}:${current[1]}` : "";
    if (key !== this.lastKey) this.changed();
  }

  render(width: number): string[] {
    const current = this.current();
    this.target = current?.[0];
    this.lastKey = current ? `${current[0]}:${current[1]}` : "";
    if (!current || width < 1) return [];
    return [dim(fit(`\u276f ${oneLine(current[1])}`, width))];
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.target === undefined || event.type !== "click" || event.button !== "left") return;
    this.scroll.scrollTo(this.target, { disableFollow: true });
    this.changed();
    return { handled: true, render: true };
  }

  invalidate(): void {}
}
