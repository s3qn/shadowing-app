import { useCallback, useEffect, useRef, useState } from 'react';
import { type LayoutChangeEvent, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  FadeIn,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

/** The thumb rides to its new line on a short spring. */
const RAIL_SPRING = { damping: 20, stiffness: 210, mass: 1 } as const;
const THUMB_H = 20;
const ACCENT = '#ff8a2a';
/** How long a finished drag holds its preview while the parent seeks. */
const HOLD_MS = 800;

type Props = {
  lineIndex: number;
  lineCount: number;
  reducedMotion: boolean;
  style?: StyleProp<ViewStyle>;
  onJump: (i: number) => void;
};

/** Quiet progress rail on the right edge: track, fill, thumb and the 1-based
 * line number. Tap or drag the strip to preview a line, release to jump. */
export function LineRail({ lineIndex, lineCount, reducedMotion, style, onJump }: Props) {
  const [h, setH] = useState(0);
  const [preview, setPreview] = useState<number | null>(null);
  const y = useSharedValue(0);
  const ready = useSharedValue(0);
  const mounted = useRef(false);
  const dragging = useRef(false);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const live = useRef({ h, lineCount, lineIndex, preview: null as number | null, onJump });
  live.current = { h, lineCount, lineIndex, preview: live.current.preview, onJump };

  const shown = preview ?? lineIndex;

  const onLayout = useCallback((e: LayoutChangeEvent) => setH(e.nativeEvent.layout.height), []);

  useEffect(() => {
    if (h <= 0 || lineCount <= 0) return;
    const p = lineCount > 1 ? Math.min(Math.max(shown, 0), lineCount - 1) / (lineCount - 1) : 0.5;
    const target = p * Math.max(h - THUMB_H, 0);
    if (!mounted.current) {
      mounted.current = true;
      y.value = target;
      ready.value = withTiming(1, { duration: 150 });
      return;
    }
    y.value = reducedMotion ? withTiming(target, { duration: 150 }) : withSpring(target, RAIL_SPRING);
  }, [shown, lineCount, h, reducedMotion, y, ready]);

  // Once the parent's line catches up, the preview is no longer needed.
  useEffect(() => {
    if (dragging.current || live.current.preview === null) return;
    live.current.preview = null;
    setPreview(null);
  }, [lineIndex]);

  useEffect(
    () => () => {
      if (holdTimer.current) clearTimeout(holdTimer.current);
    },
    [],
  );

  const indexAt = useCallback((py: number) => {
    const { h: hh, lineCount: n } = live.current;
    const span = hh - THUMB_H;
    if (n <= 1 || span <= 0) return 0;
    const i = Math.round(((py - THUMB_H / 2) / span) * (n - 1));
    return Math.min(Math.max(i, 0), n - 1);
  }, []);

  const preview_ = useCallback(
    (py: number) => {
      if (holdTimer.current) clearTimeout(holdTimer.current);
      const i = indexAt(py);
      live.current.preview = i;
      setPreview(i);
    },
    [indexAt],
  );

  const finish = useCallback(() => {
    const i = live.current.preview;
    if (i === null) return;
    if (i !== live.current.lineIndex) {
      live.current.onJump(i);
      if (holdTimer.current) clearTimeout(holdTimer.current);
      holdTimer.current = setTimeout(() => {
        live.current.preview = null;
        setPreview(null);
      }, HOLD_MS);
    } else {
      live.current.preview = null;
      setPreview(null);
    }
  }, []);

  const pan = Gesture.Pan()
    .minDistance(0)
    .runOnJS(true)
    .onBegin((e) => {
      dragging.current = true;
      preview_(e.y);
    })
    .onUpdate((e) => preview_(e.y))
    .onFinalize(() => {
      dragging.current = false;
      finish();
    });

  const thumbStyle = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }] }));
  const fillStyle = useAnimatedStyle(() => ({ height: y.value + THUMB_H / 2 }));
  const fadeStyle = useAnimatedStyle(() => ({ opacity: ready.value }));

  if (lineCount <= 0) return null;

  return (
    <GestureDetector gesture={pan}>
      <Animated.View style={[styles.strip, style]} onLayout={onLayout}>
        <Animated.View style={[StyleSheet.absoluteFill, fadeStyle]} pointerEvents="none">
          <Animated.View style={styles.track} />
          <Animated.View style={[styles.fill, fillStyle]} />
          <Animated.View style={[styles.thumbWrap, thumbStyle]}>
            <Animated.Text key={shown} entering={FadeIn.duration(100)} style={styles.number}>
              {shown + 1}
            </Animated.Text>
            <Animated.View style={styles.thumb} />
          </Animated.View>
        </Animated.View>
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  strip: { position: 'absolute', right: 0, width: 44, zIndex: 4 },
  track: {
    position: 'absolute',
    right: 9,
    top: 0,
    bottom: 0,
    width: 2,
    borderRadius: 1,
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  fill: { position: 'absolute', right: 9, top: 0, width: 2, borderRadius: 1, backgroundColor: ACCENT },
  thumbWrap: { position: 'absolute', top: 0, right: 0, width: 44, height: THUMB_H },
  thumb: { position: 'absolute', right: 7, top: 0, width: 6, height: THUMB_H, borderRadius: 3, backgroundColor: ACCENT },
  number: {
    position: 'absolute',
    right: 18,
    top: 0,
    height: THUMB_H,
    lineHeight: THUMB_H,
    fontSize: 13,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.80)',
    fontVariant: ['tabular-nums'],
    textAlign: 'right',
  },
});
