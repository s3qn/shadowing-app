import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { cancelAnimation, useAnimatedStyle, useReducedMotion, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';

import { CatBase } from '@/components/cat/cat-base';
import { CosmeticLayer } from '@/components/cat/cosmetic-layer';
import { ANCHORS, CAT_BOX, SLOTS, Z_ORDER, type ArtSpec, type Equipped, type KagenekoEmotion, type KagenekoMode, type Slot } from '@/constants/cosmetics';
import { RIVE_AVAILABLE } from '@/lib/rive-available';

// The only door to Rive. kageneko-view is required, never imported, and only
// where the native module exists, so Expo Go never evaluates Nitro.
const Kageneko = (() => {
  if (!RIVE_AVAILABLE) return null;
  try {
    return (require('./kageneko-view') as typeof import('./kageneko-view')).KagenekoView;
  } catch {
    return null;
  }
})();

export type CatAvatarProps = {
  /** Width in pixels. The height follows CAT_BOX. */
  size: number;
  equipped: Equipped;
  /** A try-on: drawn in its slot instead of what is equipped, at half opacity. */
  preview?: { slot: Slot; art: ArtSpec } | null;
  /** Rive cat only: what the cat is doing. Defaults to idle. */
  mode?: KagenekoMode;
  /** Rive cat only: a looping emotion. */
  emotion?: KagenekoEmotion;
  /** Rive cat only: bump to play the pet reaction. */
  petKey?: number;
  /** Rive cat only: cap the frame rate. */
  frameRate?: number;
  /** Rive cat only: follow the live gaze from useGaze. */
  gaze?: boolean;
  /** Draw nothing when Rive is unavailable (web, Expo Go) or failed, instead of the Views placeholder cat. */
  riveOnly?: boolean;
};

const PREVIEW_OPACITY = 0.55;
const LAND = { damping: 18, stiffness: 180 } as const;
const OUT_MS = 120;

const keyOf = (a: ArtSpec | null) => (a ? `${a.shape}|${a.color}|${a.accent}|${a.pattern ?? ''}` : '');

/**
 * One slot's layer. The first art mounts as is. A new equip springs in (scale
 * 0.6 to 1 about the slot anchor, opacity 0 to 1 over 160ms), a try-on only
 * fades in over 120ms, and the replaced art fades out over 120ms before it
 * unmounts. A second change mid-spring retargets the same shared values.
 * The replaced art leaves from the opacity and scale it had at that moment,
 * so an item swapped out mid fade-in never flashes to full, and several
 * quick swaps each fade out on their own instead of cutting the last one.
 */
function SlotLayer({ slot, art, tryOn }: { slot: Slot; art: ArtSpec | null; tryOn: boolean }) {
  const reduced = useReducedMotion();
  const [cur, setCur] = useState(art);
  const [leaving, setLeaving] = useState<Leaving[]>([]);
  const scale = useSharedValue(1);
  const opacity = useSharedValue(art ? 1 : 0);
  const prev = useRef({ key: keyOf(art), tryOn, art });
  const nextId = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  useLayoutEffect(() => {
    const p = prev.current;
    const key = keyOf(art);
    if (p.key === key && p.tryOn === tryOn) return;
    const target = tryOn ? PREVIEW_OPACITY : 1;
    if (p.key !== key && p.art && !reduced) {
      // Read where the outgoing art is right now, before the values retarget.
      const from = Number.isFinite(opacity.value) ? opacity.value : 0;
      const fromScale = Number.isFinite(scale.value) ? scale.value : 1;
      const out = p.art;
      if (from > 0.01) {
        setLeaving((cur) => [...cur, { id: ++nextId.current, art: out, from, scale: fromScale }]);
        // Every leaving layer is faded by OUT_MS. They are dropped together once the burst is over, not one by
        // one: a re-render while the new art is still fading in rewrote its opacity from a stale value on the web.
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setLeaving([]), OUT_MS + 60);
      }
    }
    setCur(art);
    if (art) {
      cancelAnimation(scale);
      cancelAnimation(opacity);
      if (reduced) {
        scale.value = 1;
        opacity.value = target;
      } else if (tryOn) {
        scale.value = 1;
        if (p.key !== key) opacity.value = 0;
        opacity.value = withTiming(target, { duration: 120 });
      } else {
        const same = p.key === key;
        scale.value = same ? 0.9 : 0.6;
        if (!same) opacity.value = 0;
        scale.value = withSpring(1, LAND);
        opacity.value = withTiming(target, { duration: 160 });
      }
    }
    prev.current = { key, tryOn, art };
  }, [art, tryOn, reduced, scale, opacity]);

  const style = useAnimatedStyle(() => ({
    opacity: Number.isFinite(opacity.value) ? opacity.value : 1,
    transform: [{ scale: Number.isFinite(scale.value) ? scale.value : 1 }],
  }));
  const a = ANCHORS[slot];
  const origin = `${a.x}px ${a.y}px` as const;
  return (
    <>
      {leaving.map((l) => (
        <LeavingLayer key={l.id} slot={slot} leave={l} origin={origin} />
      ))}
      {cur ? (
        <Animated.View pointerEvents="none" style={[styles.fill, { transformOrigin: origin }, style]}>
          <CosmeticLayer slot={slot} art={cur} />
        </Animated.View>
      ) : null}
    </>
  );
}

type Leaving = { id: number; art: ArtSpec; from: number; scale: number };

/** Replaced art fading out from where it was (opacity and scale), over OUT_MS scaled by how visible it still was. */
function LeavingLayer({ slot, leave, origin }: { slot: Slot; leave: Leaving; origin: string }) {
  const opacity = useSharedValue(leave.from);
  const { from } = leave;
  const fromScale = Number.isFinite(leave.scale) ? leave.scale : 1;
  useEffect(() => {
    opacity.value = withTiming(0, { duration: Math.max(40, OUT_MS * from) });
  }, [opacity, from]);
  const style = useAnimatedStyle(() => ({
    opacity: Number.isFinite(opacity.value) ? opacity.value : 0,
    transform: [{ scale: fromScale }],
  }));
  return (
    <Animated.View pointerEvents="none" style={[styles.fill, { transformOrigin: origin }, style]}>
      <CosmeticLayer slot={slot} art={leave.art} />
    </Animated.View>
  );
}

/**
 * The only prop surface of the cat. A later Rive cat takes the same props.
 * Layers draw in Z_ORDER inside a CAT_BOX that is scaled to `size`.
 */
export function CatAvatar({ size, equipped, preview, mode, emotion, petKey, frameRate, gaze, riveOnly }: CatAvatarProps) {
  const [riveFailed, setRiveFailed] = useState(false);
  const scale = size / CAT_BOX.w;
  const h = CAT_BOX.h * scale;
  if (Kageneko && !riveFailed) {
    return (
      <View style={{ width: size, height: h }}>
        <Kageneko
          size={size}
          equipped={preview ? { ...equipped, [preview.slot]: preview.art } : equipped}
          mode={mode ?? 'idle'}
          emotion={emotion}
          petKey={petKey}
          frameRate={frameRate}
          gaze={gaze}
          onFail={() => setRiveFailed(true)}
        />
      </View>
    );
  }
  if (riveOnly) return null;
  return (
    <View style={{ width: size, height: h }}>
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: -(CAT_BOX.w - size) / 2,
          top: -(CAT_BOX.h - h) / 2,
          width: CAT_BOX.w,
          height: CAT_BOX.h,
          transform: [{ scale }],
        }}>
        {Z_ORDER.map((layer) => {
          if (layer === 'base') return <CatBase key="base" />;
          if (!SLOTS.includes(layer)) return null;
          const tryOn = preview && preview.slot === layer ? preview.art : null;
          return <SlotLayer key={layer} slot={layer} art={tryOn ?? equipped[layer] ?? null} tryOn={!!tryOn} />;
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({ fill: { position: 'absolute', left: 0, top: 0, width: CAT_BOX.w, height: CAT_BOX.h } });
