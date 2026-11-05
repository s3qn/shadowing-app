// The hint line under the sentence (mock 7 `.mini`): hintOf, the step's name and what a tap
// does now, and StageHint, the line with the recording dot; a tap on it stops a take.
// Split out of ladder-stage.tsx as a pure move, no behaviour change.
import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';

import type { Frame } from '@/components/tide/ladder/stage-model';
import { fonts } from '@/constants/fonts';
import { tide, verb } from '@/constants/theme';
import type { LadderStageProps } from '@/hooks/ladder/ladder-types';
import { useDir, useT } from '@/lib/i18n';

/** The hint line's text (mock 7 `.mini`): the step's name, then what a tap does now. */
export function hintOf(p: LadderStageProps, frame: Frame, name: string, t: ReturnType<typeof useT>['t']): string {
  if (p.paused) return `${name} · ${t('ladder.paused')}`;
  if (p.phase === 'announce' || p.phase === 'count') return t('player.announce', { name });
  if (p.phase === 'gap') return `${name} · ${t('player.again', { n: p.repeat, total: p.repeats })}`;
  if (frame === 'recording') return `${name} · ${t(p.textHidden ? 'ladder.holdToPeek' : p.speaker ? 'ladder.speakerHint' : 'ladder.tapStop')}`;
  if (p.phase === 'waiting') return `${name} · ${t('ladder.tapToStart')}`;
  if (p.handsFree === false && frame === 'compare' && p.score) return `${name} · ${t('ladder.tapNext')}`;
  return `${name} · ${t('ladder.tapToPause')} · ${t('ladder.holdHint')}`;
}

/**
 * The hint with the recording dot in front of it. `stopOnce` and `stopped` are the
 * composer's (the body's tap shares them): the dot pulses through a take and shrinks
 * away on the stop, while "Stopped" holds for a moment.
 */
export function StageHint({ p, frame, name, hintBottom, isRecording, stopped, stopOnce, setStopped }: { p: LadderStageProps; frame: Frame; name: string; hintBottom: number; isRecording: LadderStageProps['isRecording']; stopped: boolean; stopOnce: () => void; setStopped: (v: boolean) => void }) {
  const reduced = useReducedMotion();
  const { t } = useT();
  const dir = useDir();
  const dotPulse = useSharedValue(1);
  const dotOut = useSharedValue(0);
  useEffect(() => {
    cancelAnimation(dotPulse);
    if (isRecording) {
      setStopped(false);
      dotOut.value = 0;
      dotPulse.value = 1;
      if (!reduced) dotPulse.value = withRepeat(withTiming(0.35, { duration: 500, easing: Easing.inOut(Easing.ease) }), -1, true);
    } else {
      dotPulse.value = 1;
    }
  }, [isRecording, reduced, dotPulse, dotOut, setStopped]);
  useEffect(() => {
    if (!stopped) return;
    dotOut.value = withTiming(1, { duration: reduced ? 0 : 180, easing: Easing.out(Easing.cubic) });
    const id = setTimeout(() => setStopped(false), 900);
    return () => clearTimeout(id);
  }, [stopped, dotOut, reduced, setStopped]);
  const dotStyle = useAnimatedStyle(() => {
    const out = Number.isFinite(dotOut.value) ? dotOut.value : 0;
    const pulse = Number.isFinite(dotPulse.value) ? dotPulse.value : 1;
    return { opacity: pulse * (1 - out), transform: [{ scale: 1 - out }] };
  });
  const showDot = isRecording || stopped;
  return (
    <View style={[styles.hintWrap, { bottom: hintBottom - 13 }]} pointerEvents="box-none">
      <Pressable
        onPress={stopOnce}
        disabled={!isRecording}
        hitSlop={{ top: 8, bottom: 8, left: 12, right: 12 }}
        accessibilityRole="button"
        accessibilityLabel={t('ladder.tapStop')}
        style={[styles.hintPress, dir.row]}>
        <Animated.View style={[styles.stopDot, dir.rtl ? { marginLeft: showDot ? 8 : 0 } : { marginRight: showDot ? 8 : 0 }, !showDot && { width: 0 }, dotStyle]} pointerEvents="none" />
        <Text numberOfLines={1} style={styles.hintText}>{stopped && !isRecording ? t('ladder.stopped') : hintOf(p, frame, name, t)}</Text>
      </Pressable>
    </View>
  );
}

/** The hint line as a still picture, for the stage's preview: the same place and type, no dot, no press. */
export function StillHint({ text, hintBottom }: { text: string; hintBottom: number }) {
  const dir = useDir();
  return (
    <View style={[styles.hintWrap, { bottom: hintBottom - 13 }]} pointerEvents="none">
      <View style={[styles.hintPress, dir.row]}>
        <Text numberOfLines={1} style={styles.hintText}>{text}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  hintWrap: { position: 'absolute', left: 16, right: 16, alignItems: 'center' },
  hintPress: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', minHeight: 44 },
  hintText: { fontFamily: fonts.ui, fontSize: 13, lineHeight: 18, color: tide.textDim, textAlign: 'center', flexShrink: 1 },
  stopDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: verb.speak.c1 },
});
