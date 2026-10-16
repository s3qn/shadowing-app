import { useEffect, useState } from 'react';
import { type LayoutChangeEvent, StyleSheet, Text, View } from 'react-native';
import Animated, {
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

const CORAL = '#FF9E80';
const THICK = 2;
const RADIUS = 24;
const MAX_DOTS = 6;

export type RepeatInfo = {
  /** 1-based pass now playing or held. */
  pass: number;
  total: number;
  /** 1 full ring, 0 track only. Driven by the screen, never per-frame state. */
  progress: SharedValue<number>;
  /** Whole seconds left in a pause, or null outside a pause. */
  secsLeft: number | null;
};

type Piece = 'topRight' | 'right' | 'bottom' | 'left' | 'topLeft' | 'trc' | 'brc' | 'blc' | 'tlc';

const ARC = (Math.PI * RADIUS) / 2;
const ORDER: Piece[] = ['topRight', 'trc', 'right', 'brc', 'bottom', 'blc', 'left', 'tlc', 'topLeft'];

// Where each piece sits on the clockwise path from 12 o'clock. The straight
// strips stop RADIUS short of each corner and a quarter piece fills the bend.
function geometry(w: number, h: number) {
  const half = Math.max(0, w / 2 - RADIUS);
  const lens: Record<Piece, number> = {
    topRight: half,
    trc: ARC,
    right: Math.max(0, h - 2 * RADIUS),
    brc: ARC,
    bottom: Math.max(0, w - 2 * RADIUS),
    blc: ARC,
    left: Math.max(0, h - 2 * RADIUS),
    tlc: ARC,
    topLeft: half,
  };
  const starts = {} as Record<Piece, number>;
  let at = 0;
  for (const k of ORDER) {
    starts[k] = at;
    at += lens[k];
  }
  return { lens, starts, total: Math.max(1, at) };
}

// Each quarter sits in a fixed square. Its clip box shrinks from the side the
// path enters through, so the kept part stays at the side it leaves from.
const CORNERS = {
  trc: {
    box: { top: 0, right: 0, justifyContent: 'flex-end' },
    clip: { width: RADIUS, height: RADIUS },
    arc: { bottom: 0, right: 0, borderTopRightRadius: RADIUS, borderTopWidth: THICK, borderRightWidth: THICK },
  },
  brc: {
    box: { bottom: 0, right: 0, alignItems: 'flex-start' },
    clip: { width: RADIUS, height: RADIUS },
    arc: { bottom: 0, left: 0, borderBottomRightRadius: RADIUS, borderBottomWidth: THICK, borderRightWidth: THICK },
  },
  blc: {
    box: { bottom: 0, left: 0, justifyContent: 'flex-start' },
    clip: { width: RADIUS, height: RADIUS },
    arc: { top: 0, left: 0, borderBottomLeftRadius: RADIUS, borderBottomWidth: THICK, borderLeftWidth: THICK },
  },
  tlc: {
    box: { top: 0, left: 0, alignItems: 'flex-end' },
    clip: { width: RADIUS, height: RADIUS },
    arc: { top: 0, right: 0, borderTopLeftRadius: RADIUS, borderTopWidth: THICK, borderLeftWidth: THICK },
  },
} as const;

// One piece of the ring. The path drains from its start, so each piece
// shrinks toward its clockwise end.
function Strip({
  edge,
  w,
  h,
  progress,
}: {
  edge: Piece;
  w: number;
  h: number;
  progress: SharedValue<number>;
}) {
  const { lens, starts, total } = geometry(w, h);
  const start = starts[edge];
  const len = lens[edge];
  const corner = edge === 'trc' || edge === 'brc' || edge === 'blc' || edge === 'tlc';
  const keptOf = (p: number) => {
    'worklet';
    const v = Number.isFinite(p) ? p : 0;
    const cut = (1 - v) * total;
    return Math.min(1, Math.max(0, (start + len - cut) / Math.max(1, len)));
  };
  const style = useAnimatedStyle(() => {
    const kept = keptOf(progress.value);
    if (corner) {
      // The quarter clips along the direction the path travels through it.
      return edge === 'trc' || edge === 'blc' ? { height: kept * RADIUS } : { width: kept * RADIUS };
    }
    return edge === 'right' || edge === 'left'
      ? { transform: [{ scaleY: kept }] }
      : { transform: [{ scaleX: kept }] };
  });
  if (corner) {
    const c = CORNERS[edge as 'trc' | 'brc' | 'blc' | 'tlc'];
    return (
      <View style={[styles.cornerBox, c.box]}>
        <Animated.View style={[styles.clipBox, c.clip, style]}>
          <View style={[styles.arc, c.arc]} />
        </Animated.View>
      </View>
    );
  }
  const half = Math.max(0, w / 2 - RADIUS);
  const place =
    edge === 'topRight'
      ? { top: 0, left: w / 2, width: half, height: THICK, transformOrigin: 'right center' as const }
      : edge === 'right'
        ? { top: RADIUS, right: 0, width: THICK, height: lens.right, transformOrigin: 'center bottom' as const }
        : edge === 'bottom'
          ? { bottom: 0, left: RADIUS, width: lens.bottom, height: THICK, transformOrigin: 'left center' as const }
          : edge === 'left'
            ? { left: 0, top: RADIUS, width: THICK, height: lens.left, transformOrigin: 'center top' as const }
            : { top: 0, left: RADIUS, width: half, height: THICK, transformOrigin: 'right center' as const };
  return <Animated.View style={[styles.strip, place, style]} />;
}

/**
 * A 2px ring around the sentence card that drains clockwise over a Repeat
 * pause. Lay it over the card with pointerEvents none; it sits on the card
 * edge, outside the text. At rest it shows the track only.
 */
export function RepeatRing({ progress }: { progress: SharedValue<number> }) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setSize((s) => (s.w === width && s.h === height ? s : { w: width, h: height }));
  };
  return (
    <View style={styles.ring} pointerEvents="none" onLayout={onLayout}>
      <View style={styles.track} />
      {size.w > 0 ? (
        <View style={styles.clip}>
          {ORDER.map((edge) => (
            <Strip key={edge} edge={edge} w={size.w} h={size.h} progress={progress} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** Pass dots, plus the seconds left during a pause. Sits above the card edge. */
export function RepeatPill({ pass, total, secsLeft }: { pass: number; total: number; secsLeft: number | null }) {
  const scale = useSharedValue(0.85);
  useEffect(() => {
    scale.value = withSpring(1, { damping: 15, stiffness: 240 });
  }, [scale]);
  const enter = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const pausing = secsLeft !== null;
  const dots = total <= MAX_DOTS;
  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.pill, { borderColor: pausing ? 'rgba(255,200,87,0.55)' : 'rgba(255,255,255,0.18)' }, enter]}
    >
      {dots ? (
        <View style={styles.dots}>
          {Array.from({ length: total }, (_, i) => (
            <View
              key={i}
              style={[
                styles.dot,
                { backgroundColor: i + 1 < pass ? CORAL : i + 1 === pass ? '#fff' : 'rgba(255,255,255,0.25)' },
              ]}
            />
          ))}
        </View>
      ) : (
        <Text style={styles.count}>
          {pass}/{total}
        </Text>
      )}
      {pausing ? <Text style={styles.secs}>{secsLeft}s</Text> : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  ring: { position: 'absolute', top: -THICK, left: -THICK, right: -THICK, bottom: -THICK },
  track: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderWidth: THICK,
    borderRadius: RADIUS,
    borderColor: 'rgba(255,255,255,0.07)',
  },
  clip: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  cornerBox: { position: 'absolute', width: RADIUS, height: RADIUS },
  clipBox: { overflow: 'hidden' },
  arc: { position: 'absolute', width: RADIUS, height: RADIUS, borderColor: CORAL },
  strip: { position: 'absolute', backgroundColor: CORAL },
  pill: {
    position: 'absolute',
    right: 16,
    top: -14,
    height: 28,
    paddingHorizontal: 11,
    borderRadius: 14,
    borderWidth: 1,
    backgroundColor: '#1d2d49',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  dots: { flexDirection: 'row', gap: 5 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  count: { color: '#fff', fontSize: 14, fontWeight: '700', fontVariant: ['tabular-nums'] },
  secs: { color: '#FFE2A0', fontSize: 14, fontWeight: '700', fontVariant: ['tabular-nums'] },
});
