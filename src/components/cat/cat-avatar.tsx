import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { cancelAnimation, useAnimatedStyle, useReducedMotion, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';

import { CatBase } from '@/components/cat/cat-base';
import { CosmeticLayer } from '@/components/cat/cosmetic-layer';
import { ANCHORS, CAT_BOX, SLOTS, Z_ORDER, type ArtSpec, type Equipped, type KagenekoMode, type Slot } from '@/constants/cosmetics';
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
  /** Rive cat only: bump to play the pet reaction. */
  petKey?: number;
  /** Rive cat only: cap the frame rate. */
  frameRate?: number;
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
 */
function SlotLayer({ slot, art, tryOn }: { slot: Slot; art: ArtSpec | null; tryOn: boolean }) {
  const reduced = useReducedMotion();
  const [cur, setCur] = useState(art);
  const [leaving, setLeaving] = useState<ArtSpec | null>(null);
  const scale = useSharedValue(1);
  const opacity = useSharedValue(art ? 1 : 0);
  const outOpacity = useSharedValue(0);
  const prev = useRef({ key: keyOf(art), tryOn, art });
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
    if (p.key !== key && p.art) {
      setLeaving(p.art);
      outOpacity.value = p.tryOn ? PREVIEW_OPACITY : 1;
      outOpacity.value = reduced ? 0 : withTiming(0, { duration: OUT_MS });
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setLeaving(null), reduced ? 0 : OUT_MS + 20);
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
  }, [art, tryOn, reduced, scale, opacity, outOpacity]);

  const style = useAnimatedStyle(() => ({
    opacity: Number.isFinite(opacity.value) ? opacity.value : 1,
    transform: [{ scale: Number.isFinite(scale.value) ? scale.value : 1 }],
  }));
  const outStyle = useAnimatedStyle(() => ({ opacity: Number.isFinite(outOpacity.value) ? outOpacity.value : 0 }));
  const a = ANCHORS[slot];
  const origin = `${a.x}px ${a.y}px` as const;
  return (
    <>
      {leaving ? (
        <Animated.View pointerEvents="none" style={[styles.fill, outStyle]}>
          <CosmeticLayer slot={slot} art={leaving} />
        </Animated.View>
      ) : null}
      {cur ? (
        <Animated.View pointerEvents="none" style={[styles.fill, { transformOrigin: origin }, style]}>
          <CosmeticLayer slot={slot} art={cur} />
        </Animated.View>
      ) : null}
    </>
  );
}

/**
 * The only prop surface of the cat. A later Rive cat takes the same props.
 * Layers draw in Z_ORDER inside a CAT_BOX that is scaled to `size`.
 */
export function CatAvatar({ size, equipped, preview, mode, petKey, frameRate }: CatAvatarProps) {
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
          petKey={petKey}
          frameRate={frameRate}
          onFail={() => setRiveFailed(true)}
        />
      </View>
    );
  }
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
