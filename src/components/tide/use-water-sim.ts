import { useCallback, useEffect } from 'react';
import { type FrameInfo, useFrameCallback, useSharedValue, type SharedValue } from 'react-native-reanimated';

// 1D spring-mass water line: see .claude/plans/water-physics.md for the
// research this follows. Columns are fixed so the arrays never reallocate.
const COLUMNS = 28;
const K = 0.025;
const C = 0.09;
/** Neighbour coupling per spread pass. Kept small on purpose: at the frame
 * clamp's worst case (dtScale 2, a dropped-frame catch-up) an explicit-Euler
 * spread above ~0.5 total (SPREAD * SPREAD_PASSES * dtScale) oscillates and
 * grows without bound instead of decaying, a sawtooth of alternating-sign
 * columns that (with nothing clamping height) diverges to unparseable
 * numbers in the svg path. 0.08 * 3 passes * 2 = 0.48 stays under that. */
const SPREAD = 0.08;
const SPREAD_PASSES = 3;
/** Rest line inside the 40px band: above it is sky, at and below it is fill. */
const BASE_Y = 20;
const BAND_BOTTOM = 40;
/** Hard clamp on a column's spring displacement and velocity. A splash or a
 * bad frame can never push the surface past this, so the path string can
 * never contain the huge or non-finite numbers that crashed RNSVGPathParser. */
const MAX_H = 14;
const MAX_V = 8;
/** How gently the boat's y and angle chase the surface under it. */
const BOAT_K = 0.3;
const BOAT_C = 0.15;
/** Where the boat drifts back to when nothing is pushing it. */
const BOAT_HOME_X = 52;
/** Left clamp; the right clamp is `width - 88 - 20` so the boat never enters
 * the cat's 88px zone on the right. */
const BOAT_X_MIN = 36;
const BOAT_X_MARGIN = 88 + 20;
const BOAT_X_DRAG = 1.2;
const BOAT_SLOPE_GAIN = 24;
const BOAT_HOME_SPRING = 0.6;
const BOAT_EDGE_RESTITUTION = 0.4;
/** Tilt's rest-line offset at the band's edges, clamped in pixels rather
 * than in the angle itself: a true level at a real tilt angle would swallow
 * the sentence, so this is a hint, not physics. */
const TILT_EDGE_MAX = 14;
/** Edge velocity a line change's slosh adds. The spring turns velocity v0
 * into a peak of about v0 / sqrt(K), so 0.9 rocks each edge by roughly 6px:
 * visible, never a wave that swallows the sentence. */
const SLOSH_V = 0.9;
/** Below this total surface energy, with nothing poking the water for this
 * long, the frame callback halves its own rate: swell keeps playing at the
 * same visual speed, just redrawn every other frame. */
const CALM_AFTER_MS = 4000;
const CALM_ENERGY = 0.02;
/** Past this long calm, with nothing playing or recording, no touch and no
 * tilt change, the water drops to one drawn frame in IDLE_STRIDE: the swell
 * still drifts, at a fraction of the redraws, until something moves. */
const IDLE_AFTER_MS = 8000;
const IDLE_STRIDE = 6;
/** A tilt change bigger than this (radians) counts as the phone moving. */
const TILT_WAKE = 0.02;

function clamp(x: number, lo: number, hi: number) {
  'worklet';
  return x < lo ? lo : x > hi ? hi : x;
}

/** Writes the springs' rest line from the low-passed tilt angle: a free
 * surface stays level in the world, so a tilted screen sees it lean the
 * other way. Displacement at the edges is clamped in pixels (TILT_EDGE_MAX),
 * not the angle, so a sharp tilt never swallows the sentence. */
function computeRestFromTilt(rest: number[], width: number, tiltRad: number) {
  'worklet';
  const n = rest.length;
  const centre = width / 2;
  if (!(centre > 0)) return;
  // clamp lets NaN through, so a bad tilt reading counts as level.
  const lean = Math.tan(Number.isFinite(tiltRad) ? tiltRad : 0) * centre;
  const edge = clamp(Number.isFinite(lean) ? lean : 0, -TILT_EDGE_MAX, TILT_EDGE_MAX);
  const dx = width / (n - 1);
  for (let i = 0; i < n; i++) {
    const x = i * dx;
    rest[i] = (edge * (x - centre)) / centre;
  }
}

function swell(x: number, t: number) {
  'worklet';
  return 1.6 * Math.sin((2 * Math.PI * x) / 220 - 0.9 * t) + 1.0 * Math.sin((2 * Math.PI * x) / 130 + 1.4 * t);
}

function flatPathString(width: number) {
  'worklet';
  return `M0,${BASE_Y} L${width},${BASE_Y} L${width},${BAND_BOTTOM} L0,${BAND_BOTTOM} Z`;
}

function flatLineString(width: number) {
  'worklet';
  return `M0,${BASE_Y} L${width},${BASE_Y}`;
}

function stepSurface(h: number[], v: number[], rest: number[], dtScale: number) {
  'worklet';
  const n = h.length;
  for (let i = 0; i < n; i++) {
    const a = -K * (h[i] - rest[i]) - C * v[i];
    v[i] += a * dtScale;
    h[i] += v[i] * dtScale;
    // Hitting the clamp absorbs the excess velocity too, like a soft wall,
    // so a column that maxed out does not keep building energy it can never
    // show.
    if (h[i] > MAX_H) {
      h[i] = MAX_H;
      if (v[i] > 0) v[i] = 0;
    } else if (h[i] < -MAX_H) {
      h[i] = -MAX_H;
      if (v[i] < 0) v[i] = 0;
    }
  }
  for (let pass = 0; pass < SPREAD_PASSES; pass++) {
    for (let i = 0; i < n; i++) {
      if (i > 0) v[i - 1] += SPREAD * (h[i] - h[i - 1]) * dtScale;
      if (i < n - 1) v[i + 1] += SPREAD * (h[i] - h[i + 1]) * dtScale;
    }
  }
  for (let i = 0; i < n; i++) {
    v[i] = clamp(v[i], -MAX_V, MAX_V);
  }
}

/** If a frame ever produces a non-finite height or velocity (should not
 * happen now that both are clamped every step, but a NaN from a stray divide
 * would otherwise persist forever since nothing else zeroes it), drop the
 * whole surface back to rest rather than feed the path builder garbage. */
function resetIfUnstable(h: number[], v: number[]) {
  'worklet';
  for (let i = 0; i < h.length; i++) {
    if (!Number.isFinite(h[i]) || !Number.isFinite(v[i])) {
      for (let j = 0; j < h.length; j++) {
        h[j] = 0;
        v[j] = 0;
      }
      return;
    }
  }
}

function sumSquares(v: number[]) {
  'worklet';
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return s;
}

/** Interpolated surface y and local slope at pixel x, swell included. */
function sampleSurface(h: number[], width: number, t: number, x: number) {
  'worklet';
  const n = h.length;
  const dx = width / (n - 1);
  const pos = Math.max(0, Math.min(n - 1, x / dx));
  const i0 = Math.floor(pos);
  const i1 = Math.min(n - 1, i0 + 1);
  const frac = pos - i0;
  const x0 = i0 * dx;
  const x1 = i1 * dx;
  const y0 = clamp(BASE_Y + h[i0] + swell(x0, t), BASE_Y - MAX_H - 4, BAND_BOTTOM);
  const y1 = clamp(BASE_Y + h[i1] + swell(x1, t), BASE_Y - MAX_H - 4, BAND_BOTTOM);
  const y = y0 + (y1 - y0) * frac;
  const slope = i1 === i0 ? 0 : (y1 - y0) / (x1 - x0);
  return { y, slope };
}

/** Builds the surface's `d` strings, both the closed fill path (`path`, the
 * band's box with the surface as its top edge) and the open curve alone
 * (`line`, the same points with no closing box: the light band strokes this
 * one). Every coordinate is clamped into the band first (so a stray value
 * can only ever draw a flat top or bottom, never fly off to a huge or
 * non-finite number) and formatted with `toFixed(2)`, which never emits
 * exponent notation the way `String(1e37)` does; that exponent form is
 * exactly what crashed RNSVGPathParser on device, and Skia's own path
 * parser has the same expectation. */
function buildSurface(h: number[], width: number, t: number) {
  'worklet';
  const n = h.length;
  const dx = width / (n - 1);
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = i * dx;
    const y = clamp(BASE_Y + h[i] + swell(x, t), BASE_Y - MAX_H - 4, BAND_BOTTOM);
    xs.push(x);
    ys.push(y);
  }
  let line = `M${xs[0].toFixed(2)},${ys[0].toFixed(2)}`;
  for (let i = 1; i < n; i++) {
    const mx = (xs[i - 1] + xs[i]) / 2;
    const my = (ys[i - 1] + ys[i]) / 2;
    line += ` Q${xs[i - 1].toFixed(2)},${ys[i - 1].toFixed(2)} ${mx.toFixed(2)},${my.toFixed(2)}`;
  }
  line += ` L${xs[n - 1].toFixed(2)},${ys[n - 1].toFixed(2)}`;
  const path = `${line} L${width.toFixed(2)},${BAND_BOTTOM.toFixed(2)} L0,${BAND_BOTTOM.toFixed(2)} Z`;
  return { path, line };
}

type WaterSim = {
  /** Closed path `d` for the band's fill, rebuilt every stepped frame. */
  pathD: SharedValue<string>;
  /** Open curve `d` for the surface alone, same points as `pathD` with no
   * closing box: the light band strokes this one. */
  lineD: SharedValue<string>;
  /** Surface height at the horizontal centre, relative to the rest line:
   * the glow under the active card rides on it. */
  centreY: SharedValue<number>;
  /** The sim's clock, seconds, for anything animating off the same beat
   * (the caustics shader, the underwater rows' wobble). */
  time: SharedValue<number>;
  /** The boat's bob: y offset and tilt from the surface under it. */
  boatY: SharedValue<number>;
  boatAngle: SharedValue<number>;
  /** The boat's horizontal position, driven by slope, drag and a flick when
   * free, or set directly by a Pan gesture while `boatDragging` is true. */
  boatX: SharedValue<number>;
  boatDragging: SharedValue<boolean>;
  /** Radians, low-passed and written by water-surface.tsx's accelerometer. */
  tilt: SharedValue<number>;
  /** Worklet: call through `runOnUI(splashAt)(x, strength)` from JS, or
   * directly from another worklet. strength 1 is a tap, smaller is a soft
   * splash (a line change). */
  splashAt: (x: number, strength: number) => void;
  /** Worklet: rocks the whole surface side to side once, as if the band
   * were nudged. `direction` (+1 or -1) picks which edge dips first. */
  sloshAt: (direction: number) => void;
  /** JS: something outside the water happened (a touch on the scene, a line
   * change): back to full frame rate. */
  wake: () => void;
  /** Worklet: moves the boat directly, clamped, while a drag gesture holds it. */
  setBoatX: (x: number) => void;
  /** Worklet: gives the boat a release velocity (px/s), clamped. */
  flickBoat: (vx: number) => void;
};

/**
 * The water line's physics: a spring-mass surface plus idle swell, stepped
 * on the UI thread every frame the screen is focused, the app is active and
 * the system has not asked for reduced motion. `width` is the band's pixel
 * width (0 before its first layout, in which case the sim holds still).
 */
export function useWaterSim({
  width,
  enabled,
  reducedMotion,
  busy,
}: {
  width: number;
  enabled: boolean;
  reducedMotion: boolean;
  /** Playing or recording: the water never idles down meanwhile. */
  busy: boolean;
}): WaterSim {
  const h = useSharedValue<number[]>(new Array(COLUMNS).fill(0));
  const v = useSharedValue<number[]>(new Array(COLUMNS).fill(0));
  const rest = useSharedValue<number[]>(new Array(COLUMNS).fill(0));
  const widthSV = useSharedValue(width);
  const t = useSharedValue(0);
  const elapsedMs = useSharedValue(0);
  const lastActivity = useSharedValue(0);
  const frameParity = useSharedValue(0);
  const skippedMs = useSharedValue(0);
  const lastTilt = useSharedValue(0);
  const busySV = useSharedValue(busy);
  const boatVel = useSharedValue(0);
  const boatVelX = useSharedValue(0);

  const pathD = useSharedValue(flatPathString(width));
  const lineD = useSharedValue(flatLineString(width));
  const centreY = useSharedValue(0);
  const boatY = useSharedValue(0);
  const boatAngle = useSharedValue(0);
  const boatX = useSharedValue(BOAT_HOME_X);
  /** True while a drag holds the boat: the frame callback then leaves x
   * alone (the gesture sets it directly) and only keeps bobbing it. */
  const boatDragging = useSharedValue(false);
  /** Radians, low-passed and written by the accelerometer in water-surface.tsx. */
  const tilt = useSharedValue(0);

  useEffect(() => {
    widthSV.value = width;
  }, [width, widthSV]);

  useEffect(() => {
    busySV.value = busy;
    lastActivity.value = elapsedMs.value;
  }, [busy, busySV, lastActivity, elapsedMs]);

  const wake = useCallback(() => {
    lastActivity.value = elapsedMs.value;
  }, [lastActivity, elapsedMs]);

  const setBoatX = (x: number) => {
    'worklet';
    const w = widthSV.value;
    const maxX = w > 0 ? Math.max(BOAT_X_MIN, w - BOAT_X_MARGIN) : BOAT_HOME_X;
    boatX.value = clamp(x, BOAT_X_MIN, maxX);
    lastActivity.value = elapsedMs.value;
  };

  const flickBoat = (vx: number) => {
    'worklet';
    boatVelX.value = clamp(vx, -500, 500);
    lastActivity.value = elapsedMs.value;
  };

  const splashAt = (x: number, strength: number) => {
    'worklet';
    const n = v.value.length;
    const w = widthSV.value;
    if (w <= 0) return;
    const idx = Math.max(0, Math.min(n - 1, Math.round((x / w) * (n - 1))));
    // Tuned so a full-strength tap peaks around 13px (v0 / sqrt(K) with
    // K = 0.025) and decays under a second: the earlier -6 impulse peaked
    // near 40px, the sawtooth Sean saw.
    v.value[idx] += -2.2 * strength;
    if (idx > 0) v.value[idx - 1] += -1.1 * strength;
    if (idx < n - 1) v.value[idx + 1] += -1.1 * strength;
    lastActivity.value = elapsedMs.value;
  };

  const sloshAt = (direction: number) => {
    'worklet';
    const n = v.value.length;
    const sign = direction < 0 ? -1 : 1;
    // A velocity that grows linearly from the centre to each edge, opposite
    // at the two ends: the springs turn it into one rocking tilt that
    // settles in about a second. The linear profile has no curvature, so the
    // neighbour spread leaves it alone and it stays a clean tilt, not waves.
    for (let i = 0; i < n; i++) {
      const across = (2 * i) / (n - 1) - 1;
      v.value[i] = clamp(v.value[i] + SLOSH_V * sign * across, -MAX_V, MAX_V);
    }
    lastActivity.value = elapsedMs.value;
  };

  // Memoised: useFrameCallback re-registers whenever the callback identity
  // changes, and the player screen re-renders on every 50ms status tick.
  // Everything else it reads is a stable shared value or a module worklet.
  const onFrame = useCallback((frameInfo: FrameInfo) => {
    'worklet';
    // A worklet that throws on the UI runtime is not caught anywhere in a
    // release native build (Expo Go): the error aborts the whole app. So a
    // bad frame drops the surface back to rest and skips drawing instead.
    try {
      if (reducedMotion) return;
      const w = widthSV.value;
      if (w <= 0) return;

      const rawDt = frameInfo.timeSincePreviousFrame ?? 16.67;
      // A stall this long only happens on the very first frame or after the
      // app was backgrounded and resumed; step with it and the spring would be
      // fed a huge dt in one shot. Skip stepping, keep last frame's path, and
      // let the next real frame (a normal dt) carry on from rest.
      if (!Number.isFinite(rawDt) || rawDt <= 0 || rawDt > 250) return;

      if (Math.abs(tilt.value - lastTilt.value) > TILT_WAKE) {
        lastTilt.value = tilt.value;
        lastActivity.value = elapsedMs.value;
      }
      const energy = sumSquares(v.value);
      const quietFor = elapsedMs.value - lastActivity.value;
      const calm = !busySV.value && energy < CALM_ENERGY && quietFor > CALM_AFTER_MS;
      const idle = calm && quietFor > IDLE_AFTER_MS;
      elapsedMs.value += rawDt;

      // Calm draws every other frame, idle one in IDLE_STRIDE. The skipped
      // frames' time still reaches the swell's clock on the next drawn frame,
      // so it drifts at the same speed, only redrawn less often.
      const stride = idle ? IDLE_STRIDE : calm ? 2 : 1;
      frameParity.value = (frameParity.value + 1) % stride;
      if (frameParity.value !== 0) {
        skippedMs.value += rawDt;
        return;
      }
      const stepMs = rawDt + skippedMs.value;
      skippedMs.value = 0;

      const dtScale = Math.min(rawDt, 33.34) / 16.67;
      const dtSec = dtScale / 60;
      t.value += stepMs / 1000;

      computeRestFromTilt(rest.value, w, tilt.value);
      stepSurface(h.value, v.value, rest.value, dtScale);
      resetIfUnstable(h.value, v.value);

      const centre = sampleSurface(h.value, w, t.value, w / 2);
      centreY.value = centre.y - BASE_Y;

      // The boat slides down the local slope, drags, and drifts back home;
      // a drag in progress owns x directly instead (setBoatX, from the gesture).
      if (!boatDragging.value) {
        const maxX = Math.max(BOAT_X_MIN, w - BOAT_X_MARGIN);
        const atBoatX = sampleSurface(h.value, w, t.value, boatX.value);
        const accelXPxS2 =
          BOAT_SLOPE_GAIN * atBoatX.slope - BOAT_HOME_SPRING * (boatX.value - BOAT_HOME_X) - BOAT_X_DRAG * boatVelX.value;
        boatVelX.value += accelXPxS2 * dtSec;
        boatX.value += boatVelX.value * dtSec;
        if (boatX.value < BOAT_X_MIN) {
          boatX.value = BOAT_X_MIN;
          boatVelX.value = -boatVelX.value * BOAT_EDGE_RESTITUTION;
        } else if (boatX.value > maxX) {
          boatX.value = maxX;
          boatVelX.value = -boatVelX.value * BOAT_EDGE_RESTITUTION;
        }
      }

      const atBoat = sampleSurface(h.value, w, t.value, boatX.value);
      const targetY = atBoat.y - BASE_Y;
      const boatAccel = BOAT_K * (targetY - boatY.value) - BOAT_C * boatVel.value;
      boatVel.value += boatAccel * dtScale;
      boatY.value += boatVel.value * dtScale;
      boatAngle.value = 0.8 * Math.atan(atBoat.slope);

      const built = buildSurface(h.value, w, t.value);
      pathD.value = built.path;
      lineD.value = built.line;
    } catch {
      const hs = h.value;
      const vs = v.value;
      for (let i = 0; i < hs.length; i++) {
        hs[i] = 0;
        vs[i] = 0;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reducedMotion]);
  // Not auto-started: the effect below turns it on only once the band has a
  // real width, so no frame ever runs against a zero-width surface.
  const frameCallback = useFrameCallback(onFrame, false);

  useEffect(() => {
    frameCallback.setActive(enabled && !reducedMotion && width > 0);
  }, [enabled, reducedMotion, width, frameCallback]);

  useEffect(() => {
    if (!reducedMotion) return;
    pathD.value = flatPathString(width);
    lineD.value = flatLineString(width);
    centreY.value = 0;
    boatY.value = 0;
    boatAngle.value = 0;
    boatX.value = BOAT_HOME_X;
    boatVelX.value = 0;
    boatDragging.value = false;
    tilt.value = 0;
  }, [
    reducedMotion,
    width,
    pathD,
    lineD,
    centreY,
    boatY,
    boatAngle,
    boatX,
    boatVelX,
    boatDragging,
    tilt,
  ]);

  return {
    pathD,
    lineD,
    centreY,
    time: t,
    boatY,
    boatAngle,
    boatX,
    boatDragging,
    tilt,
    splashAt,
    sloshAt,
    wake,
    setBoatX,
    flickBoat,
  };
}
