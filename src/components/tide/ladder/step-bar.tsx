// The Stories bar (mock A `.segs`): one thin segment per step, the done ones in ink,
// the current one filling with the step's tint over the pass; a tap jumps to its step.
// Split out of ladder-stage.tsx as a pure move, no behaviour change.
import { memo, useCallback, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { jumpStep, STEPS } from '@/components/tide/ladder/stage-model';
import { TRACK } from '@/components/tide/ladder/stage-tokens';
import { tide, withAlpha } from '@/constants/theme';
import type { LadderStageProps } from '@/hooks/ladder/ladder-types';
import { hapticSelection } from '@/lib/haptics';
import { useDir, useT } from '@/lib/i18n';

/**
 * The Stories bar (mock A `.segs`): one thin segment per step, the done ones in
 * ink, the current one filling with the step's tint over the pass. Each segment
 * sits in a 24pt tap target that jumps to its step; the island's skipped Mumble
 * draws at 40% and still takes the tap.
 */
export const StepBar = memo(function StepBar({ p, vis, cur, tint }: { p: LadderStageProps; vis: readonly number[]; cur: number; tint: string }) {
  const { t } = useT();
  const dir = useDir();
  // Only the shared value goes into the worklet: `p` holds JSX and refs, which cannot be copied to the UI thread.
  const fill = p.fill;
  const fillStyle = useAnimatedStyle(() => {
    const f = Number.isFinite(fill.value) ? Math.min(1, Math.max(0, fill.value)) : 0;
    return { width: `${f * 100}%` };
  });
  // The fill grows from the reading start: anchored outside the worklet, from the `rtl` primitive.
  const anchor = dir.rtl ? styles.fillEnd : styles.fillStart;

  // D11 scrub: the segment under the thumb lights up, one tick per crossing, one jump on release.
  const [hot, setHot] = useState(-1);
  const width = useSharedValue(0);
  const last = useSharedValue(-1);
  const n = vis.length;
  const rtl = dir.rtl;
  const onCross = useCallback((i: number) => {
    setHot(i);
    void hapticSelection();
  }, []);
  const onCommit = useCallback(
    (i: number) => {
      setHot(-1);
      const s = vis[i];
      if (s !== undefined) jumpStep(p.onJump, p.onFinal, s);
    },
    [vis, p.onJump, p.onFinal],
  );
  const onCancel = useCallback(() => setHot(-1), []);
  const pan = useMemo(() => {
    const at = (x: number) => {
      'worklet';
      if (width.value <= 0 || n <= 0) return -1;
      const k = Math.min(n - 1, Math.max(0, Math.floor((x / width.value) * n)));
      return rtl ? n - 1 - k : k;
    };
    // The tap lives in the same detector as the pan (no Pressables), so a scrub release can never also fire a segment press.
    const tap = Gesture.Tap()
      .maxDistance(8)
      .onEnd((e, ok) => {
        if (!ok) return;
        const i = at(e.x);
        if (i >= 0) scheduleOnRN(onCommit, i);
      });
    const scrub = Gesture.Pan()
      .activeOffsetX([-8, 8])
      .failOffsetY([-24, 24])
      .onStart((e) => {
        const i = at(e.x);
        last.value = i;
        if (i >= 0) scheduleOnRN(onCross, i);
      })
      .onUpdate((e) => {
        const i = at(e.x);
        if (i >= 0 && i !== last.value) {
          last.value = i;
          scheduleOnRN(onCross, i);
        }
      })
      .onEnd(() => {
        if (last.value >= 0) scheduleOnRN(onCommit, last.value);
        else scheduleOnRN(onCancel);
      })
      .onFinalize((_e, ok) => {
        if (!ok) scheduleOnRN(onCancel);
      });
    return Gesture.Exclusive(scrub, tap);
  }, [width, last, n, rtl, onCross, onCommit, onCancel]);

  return (
    <GestureDetector gesture={pan}>
    <View
      style={[styles.segs, dir.row]}
      accessibilityLabel={t('ladder.scrub')}
      onLayout={(e) => {
        width.value = e.nativeEvent.layout.width;
      }}>
      {vis.map((s, i) => {
        const skipped = s === 1 && p.prep === false && i !== cur;
        return (
          <View
            key={s}
            accessible
            onAccessibilityTap={() => jumpStep(p.onJump, p.onFinal, s)}
            accessibilityRole="button"
            accessibilityLabel={skipped ? `${t(STEPS[s]!.name)}, ${t('ladder.skipped')}` : t(STEPS[s]!.name)}
            style={[styles.segHit, skipped && styles.segSkipped]}>
            <View style={[styles.seg, i < cur && styles.segDone, i === hot && { backgroundColor: withAlpha(tint, 0.5) }]}>
              {i === cur ? <Animated.View style={[styles.segFill, anchor, { backgroundColor: tint }, fillStyle]} /> : null}
            </View>
          </View>
        );
      })}
    </View>
    </GestureDetector>
  );
});

const styles = StyleSheet.create({
  // Mock A `.segs`: 4pt segments, 4pt apart, in a 24pt tap row.
  segs: { marginTop: 4, marginHorizontal: 16, flexDirection: 'row', gap: 4 },
  segHit: { flex: 1, height: 24, justifyContent: 'center' },
  segSkipped: { opacity: 0.4 },
  seg: { height: 4, borderRadius: 2, backgroundColor: TRACK, overflow: 'hidden' },
  segDone: { backgroundColor: withAlpha(tide.text, 0.85) },
  segFill: { position: 'absolute', top: 0, bottom: 0, borderRadius: 2 },
  fillStart: { left: 0 },
  fillEnd: { right: 0 },
});
