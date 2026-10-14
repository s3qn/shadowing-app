import { memo, type ReactNode, useMemo, useState } from 'react';
import { type LayoutChangeEvent, StyleSheet, Text, View } from 'react-native';
import Animated, { interpolateColor, useAnimatedStyle } from 'react-native-reanimated';

import { type Highlight, useWordInk } from '@/components/word-highlight';

import { fonts } from '@/constants/fonts';
import { tide } from '@/constants/theme';
import type { Word } from '@/lib/api';
import { type MoraPitch, moraCells, type PitchCell, runCells } from '@/lib/pitch';
import { kanaToRomaji } from '@/lib/romaji';

type Props = {
  word: Word;
  /** Furigana above the kanji. Off, the word is one plain column. */
  showRuby: boolean;
  /** This word's index in the line, read against `highlight`. */
  index: number;
  /** The playing line's word highlight. Left out, the word never lights. */
  highlight?: Highlight;
  selected: boolean;
  /** Drawn in the muted colour (a word outside a phrase loop's span). */
  dimmed?: boolean;
  /** How the last take's timing scored this word: a coloured bottom border,
   * always present (transparent when unmarked) so layout does not jump. */
  mark?: 'early' | 'late' | 'dropped' | null;
  /** Layout inside the sentence block, for the popover under the word. Called
   * with this word's index, so one stable handler serves every word and the
   * memo below holds. */
  onLayout: (index: number, e: LayoutChangeEvent) => void;
  /** Part-of-speech bar and romaji row below the word. On unless turned off. */
  showPosAndRomaji?: boolean;
  /** The moras spoken in this word, for the pitch line over it. Left out, no
   * pitch strip at all; empty (a word with no moras), an empty strip so the
   * word keeps the same height as its neighbours. */
  pitch?: MoraPitch[];
  /** Blind's frost is on: the karaoke colour, the pitch line, the part of
   * speech bar, the romaji and the take marks all go, since each gives the
   * text away. Their space stays, so the frost never moves anything. */
  concealed?: boolean;
  /** Video player karaoke: bigger left-aligned type, sung / lit / next colours
   * and a clipped colour sweep inside the lit word, all read from `highlight`
   * on the UI thread. 'step' swaps the sweep for a word-by-word colour step
   * (reduced motion). Left out, the word renders exactly as before. */
  karaoke?: 'sweep' | 'step';
};

const K_SUNG = '#F2F3FA';
const K_LIT = '#7CC8FF';
const K_NEXT = '#9AA2C8';

/** Karaoke state of one word from the shared level: `a` is how far the lit
 * colour has entered it (0..1), `b` how far it has handed off to sung (0..1).
 * Idle (nothing on), every word reads as sung so a paused line stays legible. */
function karaokeParts(h: { level: number; on: number; from: number; to: number }, i: number, step: boolean) {
  'worklet';
  if (h.on === 0 || h.level < 0) return { a: 0, b: 1 };
  let a = Math.min(1, Math.max(0, h.level - i));
  let b = Math.min(1, Math.max(0, h.level - i - 1));
  if (step) {
    a = a >= 0.5 ? 1 : 0;
    b = b >= 0.5 ? 1 : 0;
  }
  return { a, b };
}

/** One run of text with the karaoke colour. The base text blends next to sung
 * as the word hands off; a clipped copy in the lit colour grows from the left
 * with the entry fraction, covering this run's share [k/n, (k+1)/n] of the word.
 * `ruby` runs (furigana) only change colour, they do not sweep. */
function KaraokeText({
  text,
  style,
  highlight,
  index,
  k,
  n,
  step,
  ruby,
}: {
  text: string;
  style: object;
  highlight: Highlight;
  index: number;
  k: number;
  n: number;
  step: boolean;
  ruby?: boolean;
}) {
  const [w, setW] = useState(0);
  const base = useAnimatedStyle(() => {
    const { a, b } = karaokeParts(highlight.value, index, step);
    // Not the lit word: b is exactly 0 or 1, so the colour is a constant.
    if (b === 1) return { color: K_SUNG };
    if (b === 0 && a === 0) return { color: K_NEXT };
    if (ruby) return { color: interpolateColor(b, [0, 1], [a >= 0.5 ? K_LIT : K_NEXT, K_SUNG]) };
    return { color: interpolateColor(b, [0, 1], [K_NEXT, K_SUNG]) };
  });
  // The lit copy is a fixed-width overlay revealed from the left by translateX,
  // not a per-frame width (which would force a Yoga relayout every frame). The
  // clip window slides left by the hidden slice and the text slides the same
  // amount right, so the text stays put and only its left `local` shows.
  const reveal = useAnimatedStyle(() => {
    const { a, b } = karaokeParts(highlight.value, index, step);
    // Sung (b = 1) or not yet reached (a = 0): a fixed hidden state.
    if (b === 1 || a === 0) return { transform: [{ translateX: -w }], opacity: 0 };
    const local = Math.min(1, Math.max(0, a * n - k));
    return { transform: [{ translateX: -w * (1 - local) }], opacity: 1 - b };
  });
  const inner = useAnimatedStyle(() => {
    const { a, b } = karaokeParts(highlight.value, index, step);
    if (b === 1 || a === 0) return { transform: [{ translateX: w }] };
    const local = Math.min(1, Math.max(0, a * n - k));
    return { transform: [{ translateX: w * (1 - local) }] };
  });
  return (
    <View
      onLayout={(e) => {
        const next = e.nativeEvent.layout.width;
        setW((prev) => (prev === next ? prev : next));
      }}>
      <Animated.Text style={[style, base]}>{text}</Animated.Text>
      {ruby ? null : (
        <Animated.View pointerEvents="none" style={[styles.clip, { width: w }, reveal]}>
          <Animated.Text numberOfLines={1} style={[style, { color: K_LIT, width: w }, inner]}>
            {text}
          </Animated.Text>
        </Animated.View>
      )}
    </View>
  );
}

/**
 * One word of the line. React Native has no ruby text, so a word with
 * furigana is a wrapping row of columns: each kanji run with its reading
 * above it, each kana run with an empty ruby row so every word in the sentence
 * is the same height. A word with no reading to show is one Text, so a long
 * chunk (a whole-line fallback) wraps like any sentence. Either way the
 * highlight and the selected tint cover the whole word. A plain View: the
 * screen's single gesture on the sentence block does the hit-testing and
 * calls the tap or drag handlers itself.
 *
 * With `pitch`, a thin line runs over the top of the word, dictionary style:
 * high over high moras, low over low ones, a step up at a rise and a tick
 * down at the accent drop. In furigana each column carries its own moras, so
 * the line follows the reading; otherwise the moras share the word's width by
 * the characters they are written with.
 *
 * Memoised: the player screen renders on every playing, loaded and countdown
 * change, and none of those change a word.
 */
export const RubyWord = memo(function RubyWord({
  word,
  showRuby,
  index,
  highlight,
  selected,
  dimmed,
  mark,
  onLayout,
  showPosAndRomaji = true,
  pitch,
  concealed = false,
  karaoke,
}: Props) {
  const kStep = karaoke === 'step';
  const baseSize = karaoke ? styles.baseK : null;
  const rtSize = karaoke ? styles.rtK : null;
  const useK = !!karaoke && !concealed && !!highlight;
  const segments = showRuby && word.ruby?.some((s) => s.rt) ? word.ruby : null;
  // Lit and selected are both a colour change, never a filled chip: a solid
  // box behind one word reads as a UI control, not running text. The lit
  // word's glow lives in WordOutline, which reads the same highlight value.
  const lit = concealed ? undefined : highlight;
  const baseInk = useWordInk(lit, index, dimmed ? tide.textDim : tide.text);
  const rubyInk = useWordInk(lit, index, tide.textDim);
  // A plain word that wraps onto a second row: the moras cannot be placed by
  // character any more, so its strip stays empty.
  const [wrapped, setWrapped] = useState(false);
  const markColor = concealed
    ? 'transparent'
    : mark === 'early' ? tide.listen : mark === 'late' ? tide.turn : mark === 'dropped' ? tide.record : 'transparent';
  const posColor = concealed ? 'transparent' : tide.pos[word.pos ?? 'other'];
  const romaji = useMemo(
    () => (showRuby && word.ruby ? kanaToRomaji(word.ruby.map((s) => s.rt || s.text).join('')) : ''),
    [showRuby, word],
  );

  // Per run of text, where its moras sit. Used only when the runs account for
  // exactly the moras spoken; otherwise the moras share the whole word evenly.
  const runs = pitch ? (word.ruby ?? [{ text: word.text, rt: '' }]).map((s) => runCells(s.text, s.rt)) : null;
  const fits = !!pitch && !!runs && runs.reduce((n, r) => n + moraCells(r), 0) === pitch.length;
  const even: PitchCell[] = pitch ? pitch.map(() => ({ w: 1, mora: true })) : [];
  const perColumn = !!segments && fits;
  // Where each column's moras start in `pitch`: `runs` is built from the same
  // ruby segments the columns map over, so column i reads runs[i].
  const columnStarts: number[] = [];
  if (perColumn && runs) {
    let n = 0;
    for (const cells of runs) {
      columnStarts.push(n);
      n += moraCells(cells);
    }
  }

  let wordStrip: ReactNode = null;
  if (pitch && !perColumn) {
    if (!segments && wrapped) wordStrip = <PitchStrip cells={[]} pitch={[]} />;
    else if (!segments && fits) wordStrip = <PitchStrip cells={runs!.flat()} pitch={pitch} concealed={concealed} />;
    else wordStrip = <PitchStrip cells={even} pitch={pitch} concealed={concealed} />;
  }

  return (
    <View
      onLayout={(e) => onLayout(index, e)}
      style={[
        styles.word,
        styles.column,
        {
          // No radius here: adjoining selected words must merge into one
          // continuous run, not a row of separate rounded chips.
          backgroundColor: selected ? 'rgba(255,158,128,0.26)' : 'transparent',
          borderBottomWidth: 3,
          borderBottomColor: markColor,
        },
      ]}>
      {wordStrip}
      <View style={segments ? styles.rubyRow : styles.plain}>
        {segments ? (
          segments.map((seg, i) => {
            const cells = perColumn ? runs![i]! : null;
            const from = columnStarts[i] ?? 0;
            return (
              <View key={i} style={styles.segment}>
                {cells ? (
                  <PitchStrip cells={cells} pitch={pitch!.slice(from, from + moraCells(cells))} concealed={concealed} />
                ) : null}
                {useK ? (
                  <>
                    <KaraokeText text={seg.rt} style={[styles.rt, rtSize!]} highlight={highlight!} index={index} k={i} n={segments.length} step={kStep} ruby />
                    <KaraokeText text={seg.text} style={[styles.base, baseSize!]} highlight={highlight!} index={index} k={i} n={segments.length} step={kStep} />
                  </>
                ) : (
                  <>
                    <Animated.Text style={[styles.rt, rtSize, rubyInk]}>{seg.rt}</Animated.Text>
                    <Animated.Text style={[styles.base, baseSize, baseInk]}>{seg.text}</Animated.Text>
                  </>
                )}
              </View>
            );
          })
        ) : (
          <>
            {showRuby ? <Text style={[styles.rt, rtSize]}>{''}</Text> : null}
            {useK ? (
              <KaraokeText text={word.text} style={[styles.base, baseSize!]} highlight={highlight!} index={index} k={0} n={1} step={kStep} />
            ) : (
            <Animated.Text
              style={[styles.base, baseSize, baseInk]}
              onLayout={
                pitch
                  ? (e) => {
                      const next = e.nativeEvent.layout.height > BASE_LINE * 1.5;
                      if (next !== wrapped) setWrapped(next);
                    }
                  : undefined
              }>
              {word.text}
            </Animated.Text>
            )}
          </>
        )}
      </View>
      {showPosAndRomaji ? (
        <>
          <View style={[styles.posBar, { backgroundColor: posColor }]} />
          {romaji ? <Text style={[styles.romaji, concealed && styles.clear]}>{romaji}</Text> : null}
        </>
      ) : null}
    </View>
  );
});

/** Height of the pitch strip over a word: the only space pitch adds. */
const STRIP = 6;
const BASE_LINE = 32;
const STROKE = 1.5;

/** The pitch line over one run of cells, drawn with plain Views: a bar per
 * mora at the top (high) or the bottom (low) of the strip, and a vertical
 * bar for each rise and drop. Concealed, the strip keeps its height and
 * draws nothing. */
function PitchStrip({ cells, pitch, concealed }: { cells: PitchCell[]; pitch: MoraPitch[]; concealed?: boolean }) {
  if (concealed) return <View style={styles.strip} pointerEvents="none" />;
  // Which mora each cell shows, -1 for a cell with none.
  const moraAt: number[] = [];
  let k = 0;
  for (const cell of cells) {
    moraAt.push(cell.mora ? k : -1);
    if (cell.mora) k += 1;
  }
  return (
    <View style={styles.strip} pointerEvents="none">
      {cells.map((cell, i) => {
        const m = moraAt[i] ?? -1;
        const p = m >= 0 ? pitch[m] : undefined;
        return (
          <View key={i} style={{ flex: cell.w }}>
            {p ? (
              <>
                <View style={[styles.bar, p.high ? styles.high : styles.low]} />
                {p.rise ? <View style={[styles.step, styles.stepLeft]} /> : null}
                {p.drop ? <View style={[styles.step, styles.stepRight]} /> : null}
              </>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

// tide.lang.ja at 70%, so a bar and a step that overlap at a corner do not
// double up the way view opacity would.
const PITCH_INK = 'rgba(255,158,128,0.7)';

const styles = StyleSheet.create({
  word: {
    flexShrink: 1,
    maxWidth: '100%',
    paddingHorizontal: 4,
  },
  column: { flexDirection: 'column' },
  rubyRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end' },
  plain: { flexDirection: 'column', justifyContent: 'flex-end' },
  segment: { alignItems: 'center', flexShrink: 1, maxWidth: '100%' },
  rt: { fontFamily: fonts.serifJp, fontSize: 10, lineHeight: 13, includeFontPadding: false },
  base: { fontFamily: fonts.serifJp, fontSize: 22, lineHeight: BASE_LINE, includeFontPadding: false },
  posBar: { height: 2, borderRadius: 1, marginTop: 2, alignSelf: 'stretch' },
  romaji: {
    fontFamily: fonts.ui,
    fontSize: 9,
    lineHeight: 11,
    color: tide.textDim,
    textAlign: 'center',
    includeFontPadding: false,
  },
  clear: { color: 'transparent' },
  baseK: { fontSize: 26, lineHeight: 34 },
  rtK: { fontSize: 13, lineHeight: 16 },
  clip: { position: 'absolute', left: 0, top: 0, bottom: 0, overflow: 'hidden' },
  strip: { height: STRIP, alignSelf: 'stretch', flexDirection: 'row' },
  bar: { position: 'absolute', left: 0, right: 0, height: STROKE, backgroundColor: PITCH_INK },
  high: { top: 0 },
  low: { bottom: 0 },
  step: { position: 'absolute', top: 0, width: STROKE, height: STRIP, backgroundColor: PITCH_INK },
  stepLeft: { left: 0 },
  stepRight: { right: 0 },
});
