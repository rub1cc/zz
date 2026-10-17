import assert from "node:assert/strict";
import { test } from "node:test";
import { AdaptiveWheelScroll } from "../src/scroll.js";

test("wheel speed follows gesture velocity with a bounded multiplier", () => {
  for (const [gap, expected] of [[250, 3], [100, 3], [50, 6], [20, 15], [10, 18], [5, 18]] as const) {
    const wheel = new AdaptiveWheelScroll();
    assert.equal(wheel.next(-1, 0), 3);
    assert.equal(wheel.next(-1, gap), expected, `${gap}ms between wheel events`);
    for (let i = 2; i < 30; i++) assert.ok(wheel.next(-1, gap * i) <= 18);
  }
});

test("pauses, reversals and explicit resets restore precise base scrolling", () => {
  const wheel = new AdaptiveWheelScroll();
  assert.equal(wheel.next(-1, 0), 3);
  assert.equal(wheel.next(-1, 50), 6);
  assert.equal(wheel.next(1, 100), 3);
  assert.equal(wheel.next(1, 150), 6);
  assert.equal(wheel.next(1, 400), 3);
  assert.equal(wheel.next(1, 450), 6);
  wheel.reset();
  assert.equal(wheel.next(1, 460), 3);
  assert.equal(wheel.next(1, 510), 6);
  assert.equal(wheel.next(1, 500), 3, "A clock discontinuity must not accelerate scrolling");
});

test("tightly batched native events do not receive additional acceleration", () => {
  const wheel = new AdaptiveWheelScroll();
  for (let i = 0; i < 100; i++) assert.equal(wheel.next(-1, i * 4), 3);
  assert.equal(wheel.next(-1, 446), 6);
  assert.equal(wheel.next(-1, 447), 3, "A burst stays precise even after an accelerated wheel event");
});

test("slowing a gesture reduces acceleration and fractional distances carry between events", () => {
  const wheel = new AdaptiveWheelScroll();
  assert.equal(wheel.next(-1, 0), 3);
  assert.equal(wheel.next(-1, 50), 6);
  assert.equal(wheel.next(-1, 200), 3);
  wheel.reset();
  assert.equal(wheel.next(-1, 0), 3);
  assert.equal(wheel.next(-1, 80), 3);
  assert.equal(wheel.next(-1, 160), 4);
  assert.equal(wheel.next(-1, 240), 4);
  assert.equal(wheel.next(-1, 320), 4);
});
