// The paused state of the ladder's body: the dim over it with the Resume and End pills,
// and usePausedDim, the dim's SharedValue with the styles the dim and the chips take from it.
// Split out of ladder-stage.tsx as a pure move, no behaviour change.
import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withTiming, type AnimatedStyle } from 'react-native-reanimated';

import { PrismButton } from '@/components/prism';
import { DIM, noop, OUT } from '@/components/tide/ladder/stage-tokens';
import { fonts } from '@/constants/fonts';
import { verb } from '@/constants/theme';
import type { LadderStageProps } from '@/hooks/ladder/ladder-types';
import { useDir, useT } from '@/lib/i18n';

const DIM_MS = 180;

export function Pill({ label, icon, kind, onPress, big }: { label: string; icon?: string; kind: 'tools' | 'mumble' | 'along' | 'speak' | 'listen'; onPress: () => void; big?: boolean }) {
  return (
    <PrismButton shape="pill" verb={kind} label={label} height={big ? 56 : 48} press="light" onPress={onPress} accessibilityRole="button">
      {icon ? <Text style={styles.pillIcon}>{icon}</Text> : null}
    </PrismButton>
  );
}

/** The mock's `.pill.big.blue`: a flat listen-blue pill, 56pt high. */
export function BluePill({ label, icon, onPress }: { label: string; icon: string; onPress: () => void }) {
  const dir = useDir();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.bluePill, dir.row, pressed && { opacity: 0.7 }]}>
      <Text style={styles.blueText}>{icon}</Text>
      <Text style={styles.blueText}>{label}</Text>
    </Pressable>
  );
}

/** The paused dim over the body only: the top row and the bar stay live under it. */
export function usePausedDim(paused: boolean) {
  const reduced = useReducedMotion();
  const dim = useSharedValue(paused ? 1 : 0);
  useEffect(() => {
    dim.value = withTiming(paused ? 1 : 0, { duration: reduced ? 0 : DIM_MS, easing: OUT });
  }, [paused, dim, reduced]);
  const dimStyle = useAnimatedStyle(() => ({ opacity: dim.value }));
  // The chips sit outside the body's gestures, so they fade with the dim instead of under it (the paused pills take their place).
  const chipsStyle = useAnimatedStyle(() => ({ opacity: 1 - (Number.isFinite(dim.value) ? dim.value : 0) }));
  return { dim, dimStyle, chipsStyle };
}

/** The dim over the body with its Resume and End pills; a tap anywhere on it resumes. */
export function PausedLayer({ paused, dimStyle, hintBottom, onResume, onEnd }: { paused: boolean; dimStyle: StyleProp<AnimatedStyle<ViewStyle>>; hintBottom: number; onResume: LadderStageProps['onResume']; onEnd: LadderStageProps['onEnd'] }) {
  const { t } = useT();
  const dir = useDir();
  return (
    <Animated.View style={[styles.dim, dimStyle]} pointerEvents={paused ? 'auto' : 'none'}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onResume} accessibilityRole="button" accessibilityLabel={t('ladder.resume')} />
      <View style={[styles.pausedRow, dir.row, { marginBottom: hintBottom + 28 }]} pointerEvents="box-none">
        <BluePill icon={dir.rtl ? '◀' : '▶'} label={t('ladder.resume')} onPress={onResume ?? noop} />
        <Pill label={t('ladder.end')} icon="⏹" kind="tools" big onPress={onEnd} />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  dim: { ...StyleSheet.absoluteFill, backgroundColor: DIM, alignItems: 'center', justifyContent: 'flex-end' },
  pausedRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  pillIcon: { fontSize: 15 },
  bluePill: {
    height: 56,
    borderRadius: 28,
    paddingHorizontal: 30,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: 'rgba(124,200,255,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(124,200,255,0.45)',
  },
  blueText: { fontFamily: fonts.uiMedium, fontSize: 17, fontWeight: '600', color: verb.listen.c1 },
});
