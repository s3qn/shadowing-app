import { memo, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { type LayoutChangeEvent, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  makeMutable,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import { Frost } from '@/components/frost';
import { tide } from '@/constants/theme';
import type { RevealFinger } from '@/lib/slide-reveal';

/** Inside this many points of a chunk's nearest edge, the chunk is fully sharp. */
const R_FULL = 24;
/** Past this many points, the chunk is back to fully frosted. */
const R_FADE = 72;
/** How much a sharp chunk grows at the centre of the window. */
const GROW = 0.06;
/** How long the row takes to fade in on mount, the same as `Frost`'s own fade. */
const MOUNT_MS = 220;

type Box = { x: number; y: number; w: number; h: number } | null;

type Props = {
  finger: RevealFinger;
  count: number;
  renderChunk: (i: number, sharp: boolean) => ReactNode;
  rowStyle: StyleProp<ViewStyle>;
  /** The colour the frosted copy's soft glyphs take on iOS, passed through to `Frost`. */
  ink?: string;
  /** Blur radius in points, passed through to `Frost`. */
  blur?: number;
};

/** How in focus a chunk is, 0 (frosted) to 1 (sharp): how close `finger` is to
 * the chunk's own box, eased by whether the drag is active at all. `box` is
 * null until the chunk's first layout, and every field of both `box` and
 * `finger` is checked for finiteness first: a NaN reaching a worklet style
 * exits Expo Go outright, so a chunk that hasn't measured yet, or a finger
 * that hasn't moved, simply stays frosted instead. */
function chunkFocus(box: Box, finger: RevealFinger): number {
  'worklet';
  if (!box) return 0;
  if (!Number.isFinite(box.x) || !Number.isFinite(box.y) || !Number.isFinite(box.w) || !Number.isFinite(box.h)) {
    return 0;
  }
  const fx = finger.x.value;
  const fy = finger.y.value;
  const active = finger.active.value;
  if (!Number.isFinite(fx) || !Number.isFinite(fy) || !Number.isFinite(active)) return 0;
  const dx = Math.max(box.x - fx, fx - (box.x + box.w), 0);
  const dy = Math.max(box.y - fy, fy - (box.y + box.h), 0);
  const d = Math.sqrt(dx * dx + dy * dy);
  const spatial = 1 - Math.min(1, Math.max(0, (d - R_FULL) / (R_FADE - R_FULL)));
  return Math.min(1, Math.max(0, spatial * active));
}

/** Writes a chunk's box only once its layout settles into four finite
 * numbers, so a mid-measure frame never hands the worklet a NaN. */
function chunkLayout(box: SharedValue<Box>) {
  return (e: LayoutChangeEvent) => {
    const { x, y, width, height } = e.nativeEvent.layout;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) return;
    box.value = { x, y, w: width, h: height };
  };
}

type ChunkProps = {
  box: SharedValue<Box>;
  finger: RevealFinger;
  onLayout: (e: LayoutChangeEvent) => void;
  children: ReactNode;
};

/** The frosted copy of one chunk: fades out as the sharp copy underneath
 * takes over, so the two never both read as fully opaque. */
const FrostChunk = memo(function FrostChunk({
  box,
  finger,
  onLayout,
  ink,
  blur,
  children,
}: ChunkProps & { ink?: string; blur?: number }) {
  const style = useAnimatedStyle(() => ({ opacity: 1 - chunkFocus(box.value, finger) }));
  return (
    <Animated.View onLayout={onLayout} style={style}>
      <Frost frosted ink={ink} blur={blur}>
        {children}
      </Frost>
    </Animated.View>
  );
});

/** The sharp copy of one chunk: fades in and grows a touch as the finger's
 * window settles onto it. */
const SharpChunk = memo(function SharpChunk({
  box,
  finger,
  onLayout,
  grow,
  children,
}: ChunkProps & { grow: number }) {
  const style = useAnimatedStyle(() => {
    const focus = chunkFocus(box.value, finger);
    return { opacity: focus, transform: [{ scale: 1 + grow * focus }] };
  });
  return (
    <Animated.View onLayout={onLayout} style={style}>
      {children}
    </Animated.View>
  );
});

/**
 * A frosted line that reveals only the words under a dragging finger, in the
 * spirit of the enzomanuelmangano slide-to-reveal demo. There is no Skia
 * blur underneath RN text here: this stacks a frosted copy (`Frost`, one per
 * chunk) and a sharp copy of the same chunks, and crossfades between them
 * per chunk from `finger`'s position, entirely on the UI thread.
 *
 * A chunk is a word or a character, whatever `renderChunk` decides; both
 * copies render the same `count` chunks with the same `rowStyle`, so they
 * wrap identically and a chunk's frosted and sharp copies land on the same
 * box. Each copy measures its own `onLayout` into that shared box, so two
 * measurements agree rather than racing.
 */
export function SlideReveal({ finger, count, renderChunk, rowStyle, ink = tide.text, blur = 4 }: Props) {
  const reducedMotion = useReducedMotion();
  const boxes = useMemo(() => Array.from({ length: count }, () => makeMutable<Box>(null)), [count]);
  const onLayouts = useMemo(() => boxes.map((box) => chunkLayout(box)), [boxes]);
  const grow = reducedMotion ? 0 : GROW;

  const mountFade = useSharedValue(reducedMotion ? 1 : 0.2);
  const mounted = useRef(false);
  useEffect(() => {
    if (mounted.current) return;
    mounted.current = true;
    if (reducedMotion) return;
    mountFade.value = 0.2;
    mountFade.value = withTiming(1, { duration: MOUNT_MS });
  }, [reducedMotion, mountFade]);
  const mountStyle = useAnimatedStyle(() => ({ opacity: mountFade.value }));

  return (
    <Animated.View style={[rowStyle, mountStyle]}>
      {boxes.map((box, i) => (
        <FrostChunk key={i} box={box} finger={finger} ink={ink} blur={blur} onLayout={onLayouts[i]}>
          {renderChunk(i, false)}
        </FrostChunk>
      ))}
      <View
        style={[StyleSheet.absoluteFill, rowStyle]}
        pointerEvents="none"
        accessible={false}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants">
        {boxes.map((box, i) => (
          <SharpChunk key={i} box={box} finger={finger} grow={grow} onLayout={onLayouts[i]}>
            {renderChunk(i, true)}
          </SharpChunk>
        ))}
      </View>
    </Animated.View>
  );
}
