import { describe, expect, it } from 'vitest';
import { ANIMATION_TIMING, motionDuration, stoneMoveDuration } from './animation';

describe('animation timing', () => {
  it('7個目以降は少しだけ高速化する', () => {
    expect(stoneMoveDuration(1, false)).toBe(ANIMATION_TIMING.stoneMove);
    expect(stoneMoveDuration(6, false)).toBe(ANIMATION_TIMING.stoneMove);
    expect(stoneMoveDuration(7, false)).toBe(ANIMATION_TIMING.stoneMoveFast);
  });

  it('reduced motion では待ち時間をなくす', () => {
    expect(motionDuration(ANIMATION_TIMING.capture, true)).toBe(0);
    expect(stoneMoveDuration(8, true)).toBe(0);
  });
});
