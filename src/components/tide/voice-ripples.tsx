import { StyleSheet, View } from 'react-native';
import Animated, {
  useAnimatedReaction,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import { tide } from '@/constants/theme';

/** Row height for the whole strip: baseline plus room for the tallest ring.
 * Exported so a parent can reserve this height on steps that do not mount
 * the strip, keeping the sheet from jumping when Speak starts. */
export const STRIP_HEIGHT = 64;
/** Ring geometry: base diameter before a spawn's peak scale is applied. */
const RING_DIAMETER = 30;
/** Scale a ring starts at right after it spawns. */
const RING_SCALE_MIN = 0.3;
/** How long one ring takes to expand and fade out fully. */
const RING_LIFETIME_MS = 900;
/** level below this does not spawn a ring: quiet room tone stays calm. */
const SPAWN_GATE = 0.12;
/** Spawn cadence just above the gate and at level 1 (loudest speech). */
const SPAWN_COOLDOWN_MAX_MS = 700;
const SPAWN_COOLDOWN_MIN_MS = 260;
/** Ring peak scale range: reached at the end of a ring's life. */
const PEAK_SCALE_MIN = 1;
const PEAK_SCALE_MAX = 1.9;
const RING_COUNT = 3;

type VoiceRipplesProps = {
  /** 0..1, already noise-gated meter level from the take's recorder, read
   * on the UI thread. */
  level: SharedValue<number>;
};

/**
 * Ripples spreading from the waterline while Sean speaks: quiet stays calm,
 * louder speech spawns bigger, more frequent rings. Mount only during the
 * speak step so there is no animation cost the rest of the time.
 */
export function VoiceRipples({ level }: VoiceRipplesProps) {
  const reducedMotion = useReducedMotion();

  const ringIndex = useSharedValue(0);
  const spawnLock = useSharedValue(0);

  const ring0Progress = useSharedValue(1);
  const ring0Peak = useSharedValue(PEAK_SCALE_MIN);
  const ring1Progress = useSharedValue(1);
  const ring1Peak = useSharedValue(PEAK_SCALE_MIN);
  const ring2Progress = useSharedValue(1);
  const ring2Peak = useSharedValue(PEAK_SCALE_MIN);
  const ringProgress = [ring0Progress, ring1Progress, ring2Progress];
  const ringPeak = [ring0Peak, ring1Peak, ring2Peak];

  // Spawns the next pooled ring, round robin, when level crosses the gate
  // and no other ring spawned within its own cooldown. Louder speech makes
  // the ring bigger (higher peak scale) and the cooldown shorter.
  useAnimatedReaction(
    () => level.value,
    (current) => {
      if (!Number.isFinite(current)) return;
      if (reducedMotion || current < SPAWN_GATE || spawnLock.value === 1) return;

      const t = Math.min(1, (current - SPAWN_GATE) / (1 - SPAWN_GATE));
      const i = ringIndex.value;
      ringIndex.value = (i + 1) % RING_COUNT;
      ringPeak[i].value = PEAK_SCALE_MIN + t * (PEAK_SCALE_MAX - PEAK_SCALE_MIN);
      ringProgress[i].value = 0;
      ringProgress[i].value = withTiming(1, { duration: RING_LIFETIME_MS });

      const cooldownMs = SPAWN_COOLDOWN_MAX_MS - t * (SPAWN_COOLDOWN_MAX_MS - SPAWN_COOLDOWN_MIN_MS);
      spawnLock.value = 1;
      spawnLock.value = withDelay(cooldownMs, withTiming(0, { duration: 0 }));
    },
    [reducedMotion]
  );

  const ring0Style = useAnimatedStyle(() => ({
    opacity: (1 - ring0Progress.value) * 0.5,
    transform: [{ scale: RING_SCALE_MIN + (ring0Peak.value - RING_SCALE_MIN) * ring0Progress.value }],
  }));
  const ring1Style = useAnimatedStyle(() => ({
    opacity: (1 - ring1Progress.value) * 0.5,
    transform: [{ scale: RING_SCALE_MIN + (ring1Peak.value - RING_SCALE_MIN) * ring1Progress.value }],
  }));
  const ring2Style = useAnimatedStyle(() => ({
    opacity: (1 - ring2Progress.value) * 0.5,
    transform: [{ scale: RING_SCALE_MIN + (ring2Peak.value - RING_SCALE_MIN) * ring2Progress.value }],
  }));

  if (reducedMotion) {
    return (
      <View style={styles.strip}>
        <View style={styles.baseline} />
      </View>
    );
  }

  return (
    <View style={styles.strip}>
      <View style={styles.baseline} />
      <Animated.View style={[styles.ring, ring0Style]} />
      <Animated.View style={[styles.ring, ring1Style]} />
      <Animated.View style={[styles.ring, ring2Style]} />
    </View>
  );
}

const styles = StyleSheet.create({
  strip: { height: STRIP_HEIGHT },
  baseline: {
    position: 'absolute',
    left: '20%',
    right: '20%',
    top: STRIP_HEIGHT / 2,
    height: 1,
    backgroundColor: tide.waterline,
  },
  ring: {
    position: 'absolute',
    top: STRIP_HEIGHT / 2 - RING_DIAMETER / 2,
    left: '50%',
    marginLeft: -RING_DIAMETER / 2,
    width: RING_DIAMETER,
    height: RING_DIAMETER,
    borderRadius: RING_DIAMETER / 2,
    borderWidth: 1.5,
    borderColor: tide.record,
  },
});
