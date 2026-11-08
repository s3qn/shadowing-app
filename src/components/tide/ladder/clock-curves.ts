// The count-in's curves as pure functions of time (recipe "How we compose a hard animation",
// .claude/plans/countin-drops-recipe.md): every part of the count is a worklet of one clock,
// so nothing has its own timer, nothing drifts, and a skip is one retiming of the clock.
// The same maths as the board's `sp`, `wob`, `OUT`, `IOS` in research/pre-animator/countin-drops.

export function clamp(x: number): number {
  'worklet';
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Easing.out(cubic) as a function, clamped to 0..1. */
export function OUT(x: number): number {
  'worklet';
  const c = 1 - clamp(x);
  return 1 - c * c * c;
}

/** Easing.inOut(sin) as a function, clamped to 0..1. */
export function IOS(x: number): number {
  'worklet';
  return -(Math.cos(Math.PI * clamp(x)) - 1) / 2;
}

/** Easing.inOut(cubic) as a function, clamped to 0..1 (the welcome board's `IOC`). */
export function IOC(x: number): number {
  'worklet';
  const c = clamp(x);
  return c < 0.5 ? 4 * c * c * c : 1 - Math.pow(-2 * c + 2, 3) / 2;
}

export function lerp(a: number, b: number, k: number): number {
  'worklet';
  return a + (b - a) * k;
}

/** Reanimated's withSpring (mass 1) in closed form: 0 before `ms` 0, 1 once settled. */
export function springAt(ms: number, damping: number, stiffness: number): number {
  'worklet';
  if (!(ms > 0)) return 0;
  const t = ms / 1000;
  const w = Math.sqrt(stiffness);
  const z = damping / (2 * w);
  if (z < 1) {
    const wd = w * Math.sqrt(1 - z * z);
    return 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + ((z * w) / wd) * Math.sin(wd * t));
  }
  return 1 - Math.exp(-w * t) * (1 + w * t);
}

/** A damped wobble: amp e^(-ms/tau) sin(2 pi ms / period), 0 before `ms` 0. */
export function wob(ms: number, amp: number, tau: number, period: number): number {
  'worklet';
  return ms > 0 ? amp * Math.exp(-ms / tau) * Math.sin((2 * Math.PI * ms) / period) : 0;
}
