import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { CatConstellation } from '@/components/cat-constellation';
import { fonts } from '@/constants/fonts';
import { tide } from '@/constants/theme';
import * as api from '@/lib/api';
import { useDir, useT } from '@/lib/i18n';

/** The open body of a Practice island: every saved line, the ones this session skips struck through. `picked` is the plan's idx list, so a changed count re-marks with no refetch. */
export function SessionLines({
  islandId,
  picked,
  variant = 'list',
  barColors,
  expectRows = 0,
}: {
  islandId: string;
  picked: number[];
  /** `peek`: the floating card's list. No number column, no skip marks, a start-edge tier bar, transparent body. */
  variant?: 'list' | 'peek';
  /** Peek only: the bar colour per line index (null: neutral). */
  barColors?: (string | null)[];
  /** Peek only: the line count, so the loader reserves about the list's height and the menu below does not move when the lines land. */
  expectRows?: number;
}) {
  const peek = variant === 'peek';
  const { t } = useT();
  const dir = useDir();
  const [lines, setLines] = useState<api.SessionLine[] | null>(() => api.peekSessionLines(islandId) ?? null);
  const [failed, setFailed] = useState(false);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    if (lines) return;
    let live = true;
    api
      .getSessionLines(islandId)
      .then((l) => live && setLines(l))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [islandId, lines, tries]);
  const used = useMemo(() => new Set(picked), [picked]);
  // -1 or an empty list is the screen's placeholder until the planner answers: no line is marked skipped yet.
  const pending = picked.length === 0 || picked.includes(-1);

  if (!lines) {
    const reserve = peek ? { minHeight: Math.min(PEEK_MAX_H, Math.max(72, PEEK_PAD_H + expectRows * PEEK_ROW_H)) } : null;
    return failed ? (
      <Pressable onPress={() => {
          setFailed(false);
          setTries((n) => n + 1);
        }} accessibilityRole="button" style={[styles.state, peek && styles.statePeek, reserve]}>
        <Text style={[styles.dim, dir.writing]}>{t('review.linesFailed')}</Text>
      </Pressable>
    ) : (
      <View style={[styles.state, peek && styles.statePeek, reserve]}>
        <CatConstellation size={40} />
      </View>
    );
  }
  if (peek) {
    if (lines.length === 0) return null;
    return (
      <View style={styles.peekBox}>
        <ScrollView style={styles.peekScroll} showsVerticalScrollIndicator={false} bounces={lines.length > 4}>
          <View style={styles.peekPad}>
            {lines.map((l, k) => (
              <View key={l.idx} style={[styles.peekRow, dir.row]}>
                <View style={[styles.peekBar, { backgroundColor: barColors?.[k] ?? 'rgba(183,177,198,0.4)' }]} />
                <View style={styles.text}>
                  <Text style={[styles.ja, dir.content]}>{l.ja}</Text>
                  {l.en ? <Text style={[styles.en, dir.content]}>{l.en}</Text> : null}
                </View>
              </View>
            ))}
          </View>
        </ScrollView>
        <Fade edge="top" />
        <Fade edge="bottom" />
      </View>
    );
  }
  return (
    <View style={styles.body}>
      {lines.map((l, k) => {
        const skip = !pending && !used.has(l.idx);
        return (
          <View key={l.idx} style={[styles.sen, dir.row, skip && styles.skipRow]}>
            <Text style={[styles.n, dir.writing]}>{k + 1}</Text>
            <View style={styles.text}>
              <Text style={[styles.ja, dir.content, skip && styles.strike]}>{l.ja}</Text>
              {l.en ? <Text style={[styles.en, dir.content, skip && styles.strike]}>{l.en}</Text> : null}
            </View>
            {skip ? (
              <View style={styles.tag}>
                <Text style={styles.tagText}>{t('review.skipped')}</Text>
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

/** The peek list's soft edge: 6 stacked strips stepping the glass colour from opaque to clear (no gradient lib in the app). */
const FADE_STEPS = [0.9, 0.7, 0.5, 0.3, 0.15, 0.05];
function Fade({ edge }: { edge: 'top' | 'bottom' }) {
  const steps = edge === 'top' ? FADE_STEPS : [...FADE_STEPS].reverse();
  return (
    <View pointerEvents="none" style={[styles.fade, edge === 'top' ? styles.fadeTop : styles.fadeBottom]}>
      {steps.map((a) => (
        <View key={a} style={{ flex: 1, backgroundColor: `rgba(28,58,74,${a})` }} />
      ))}
    </View>
  );
}

// One peek row is a 19pt ja line, a 17pt en line and a 10pt gap; the list pads 12pt top and bottom, less one gap.
const PEEK_MAX_H = 258;
const PEEK_ROW_H = 46;
const PEEK_PAD_H = 14;

const styles = StyleSheet.create({
  peekBox: { borderRadius: 14, overflow: 'hidden', backgroundColor: 'rgba(6,16,24,0.45)' },
  peekScroll: { maxHeight: PEEK_MAX_H },
  peekPad: { paddingVertical: 12, paddingHorizontal: 12, gap: 10 },
  peekRow: { flexDirection: 'row', gap: 10, alignItems: 'stretch' },
  peekBar: { width: 5, borderRadius: 3 },
  fade: { position: 'absolute', start: 0, end: 0, height: 18 },
  fadeTop: { top: 0 },
  fadeBottom: { bottom: 0 },
  statePeek: { backgroundColor: 'transparent' },
  body: { backgroundColor: '#0A111E', paddingBottom: 6 },
  state: { backgroundColor: '#0A111E', minHeight: 72, alignItems: 'center', justifyContent: 'center' },
  dim: { fontSize: 13, color: tide.textDim, fontFamily: fonts.ui },
  sen: { flexDirection: 'row', gap: 10, paddingVertical: 7, paddingStart: 24, paddingEnd: 14, alignItems: 'flex-start' },
  skipRow: { backgroundColor: 'rgba(255,255,255,0.03)' },
  n: { width: 16, fontSize: 12, color: tide.textDim, opacity: 0.7, paddingTop: 2, fontFamily: fonts.ui },
  text: { flex: 1 },
  ja: { fontSize: 14, lineHeight: 19, color: tide.text, opacity: 0.82, fontFamily: fonts.ui },
  en: { fontSize: 13, lineHeight: 17, color: tide.textDim, opacity: 0.8, fontFamily: fonts.ui },
  strike: { opacity: 0.38, textDecorationLine: 'line-through' },
  tag: { marginTop: 2, borderWidth: 1, borderStyle: 'dashed', borderColor: 'rgba(183,177,198,0.5)', borderRadius: 6, paddingVertical: 1, paddingHorizontal: 6 },
  tagText: { fontSize: 11, letterSpacing: 0.55, textTransform: 'uppercase', color: tide.textDim, fontFamily: fonts.ui },
});
