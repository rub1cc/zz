const baseLines = 3;
const maxLines = 18;
const burstGapMs = 5;
const gestureGapMs = 200;
const referenceGapMs = 100;

/** Accelerate deliberate wheel spins without multiplying tightly batched terminal events. */
export class AdaptiveWheelScroll {
  private lastTime = -Infinity;
  private direction = 0;
  private averageGap?: number;
  private carry = 0;

  next(direction: -1 | 1, now: number): number {
    const gap = now - this.lastTime;
    const sameGesture = direction === this.direction && gap >= 0 && gap <= gestureGapMs;
    this.lastTime = now;
    this.direction = direction;
    if (!sameGesture) {
      this.averageGap = undefined;
      this.carry = 0;
      return baseLines;
    }
    // Native trackpad acceleration and wheel-notch batches already arrive as many events.
    if (gap < burstGapMs) return baseLines;
    this.averageGap = this.averageGap === undefined ? gap : (this.averageGap + gap) / 2;
    const lines = Math.min(maxLines, Math.max(baseLines, baseLines * referenceGapMs / this.averageGap)) + this.carry;
    const whole = Math.floor(lines);
    this.carry = lines - whole;
    return whole;
  }

  reset(): void {
    this.lastTime = -Infinity;
    this.direction = 0;
    this.averageGap = undefined;
    this.carry = 0;
  }
}
