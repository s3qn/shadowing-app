// The fixed slot under the sentence: the live meter while recording, then the take's
// banded score (ScoreValue) with the XP it paid popping beside it (XpPop).
// Split out of ladder-stage.tsx as a pure move, no behaviour change.
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withDelay, withSequence, withTiming } from 'react-native-reanimated';

import { LevelBars } from '@/components/level-bars';
import { ShimmerText } from '@/components/shimmer-text';
import { devScoringHold } from '@/lib/dev-simulate';
import { OUT, SCORE_H, SLOT_GAP, XP_GOLD } from '@/components/tide/ladder/stage-tokens';
import { fonts } from '@/constants/fonts';
import { tide } from '@/constants/theme';
import type { LadderStageProps } from '@/hooks/ladder/ladder-types';
import { useDir, useT } from '@/lib/i18n';
import { isolate } from '@/lib/bidi';
import { useInlineXp } from '@/lib/level-up-store';

/** The new take's score, banded like the island's score row (>= 80, 50-79, < 50); fades in rising 8pt. */
export function ScoreValue({ total, keptUp }: { total: number; keptUp?: string }) {
  const reduced = useReducedMotion();
  const o = useSharedValue(reduced ? 1 : 0);
  useEffect(() => {
    if (!reduced) o.value = withTiming(1, { duration: 220, easing: OUT });
  }, [o, reduced]);
  const rise = useAnimatedStyle(() => {
    const v = Number.isFinite(o.value) ? o.value : 1;
    return { opacity: v, transform: [{ translateY: (1 - v) * 8 }] };
  });
  const colour = total >= 80 ? tide.listen : total >= 50 ? tide.text : tide.record;
  return (
    <Animated.View style={[styles.scoreIn, rise]}>
      <View style={styles.scoreRow}>
        <Text style={[styles.scoreNum, { color: colour }]}>{Math.round(total)}</Text>
        <Text style={styles.scoreOf}>/100</Text>
      </View>
      {keptUp ? <Text style={styles.scoreKept}>{keptUp}</Text> : null}
    </Animated.View>
  );
}

/**
 * The XP a take (or any award while the stage is up) paid: a small gold
 * "+N XP" next to the score that fades in rising 10pt over 600ms out-cubic,
 * holds 1.2s, then fades out. Only a pop after this view mounted plays.
 */
export function XpPop({ beside }: { beside: boolean }) {
  const { t } = useT();
  const dir = useDir();
  const { n, id, cap } = useInlineXp();
  const [since] = useState(id);
  const reduced = useReducedMotion();
  const o = useSharedValue(0);
  const r = useSharedValue(0);
  const live = id !== since && (n > 0 || cap);
  useEffect(() => {
    if (!live) return;
    o.value = 0;
    r.value = reduced ? 1 : 0;
    o.value = withSequence(
      withTiming(1, { duration: 600, easing: OUT }),
      withDelay(1200, withTiming(0, { duration: 200, easing: Easing.linear })),
    );
    if (!reduced) r.value = withTiming(1, { duration: 600, easing: OUT });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  const style = useAnimatedStyle(() => {
    const ov = Number.isFinite(o.value) ? o.value : 0;
    const rv = Number.isFinite(r.value) ? r.value : 1;
    return { opacity: ov, transform: [{ translateY: (1 - rv) * 10 }] };
  });
  if (!live) return null;
  return (
    <Animated.View style={[beside ? (dir.rtl ? styles.xpBesideRtl : styles.xpBeside) : styles.xpAlone, style]}>
      <Text style={[styles.xpText, beside && dir.text]}>{isolate(t('review.xpEarned', { n }))}</Text>
      {cap ? <Text style={[styles.xpCap, beside ? dir.text : { textAlign: 'center' }, dir.writing]}>{t('ladder.xpCap')}</Text> : null}
    </Animated.View>
  );
}

/** The slot never changes height, so the sentence never jumps: the live meter or the score, empty through the count. */
export function ScoreSlot({ isRecording, level, score }: { isRecording: LadderStageProps['isRecording']; level: LadderStageProps['level']; score: LadderStageProps['score'] }) {
  const { t } = useT();
  const total = score?.total;
  const hold = devScoringHold();
  const scored = !hold && typeof total === 'number' && Number.isFinite(total);
  return (
    <View style={styles.slot}>
      {isRecording && level ? <LevelBars level={level} live /> : null}
      {scored ? (
        <ScoreValue key={`${total}|${score?.keptUp ?? ''}|${score?.at ?? 0}`} total={total} keptUp={score?.keptUp} />
      ) : hold || score?.scoring ? (
        <ShimmerText style={styles.scoring}>{t('ladder.scoring')}</ShimmerText>
      ) : null}
      <XpPop beside={scored} />
    </View>
  );
}

const styles = StyleSheet.create({
  slot: { marginTop: SLOT_GAP, height: SCORE_H, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center' },
  scoreIn: { alignItems: 'center' },
  scoreRow: { flexDirection: 'row', alignItems: 'baseline', gap: 4 },
  scoreNum: { fontFamily: fonts.uiMedium, fontSize: 44, lineHeight: 50, fontWeight: '700', color: tide.text, fontVariant: ['tabular-nums'] },
  scoreOf: { fontFamily: fonts.ui, fontSize: 12, color: tide.textDim },
  scoreKept: { marginTop: 2, fontFamily: fonts.ui, fontSize: 13, lineHeight: 18, color: tide.textDim },
  scoring: { fontFamily: fonts.ui, fontSize: 13, color: tide.textDim },
  // Right of the centred score (its row is up to about 120pt wide), level with the number.
  xpBeside: { position: 'absolute', left: '50%', marginLeft: 66, top: 18, maxWidth: 120 },
  // Hebrew reads the score first from the right, so the XP sits to its left.
  xpBesideRtl: { position: 'absolute', right: '50%', marginRight: 66, top: 18, maxWidth: 120 },
  xpAlone: { position: 'absolute', left: 0, right: 0, top: 26, alignItems: 'center' },
  xpText: { fontFamily: fonts.ui, fontSize: 15, fontWeight: '700', color: XP_GOLD },
  xpCap: { fontFamily: fonts.ui, fontSize: 12, lineHeight: 16, color: tide.textDim },
});
