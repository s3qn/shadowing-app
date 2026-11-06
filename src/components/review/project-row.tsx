import { useEffect, useMemo, useState } from 'react';
import { type LayoutChangeEvent, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { GlassPanel } from '@/components/prism/glass-panel';
import { PillTrayShell, useSlidingPill } from '@/components/prism/pill-tray';
import { GRAMMAR_LILAC, RubyWord } from '@/components/ruby-word';
import type { Look } from '@/components/tide/ladder/stage-model';
import { Tile } from '@/components/tide/ladder/stage-tile';
import { fonts } from '@/constants/fonts';
import { tide, verb } from '@/constants/theme';
import * as api from '@/lib/api';
import { useGuideAnchor } from '@/lib/guide';
import { useDir, useT } from '@/lib/i18n';
import { kinsokuUnits } from '@/lib/kinsoku';
import { SESSION_SIZES, type SessionSize } from '@/lib/settings';

const SIZES = SESSION_SIZES;
const GOLD_FILL = 'rgba(255,200,87,0.13)';
const GOLD_RIM = 'rgba(255,200,87,0.42)';
const LINE_SCALE = 28 / 22;
const TRAY_TIMING = { timing: { duration: 240, easing: Easing.out(Easing.cubic) } };
const noop = () => {};
export const ROW_H = 62;
const ELLIPSIS_W = 30;

const EMOJI: Record<api.SessionKind, string> = { podcast: '🎧', video: '🎬', island: '🏝️' };
const KIND_KEY = { podcast: 'review.kindPodcast', video: 'review.kindVideo', island: 'review.kindIsland' } as const;
const LOOK: Record<api.SessionKind, Look> = {
  podcast: { tint: GRAMMAR_LILAC, from: 0.4, to: 0.12, rim: 0.55 },
  video: { tint: verb.listen.c1, from: 0.4, to: 0.12, rim: 0.55 },
  island: { tint: verb.read.c1, from: 0.4, to: 0.12, rim: 0.55 },
};

/** The 5 / 10 / 20 / 30 tray: one lit gold pill that slides under the chosen size (timing, no spring). It fades out while an edited plan matches no size. */
export function SizeTray({ lit: chosen, onPick, guide }: { lit: number | null; onPick: (n: number) => void; guide: boolean }) {
  const dir = useDir();
  const tray = useGuideAnchor('sizeTray', guide);
  const five = useGuideAnchor('size5', guide);
  const [lay, setLay] = useState<Array<{ x: number; width: number } | undefined>>([]);
  const at = chosen === null ? -1 : SIZES.indexOf(chosen as SessionSize);
  const { translateX, width } = useSlidingPill(at >= 0 ? lay[at] : undefined, TRAY_TIMING);
  const on = useSharedValue(at >= 0 ? 1 : 0);
  useEffect(() => {
    on.value = withTiming(at >= 0 ? 1 : 0, TRAY_TIMING.timing);
  }, [at, on]);
  const lit = useAnimatedStyle(() => ({ width: width.value, opacity: on.value, transform: [{ translateX: translateX.value }] }));
  const measured = (i: number, e: LayoutChangeEvent) => {
    const { x: lx, width } = e.nativeEvent.layout;
    setLay((cur) => {
      const next = [...cur];
      next[i] = { x: lx, width };
      return next;
    });
  };
  return (
    <PillTrayShell style={styles.tray}>
      <View ref={tray.ref} onLayout={tray.onLayout} style={[styles.trayRow, dir.row]}>
        <Animated.View pointerEvents="none" style={[styles.lit, lit]} />
        {SIZES.map((n, i) => (
          <Pressable key={n} ref={n === 5 ? five.ref : undefined} style={styles.trayPill} onLayout={(e) => { measured(i, e); if (n === 5) five.onLayout(); }} onPress={() => onPick(n)} accessibilityRole="button" accessibilityState={{ selected: n === chosen }}>
            <Text style={[styles.trayText, n === chosen && { color: verb.read.c1 }]}>{n}</Text>
          </Pressable>
        ))}
      </View>
    </PillTrayShell>
  );
}

/** One project: its tile, kind and title, and the lines it plays (`n` overrides the count, the Add list shows all its lines). */
export function ProjectRow({ p, dirRow, withTotal, n, lead }: { p: api.SessionProject; dirRow: ViewStyle | undefined; withTotal: boolean; n?: number; lead?: boolean }) {
  const { t } = useT();
  const dir = useDir();
  return (
    <View style={[rowStyles.row, dirRow]}>
      <Tile look={LOOK[p.kind]} size={44} radius={12} fontSize={22}>
        {EMOJI[p.kind]}
      </Tile>
      <View style={rowStyles.rowText}>
        <Text style={[rowStyles.rowKind, dir.text]}>{t(KIND_KEY[p.kind])}</Text>
        <Text style={[styles.rowTitle, dir.content]} numberOfLines={1}>
          {p.title}
        </Text>
      </View>
      {lead ? null : (
        <Text style={[styles.rowCount, dir.writing]}>
          {n ?? p.picked.length}
          {withTotal ? <Text style={rowStyles.rowOf}>{` ${t('review.ofTotal', { n: p.total })}`}</Text> : null}
        </Text>
      )}
    </View>
  );
}

/** The "7 of 7 ›" pill on a picker row: tapping it opens the change sheet. The caller wraps it in the tap. */
export function CountPill({ p }: { p: api.SessionProject }) {
  const { t } = useT();
  const dir = useDir();
  return (
    <View style={[styles.pill, dir.row]}>
      <Text style={[styles.pillN, dir.writing]}>
        {p.picked.length}
        <Text style={styles.pillOf}>{` ${t('review.ofTotal', { n: p.total })}`}</Text>
      </Text>
      <Text style={styles.pillArrow}>{dir.rtl ? '‹' : '›'}</Text>
    </View>
  );
}

/** The first line of the session as the ladder shows it: furigana over the kanji at 28pt. */
export function UpFirst({ plan }: { plan: api.SessionPlan }) {
  const { t } = useT();
  const dir = useDir();
  const first = plan.first;
  const project = first ? plan.projects.find((p) => p.island_id === first.island_id) : undefined;
  const units = useMemo(() => (first ? kinsokuUnits(first.words) : []), [first]);
  // The picker shows the line on one row: units past the edge hide and an ellipsis takes their place.
  const [lineW, setLineW] = useState(0);
  const [ends, setEnds] = useState<number[]>([]);
  useEffect(() => setEnds([]), [first]);
  let cut = units.length;
  if (lineW > 0) {
    const over = ends.findIndex((e) => e > lineW);
    if (over >= 0) {
      cut = over;
      while (cut > 0 && (ends[cut - 1] ?? 0) > lineW - ELLIPSIS_W) cut--;
    }
  }
  const setEnd = (i: number, e: LayoutChangeEvent) => {
    const end = e.nativeEvent.layout.x + e.nativeEvent.layout.width;
    setEnds((cur) => {
      if (cur[i] === end) return cur;
      const next = [...cur];
      next[i] = end;
      return next;
    });
  };
  if (!first || !project) return null;
  return (
    <View>
      <Text style={[styles.label, dir.text]}>{t('review.upFirst')}</Text>
      <GlassPanel radius={24} style={styles.upCard}>
        <View style={[styles.upHead, dir.row]}>
          <Tile look={LOOK[project.kind]} size={32} radius={10} fontSize={16}>
            {EMOJI[project.kind]}
          </Tile>
          <Text style={[styles.upTitle, dir.content]} numberOfLines={1}>
            {project.title}
          </Text>
        </View>
        {first.words.length > 0 ? (
          <View style={styles.oneLine} onLayout={(e) => setLineW(e.nativeEvent.layout.width)}>
            {units.map((unit, i) => (
              <View key={unit[0]} style={[styles.unit, i >= cut && styles.hidden]} onLayout={(e) => setEnd(i, e)}>
                {unit.map((wi) => (
                  <RubyWord key={wi} word={first.words[wi]!} showRuby index={wi} selected={false} onLayout={noop} showPosAndRomaji={false} scale={LINE_SCALE} />
                ))}
              </View>
            ))}
            {cut < units.length ? <Text style={[styles.ellipsis, { left: ends[cut - 1] ?? 0 }]}>…</Text> : null}
          </View>
        ) : (
          <Text style={styles.plain} numberOfLines={1}>
            {first.ja}
          </Text>
        )}
        {first.en ? (
          <Text style={[styles.en, dir.content]} numberOfLines={1}>
            {first.en}
          </Text>
        ) : null}
      </GlassPanel>
    </View>
  );
}

/** Row styles shared with the screen and the drag rows. */
export const rowStyles = StyleSheet.create({
  row: { flexDirection: 'row', height: ROW_H, alignItems: 'center', gap: 12 },
  rowText: { flex: 1 },
  rowKind: { fontSize: 15, fontWeight: '600', color: tide.text, fontFamily: fonts.ui },
  rowOf: { fontSize: 12, fontWeight: '500', color: tide.textDim },
});

const styles = StyleSheet.create({
  tray: { height: 60, padding: 5, borderRadius: 30 },
  trayRow: { flex: 1, flexDirection: 'row' },
  trayPill: { flex: 1, alignItems: 'center', justifyContent: 'center', borderRadius: 25 },
  trayText: { fontSize: 22, fontWeight: '700', color: tide.textDim, fontFamily: fonts.ui },
  lit: { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 25, backgroundColor: GOLD_FILL, borderWidth: 1, borderColor: GOLD_RIM },
  rowTitle: { fontSize: 12, color: tide.textDim, fontFamily: fonts.ui },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 5, paddingHorizontal: 10, borderRadius: 999, borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)', backgroundColor: 'rgba(255,255,255,0.05)' },
  pillN: { fontSize: 19, fontWeight: '700', color: tide.text, fontFamily: fonts.ui },
  pillOf: { fontSize: 15, fontWeight: '400', color: tide.textDim },
  pillArrow: { fontSize: 15, color: tide.textDim, fontFamily: fonts.ui },
  rowCount: { fontSize: 17, fontWeight: '700', color: tide.text, fontFamily: fonts.ui },
  label: { fontSize: 11, fontWeight: '700', letterSpacing: 0.7, textTransform: 'uppercase', color: tide.textDim, fontFamily: fonts.ui, marginBottom: 8 },
  upCard: { paddingTop: 12, paddingHorizontal: 18, paddingBottom: 14 },
  upHead: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  upTitle: { flex: 1, fontSize: 13, color: tide.textDim, fontFamily: fonts.ui },
  oneLine: { flexDirection: 'row', overflow: 'hidden', marginTop: 4 },
  hidden: { opacity: 0 },
  ellipsis: { position: 'absolute', bottom: 4, fontSize: 28, fontWeight: '600', color: tide.text, fontFamily: fonts.ui },
  unit: { flexDirection: 'row', flexShrink: 0 },
  plain: { fontSize: 28, fontWeight: '600', color: tide.text, fontFamily: fonts.ui, marginTop: 4 },
  en: { fontSize: 14, lineHeight: 21, color: tide.textDim, fontFamily: fonts.ui },
});
