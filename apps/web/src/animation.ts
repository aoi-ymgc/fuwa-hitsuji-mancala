export const ANIMATION_TIMING = {
  stoneMove: 190,
  stoneMoveFast: 150,
  stoneLanding: 120,
  extraTurn: 1000,
  capturePause: 250,
  capture: 700,
  resultDelay: 500,
} as const;

export function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function motionDuration(duration: number, reducedMotion = prefersReducedMotion()) {
  return reducedMotion ? 0 : duration;
}

export function stoneMoveDuration(stoneNumber: number, reducedMotion = prefersReducedMotion()) {
  return motionDuration(stoneNumber >= 7 ? ANIMATION_TIMING.stoneMoveFast : ANIMATION_TIMING.stoneMove, reducedMotion);
}

export function waitForAnimation(duration: number, reducedMotion = prefersReducedMotion()) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, motionDuration(duration, reducedMotion)));
}
