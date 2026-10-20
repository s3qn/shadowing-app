import { memo, type ReactNode, useMemo, useState } from 'react';
import { type LayoutChangeEvent, StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';

import { type Highlight, useWordInk, wordIntensity } from '@/components/word-highlight';

import { fonts } from '@/constants/fonts';
import { tide } from '@/constants/theme';
import type { Word } from '@/lib/api';
import { type MoraPitch, moraCells, type PitchCell, runCells } from '@/lib/pitch';
import { kanaToRomaji } from '@/lib/romaji';

/** A grammar island's point (GR2-B3 `.ja b`). */
export const GRAMMAR_LILAC = '#C9B8FF';

type Props = {
  word: Word;
  /** Furigana above the kanji. Off, the word is one plain column. */
  showRuby: boolean;
  /** This word's index in the line, read against `highlight`. */
  index: number;
  /** The playing line's word highlight. Left out, the word never lights. */
  highlight?: Highlight;
  selected: boolean;
  /** Part of a grammar island's point: lilac and semibold (GR2-B3). */
  grammar?: boolean;
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
  /** Blind's frost is on: the lit colour, the pitch line, the part of
   * speech bar, the romaji and the take marks all go, since each gives the
   * text away. Their space stays, so the frost never moves anything. */
  concealed?: boolean;
  /** The video player's bigger type (26 pt, furigana 13 pt). */
  big?: boolean;
  /** Multiplies every font size and line height of the word (the active line
   * shrinks to fit two rows, see `fitScale`). Defaults to 1. */
  scale?: number;
  /** The furigana's resting colour. Defaults to the dim ink. */
  rubyColor?: string;
  /** The colour a lit word and its furigana fade to. Defaults to the Japanese accent. */
  litColor?: string;
  /** The furigana's font weight. Defaults to the style's own. */
  rubyWeight?: '600' | '700';
};

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
  grammar = false,
  dimmed,
  mark,
  onLayout,
  showPosAndRomaji = true,
  pitch,
  concealed = false,
  big = false,
  scale = 1,
  rubyColor,
  litColor,
  rubyWeight,
}: Props) {
  const sc = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const baseSize = useMemo(
    () => (big ? scaled(styles.baseBig, sc) : sc === 1 ? null : scaled({ fontSize: 22, lineHeight: BASE_LINE }, sc)),
    [big, sc],
  );
  const rtSize = useMemo(
    () => (big ? scaled(styles.rtBig, sc) : sc === 1 ? null : scaled({ fontSize: 10, lineHeight: RT_LINE }, sc)),
    [big, sc],
  );
  const romajiSize = useMemo(() => (sc === 1 ? null : scaled({ fontSize: 9, lineHeight: 11 }, sc)), [sc]);
  // Romaji shows only under the word being spoken (or the one selected). The
  // row is always rendered so the word's height never changes.
  // With no romaji row the style reads no highlight, so it never reruns per frame.
  const romajiHighlight = showPosAndRomaji && showRuby && !!word.ruby ? highlight : undefined;
  const romajiStyle = useAnimatedStyle(() => {
    if (selected) return { opacity: 1 };
    const v = romajiHighlight ? wordIntensity(romajiHighlight.value, index) : 0;
    return { opacity: Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0 };
  }, [romajiHighlight, index, selected]);
  const segments = showRuby && word.ruby?.some((s) => s.rt) ? word.ruby : null;
  // Lit and selected are both a colour change, never a filled chip: a solid
  // box behind one word reads as a UI control, not running text.
  const lit = concealed ? undefined : highlight;
  const inGrammar = grammar && !concealed;
  // The lilac is the base the karaoke ink fades from and back to, so the mark
  // survives the highlight passing over it.
  const baseInk = useWordInk(lit, index, inGrammar ? GRAMMAR_LILAC : dimmed ? tide.textDim : tide.text, litColor);
  const rubyInk = useWordInk(lit, index, rubyColor ?? tide.textDim, litColor);
  // A plain word that wraps onto a second row: the moras cannot be placed by
  // character any more, so its strip stays empty.
  const [wrapped, setWrapped] = useState(false);
  const markColor = concealed
    ? 'transparent'
    : mark === 'early' ? tide.listen : mark === 'late' ? tide.turn : mark === 'dropped' ? tide.record : 'transparent';
  const ink = inGrammar ? styles.grammar : null;
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
                <Animated.Text style={[styles.rt, rtSize, rubyInk, rubyWeight ? { fontWeight: rubyWeight } : null]}>{seg.rt}</Animated.Text>
                <Animated.Text style={[styles.base, baseSize, baseInk, ink]}>{seg.text}</Animated.Text>
              </View>
            );
          })
        ) : (
          <>
            {/* The empty ruby row as a sized box: an empty Text measures 0 tall
                on some platforms, which lifted a plain word (か。) above its
                neighbours' baseline. */}
            {showRuby ? <View style={{ height: rtSize?.lineHeight ?? RT_LINE }} /> : null}
            <Animated.Text
              style={[styles.base, baseSize, baseInk, ink]}
              onLayout={
                pitch
                  ? (e) => {
                      const next = e.nativeEvent.layout.height > BASE_LINE * sc * 1.5;
                      if (next !== wrapped) setWrapped(next);
                    }
                  : undefined
              }>
              {word.text}
            </Animated.Text>
          </>
        )}
      </View>
      {showPosAndRomaji ? (
        <>
          <View style={[styles.posBar, { backgroundColor: posColor }]} />
          {romaji ? (
            <Animated.Text style={[styles.romaji, romajiSize, concealed && styles.clear, romajiStyle]}>{romaji}</Animated.Text>
          ) : null}
        </>
      ) : null}
    </View>
  );
});

/** Height of the pitch strip over a word: the only space pitch adds. */
const STRIP = 6;
const BASE_LINE = 32;
const RT_LINE = 13;

/** A font size and line height pair, each multiplied by `k`. */
function scaled(v: { fontSize?: number; lineHeight?: number }, k: number) {
  return k === 1 ? v : { fontSize: (v.fontSize ?? 0) * k, lineHeight: (v.lineHeight ?? 0) * k };
}
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
  rt: { fontFamily: fonts.serifJp, fontSize: 10, lineHeight: RT_LINE, includeFontPadding: false },
  base: { fontFamily: fonts.serifJp, fontSize: 22, lineHeight: BASE_LINE, includeFontPadding: false },
  grammar: { fontWeight: '600' },
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
  baseBig: { fontSize: 26, lineHeight: 34 },
  rtBig: { fontSize: 13, lineHeight: 16 },
  strip: { height: STRIP, alignSelf: 'stretch', flexDirection: 'row' },
  bar: { position: 'absolute', left: 0, right: 0, height: STROKE, backgroundColor: PITCH_INK },
  high: { top: 0 },
  low: { bottom: 0 },
  step: { position: 'absolute', top: 0, width: STROKE, height: STRIP, backgroundColor: PITCH_INK },
  stepLeft: { left: 0 },
  stepRight: { right: 0 },
});
