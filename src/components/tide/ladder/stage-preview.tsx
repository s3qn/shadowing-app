// focus-stories D4: the still page on the cube's other face, a neighbour island as
// its stage would open. Owner: Bob G1 (this file, cube-stage.tsx and use-cube-pan.ts only).
//
// Still on purpose, and laid out exactly as the live island stage opens at its first
// step: the stage's sky, the top row (chevron, `?`), the bar at rest with the same
// segment count, the sentence dots, "Listen · 1 of N", "Line n / M" from the cached
// island and its saved line, the resume line as the stage's own `Sentence` (ruby,
// colours, the same fit, so the same size and wrap), the empty score slot, the hint
// ("Listen: get ready") and the chips (step, speed, pace, Easy). No gesture and no
// animation: it mounts once and never renders in a drag. The island draws it as the
// hop cover too, so a cube turn lands on this same picture until the live stage has
// fitted under it. With no cached copy the page shows the sky, the bar and the
// labels only: the neighbour comes as an id, and the id alone has no title.
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { StageChips } from '@/components/tide/ladder/chips';
import { Sentence } from '@/components/tide/ladder/sentence';
import { SentenceDots } from '@/components/tide/ladder/sentence-dots';
import { StillHint } from '@/components/tide/ladder/stage-hint';
import { STEPS } from '@/components/tide/ladder/stage-model';
import { StageSky } from '@/components/tide/ladder/stage-sky';
import { LadderHelpButton } from '@/components/tide/ladder/stage-tile';
import { CHIPS_H, noop, SCORE_H, SLOT_GAP, TRACK } from '@/components/tide/ladder/stage-tokens';
import { fonts } from '@/constants/fonts';
import { tide, tideSkies, withAlpha } from '@/constants/theme';
import type { Line } from '@/lib/api';
import { devBlindTake } from '@/lib/dev-simulate';
import { useDir, useT } from '@/lib/i18n';
import { peekCachedIsland, prefetchIsland } from '@/lib/island-cache';
import { peekLastLine, resumeLine } from '@/lib/last-line';
import { getSettingsSync } from '@/lib/settings';
import { peekRung } from '@/lib/speed-ladder';

type Peek = { count: number; index: number; line: Line | null; text: string; known: boolean; speed: number } | null;

/** The neighbour as its stage would open, from the memory or local copy, or null without one. */
function peek(id: string | undefined): Peek {
  if (!id) return null;
  const cached = peekCachedIsland(id);
  if (!cached) return null;
  const count = cached.island.lines.length || cached.island.line_count;
  const index = resumeLine(peekLastLine(id), count);
  const line = cached.island.lines[index] ?? null;
  const known = !!line && !!cached.island.known?.includes(line.idx);
  const speed = peekRung(id)?.speed ?? getSettingsSync().defaultSpeed;
  return { count, index, line, text: line?.ja ?? '', known, speed };
}

const FIRST = STEPS[0]!;
/** The last measured body height: every preview has the same frame, so the hop cover's first frame
 * already has the room the cube's face measured, and draws its sentence at once. */
let lastBody = 0;

/** Same layout as the live island stage at its first step, under the stage root's top inset. */
export function StagePreview({ id }: { id?: string }) {
  const { t } = useT();
  const dir = useDir();
  const insets = useSafeAreaInsets();
  const [isle, setIsle] = useState<Peek>(() => peek(id));
  // No copy at mount: wait on the neighbour's fetch (shared with the hop hook's), so the face fits
  // its sentence before any swipe and the hop cover opens on it.
  useEffect(() => {
    if (isle || !id) return;
    let alive = true;
    void prefetchIsland(id).then(() => {
      if (alive) setIsle(peek(id));
    });
    return () => {
      alive = false;
    };
  }, [isle, id]);
  const [body, setBody] = useState(lastBody);
  const measured = (v: number) => {
    const n = Math.round(v) || 0;
    // Without an island the dots and the line count are missing, so that body is not the stage's.
    if (isle && isle.count > 0) lastBody = n;
    setBody(n);
  };
  // The live stage's bar has the Final take segment while the blind take is on (use-ladder's `finalOn`).
  const segs = (devBlindTake() ?? getSettingsSync().blindTake) ? 6 : 5;
  const hintBottom = insets.bottom + 16;
  // The sentence's room, as the stage computes it (an island stage always has its chips).
  const textMax = body > 0 ? Math.max(1, body - SCORE_H - SLOT_GAP - hintBottom - 36 - CHIPS_H) : 0;
  const name = t(FIRST.name);
  const tint = FIRST.look.tint;
  const pace = getSettingsSync().ladderPace;
  return (
    <View style={styles.root}>
      <StageSky />
      <View style={[styles.top, dir.row]}>
        <View style={styles.chev}>
          <Text style={styles.chevGlyph}>{dir.rtl ? '›' : '‹'}</Text>
        </View>
        <LadderHelpButton onPress={noop} />
      </View>
      <View style={[styles.segs, dir.row]}>
        {Array.from({ length: segs }, (_, i) => (
          <View key={i} style={styles.segHit}>
            <View style={styles.seg} />
          </View>
        ))}
      </View>
      {isle && isle.count > 0 ? <SentenceDots index={isle.index} count={isle.count} tint={tint} /> : null}
      <View style={[styles.lab, dir.row]}>
        <Text style={[styles.labDim, dir.text]} numberOfLines={1}>
          <Text style={styles.labName}>{name}</Text>
          {` · ${t('ladder.stepCount', { n: 1, total: segs })}`}
        </Text>
        {isle ? <Text style={[styles.labDim, styles.tabular, dir.text]}>{t('ladder.lineSlash', { n: isle.index + 1, total: isle.count })}</Text> : null}
      </View>
      <View style={styles.body} onLayout={(e) => measured(e.nativeEvent.layout.height)}>
        <View style={styles.centre}>
          {isle && textMax > 0 ? (
            <Sentence
              p={{ round: 1, speaker: false, line: isle.line, text: isle.text, lineIndex: isle.index }}
              frame="listen"
              hidden={false}
              maxH={textMax}
              counting={false}
              countRun={0}
              tint={tint}
              sweepMs={0}
            />
          ) : null}
          <View style={styles.slot} />
        </View>
        <StillHint text={t('player.announce', { name })} hintBottom={hintBottom} />
      </View>
      <StageChips
        speedChip={isle ? isle.speed : getSettingsSync().defaultSpeed}
        paceChip={pace}
        easy={{ on: !!isle?.known, onPress: noop }}
        onSpeed={noop}
        onPace={noop}
        onLong={noop}
        hintBottom={hintBottom}
        paused={false}
        chipsStyle={null}
        stepName={name}
        onStep={noop}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // The stage root's colour under the sky, so the first frame before the sky draws is the stage's too.
  root: { flex: 1, backgroundColor: tideSkies.night[0] },
  // The stage's `.top`, `.chev` and `.chevGlyph` (ladder-stage.tsx).
  top: { height: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16 },
  chev: { minWidth: 26, height: 30, justifyContent: 'center' },
  chevGlyph: { fontSize: 26, lineHeight: 30, color: withAlpha(tide.text, 0.36) },
  // The Stories bar at rest (step-bar.tsx `.segs`): 4pt segments, 4pt apart, in a 24pt row.
  segs: { marginTop: 4, marginHorizontal: 16, flexDirection: 'row', gap: 4 },
  segHit: { flex: 1, height: 24, justifyContent: 'center' },
  seg: { height: 4, borderRadius: 2, backgroundColor: TRACK },
  lab: { marginTop: 8, marginHorizontal: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  labName: { fontFamily: fonts.uiMedium, fontWeight: '600', color: tide.text },
  labDim: { fontFamily: fonts.ui, fontSize: 13, color: tide.textDim, flexShrink: 1 },
  tabular: { fontVariant: ['tabular-nums'] },
  body: { flex: 1 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  // The score slot at rest (score-slot.tsx `.slot`).
  slot: { height: SCORE_H, marginTop: SLOT_GAP, alignSelf: 'stretch' },
});
