import { useEffect } from 'react';
import { type GestureResponderEvent, type LayoutChangeEvent, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { Accelerometer } from 'expo-sensors';

export const BAND_HEIGHT = 40;
/** Where the band sits relative to the `water` View it is layered over: it
 * starts 20px above so troughs show sky, not water. */
export const BAND_TOP = -20;
export const BOAT_W = 26;
export const BOAT_H = 16;
/** Hull trapezoid plus two sails, in the boat's own 26x16 local box, drawn
 * by `water-canvas.tsx`'s Skia layer. Sits half in the water: the surface
 * fill paints on top of the lower half, so only the hull's top edge and the
 * sails show once the water settles. */
export const BOAT_HULL_D = 'M3,11 L23,11 L19,15 L7,15 Z';
export const BOAT_SAIL_FRONT_D = 'M13,11 L13,1 L21,11 Z';
export const BOAT_SAIL_BACK_D = 'M13,11 L13,4 L7,11 Z';
/** Flip to -1 in this one place if the water leans the wrong way: checked
 * against portrait upright (gy about -1), not yet verified on a physical
 * phone by this change. */
const TILT_SIGN = 1;

type Props = {
  /** Pixel width of the band; 0 before its first layout. */
  width: number;
  boatY: SharedValue<number>;
  boatAngle: SharedValue<number>;
  boatX: SharedValue<number>;
  boatDragging: SharedValue<boolean>;
  tilt: SharedValue<number>;
  onWidthChange: (width: number) => void;
  /** A tap or touch on the band, in band-local x pixels. */
  onSplash: (x: number) => void;
  /** Worklet: called directly from the boat's Pan gesture, never through JS. */
  splashAt: (x: number, strength: number) => void;
  setBoatX: (x: number) => void;
  flickBoat: (vx: number) => void;
  /** Same gate as the frame callback: focused, foregrounded, not reduced motion. */
  enabled: boolean;
  reducedMotion: boolean;
};

/**
 * The waterline's touch and drag surface: a splash listener over the band
 * and an invisible drag target for the boat, both driven by `use-water-sim`'s
 * shared values. The visible water (surface fill, light band, boat) is Skia,
 * drawn by `water-canvas.tsx`; this component only claims gestures, so it
 * never steals the sentence's own: `onTouchStart` fires for taps that land
 * on the band without blocking the scroll or a word press underneath. The
 * boat's own Pan gesture is horizontal-only (`activeOffsetX`), so a vertical
 * drag starting on it still scrolls the transcript.
 */
export function WaterSurface({
  width,
  boatY,
  boatAngle,
  boatX,
  boatDragging,
  tilt,
  onWidthChange,
  onSplash,
  splashAt,
  setBoatX,
  flickBoat,
  enabled,
  reducedMotion,
}: Props) {
  const boatStyle = useAnimatedStyle(() => {
    const x = Number.isFinite(boatX.value) ? boatX.value : BOAT_W;
    const y = Number.isFinite(boatY.value) ? boatY.value : 0;
    const angle = Number.isFinite(boatAngle.value) ? boatAngle.value : 0;
    return {
      transform: [{ translateX: x - BOAT_W / 2 }, { translateY: y }, { rotate: `${angle}rad` }],
    };
  });

  const onLayout = (e: LayoutChangeEvent) => {
    onWidthChange(e.nativeEvent.layout.width);
  };

  const onTouchStart = (e: GestureResponderEvent) => {
    onSplash(e.nativeEvent.locationX);
  };

  const dragStartX = useSharedValue(0);
  const boatGesture = Gesture.Pan()
    .activeOffsetX([-8, 8])
    .failOffsetY([-12, 12])
    .hitSlop(10)
    .onBegin(() => {
      boatDragging.value = true;
      dragStartX.value = boatX.value;
    })
    .onUpdate((e) => {
      setBoatX(dragStartX.value + e.translationX);
    })
    .onEnd((e) => {
      boatDragging.value = false;
      flickBoat(e.velocityX);
      splashAt(boatX.value, 0.5);
    })
    .onFinalize(() => {
      boatDragging.value = false;
    });

  // Gravity vector at 30Hz, low-passed so hand jitter does not buzz the
  // surface, gated the same as the frame callback so the sensor sits idle
  // off-screen, backgrounded, or under Reduce Motion.
  useEffect(() => {
    if (!enabled || reducedMotion) return;
    let gx = 0;
    let gy = -1;
    let sub: { remove: () => void } | null = null;
    // Tilt is decoration: a sensor that is missing or refuses to start leaves
    // the water level instead of taking the screen down.
    try {
      Accelerometer.setUpdateInterval(33);
      sub = Accelerometer.addListener(({ x, y }) => {
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        gx += 0.15 * (x - gx);
        gy += 0.15 * (y - gy);
        const next = Math.atan2(TILT_SIGN * gx, -gy);
        if (Number.isFinite(next)) tilt.value = next;
      });
    } catch {
      sub = null;
    }
    return () => sub?.remove();
  }, [enabled, reducedMotion, tilt]);

  return (
    <View style={styles.band} onLayout={onLayout} onTouchStart={onTouchStart}>
      {width > 0 ? (
        <GestureDetector gesture={boatGesture}>
          <Animated.View style={[styles.boat, { top: 20 - BOAT_H * 0.6 }, boatStyle]} />
        </GestureDetector>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  band: {
    position: 'absolute',
    top: BAND_TOP,
    left: 0,
    right: 0,
    height: BAND_HEIGHT,
  },
  boat: {
    position: 'absolute',
    left: 0,
    width: BOAT_W,
    height: BOAT_H,
  },
});
