import { memo, type ReactNode, useMemo, useState } from 'react';
import { type LayoutChangeEvent, type StyleProp, StyleSheet, type TextStyle, View } from 'react-native';
import Animated, { interpolateColor, type SharedValue, useAnimatedReaction, useAnimatedStyle } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { type Highlight, useWordInk, wordIntensity } from '@/components/word-highlight';

import { fonts } from '@/constants/fonts';
import { tide } from '@/constants/theme';
import type { Word } from '@/lib/api';
import { PitchStrip } from '@/components/pitch-strip';
import { type MoraPitch, moraCells, type PitchCell, runCells } from '@/lib/pitch';
import { BLUR_BY_OFFSET, blurGlyph, blurK, blurPad, blurShadow, GRAIN_SCATTER, mulberry32, rgbOf, textBlur } from '@/lib/text-blur';
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
  /** One colour for the word and its furigana (the ladder's count-in shimmer copies). */
  color?: string;
  /** The Final take's blur, 0 sharp to 1 a soft shape (see `textBlur`), on the word and its furigana. */
  blur?: SharedValue<number>;
  /**
   * The Final take's grain (V4 "Grain", research/pre-animator/final-take-blur/recipe.md): with `blur`,
   * each character is its own Text that dissolves on its own in a fixed scattered order. `seed` is the
   * line's seed, `span` each character's share of the blur (`blurSpan`). The furigana follows the first
   * character under it.
   */
  grain?: { seed: number; span: number };
  /**
   * The word never wraps inside itself (the ladder's stage sentence): its columns stay on one row at
   * their full width, so the caller sees the real width and steps the size down instead.
   */
  noWrap?: boolean;
};

/**
 * The ink at blur `k`: past 0 the soft shape (`textBlur`, its radius scaled by the type's size; on iOS
 * the glyph alone, `glyphOnly`, its shape drawn by a second Text), else the highlight's colour, so the
 * highlight shows only while sharp.
 */
function inkAt(k: number, rgb: string, scale: number, highlight: Highlight | undefined, index: number, base: string, lit: string, glyphOnly: boolean) {
  'worklet';
  if (k > 0.001) return glyphOnly ? blurGlyph(k, rgb) : textBlur(k, rgb, scale);
  const v = highlight ? wordIntensity(highlight.value, index) : 0;
  const color = v <= 0 ? base : v >= 1 ? lit : interpolateColor(v, [0, 1], [base, lit]);
  return { color, textShadowColor: 'transparent', textShadowOffset: { width: 0, height: 0 }, textShadowRadius: 0 };
}

type BlurTextProps = {
  text: string;
  /** The line's blur, 0 sharp to 1 a soft shape. */
  blur: SharedValue<number>;
  /** The grain (V4): this Text's share of the blur starts at `at` and takes `span`. No span, the blur as is. */
  at?: number;
  span?: number;
  /** The text's size over 22pt, for the shadow's radius. */
  scale: number;
  highlight?: Highlight;
  index?: number;
  base: string;
  lit?: string;
  style: StyleProp<TextStyle>;
  onLayout?: (e: LayoutChangeEvent) => void;
};

/**
 * A Text under the Final take's blur (a whole word, a furigana run, a grain character or the plain
 * line), its share of the blur derived in its own worklet from the one shared value, so no render runs
 * per frame. Web and Android draw it as one Text whose glyph fades under its own shadow (`textBlur`).
 */
function ShadowBlurText({ text, blur, at = 0, span = 0, scale, highlight, index = 0, base, lit = tide.lang.ja, style, onLayout }: BlurTextProps) {
  const rgb = rgbOf(base);
  const ink = useAnimatedStyle(() => inkAt(blurK(blur.value, at, span), rgb, scale, highlight, index, base, lit, false), [blur, at, span, rgb, scale, highlight, index, base, lit]);
  return <Animated.Text style={[style, ink]} onLayout={onLayout}>{text}</Animated.Text>;
}

/**
 * iOS: a transparent glyph casts no shadow there, so the glyph fades on its own and a second, opaque
 * copy sits `lift` points below it, out of view in a clipping box, its shadow offset back up onto the
 * text. The copy and the box are padded by the widest shadow's room (`blurPad`), since iOS clips a
 * Text's drawing to its own box. Neither moves the layout: the sharp Text alone takes space. The
 * copy is mounted only while the blur is above 0 (`soft`), so a sharp line is one Text per word.
 */
function OffsetBlurText({ text, blur, at = 0, span = 0, scale, highlight, index = 0, base, lit = tide.lang.ja, style, onLayout }: BlurTextProps) {
  const rgb = rgbOf(base);
  const pad = blurPad(scale);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const [soft, setSoft] = useState(false);
  useAnimatedReaction(
    () => Number.isFinite(blur.value) && blur.value > 0.001,
    (on, was) => {
      if (on !== was) scheduleOnRN(setSoft, on);
    },
    [blur],
  );
  const lift = box ? box.h + pad + 2 : 0;
  const glyph = useAnimatedStyle(() => inkAt(blurK(blur.value, at, span), rgb, scale, highlight, index, base, lit, true), [blur, at, span, rgb, scale, highlight, index, base, lit]);
  const shape = useAnimatedStyle(() => blurShadow(blurK(blur.value, at, span), rgb, scale, lift), [blur, at, span, rgb, scale, lift]);
  return (
    <View>
      <Animated.Text
        style={[style, glyph]}
        onLayout={(e) => {
          const { width: w, height: h } = e.nativeEvent.layout;
          if (Number.isFinite(w) && Number.isFinite(h) && (box?.w !== w || box?.h !== h)) setBox({ w, h });
          onLayout?.(e);
        }}>
        {text}
      </Animated.Text>
      {soft && box && text ? (
        <View pointerEvents="none" style={[styles.shapeBox, { left: -pad, top: -pad, width: box.w + pad * 2, height: box.h + pad * 2 }]}>
          <Animated.Text style={[style, styles.shape, { width: box.w + pad * 2 + 1, paddingLeft: pad, paddingRight: pad + 1, paddingTop: lift + pad, paddingBottom: pad }, shape]}>
            {text}
          </Animated.Text>
        </View>
      ) : null}
    </View>
  );
}

/** The blurred Text, drawn the way this platform can (see `BLUR_BY_OFFSET`). */
const BlurText = memo(BLUR_BY_OFFSET ? OffsetBlurText : ShadowBlurText);
export { BlurText };

/**
 * The grain's scatter for one word, per ruby segment and character: `GRAIN_SCATTER * rand` from a
 * stream seeded by the line's seed and the word's index, so the order is fixed for the line and each
 * word draws its own without knowing where in the line it sits.
 */
function grainStarts(seed: number, index: number, runs: string[]): number[][] {
  const rand = mulberry32(seed * 7919 + index * 104729);
  return runs.map((run) => Array.from(run).map(() => GRAIN_SCATTER * rand()));
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
  color,
  blur,
  grain,
  noWrap = false,
}: Props) {
  const sc = Number.isFinite(scale) && scale > 0 ? scale : 1;
  // The blur's shadow radius grows with the type: 8pt at 22pt, the furigana's with its base.
  const radiusScale = ((big ? 26 : 22) * sc) / 22;
  // The grain: per-character Texts, each with its own start in the blur; only with a blur to read.
  const perChar = !!grain && !!blur;
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
  // With a blur each Text is a BlurText carrying its own ink, so these two serve only the sharp players.
  const baseColor = color ?? (inGrammar ? GRAMMAR_LILAC : dimmed ? tide.textDim : tide.text);
  const rubyBase = color ?? rubyColor ?? tide.textDim;
  const baseInk = useWordInk(lit, index, baseColor, litColor);
  const rubyInk = useWordInk(lit, index, rubyBase, litColor);
  const rtStyle = [styles.rt, rtSize, rubyWeight ? { fontWeight: rubyWeight } : null];
  const baseStyle = [styles.base, baseSize, inGrammar ? styles.grammar : null];
  // Where each character starts in the blur, per ruby segment (one run for a plain word), fixed per line.
  const starts = useMemo(
    () => (grain ? grainStarts(grain.seed, index, (segments ?? [{ text: word.text, rt: '' }]).map((s) => s.text)) : null),
    [grain, index, segments, word.text],
  );
  // A plain word that wraps onto a second row: the moras cannot be placed by
  // character any more, so its strip stays empty.
  const [wrapped, setWrapped] = useState(false);
  const wrapCheck = pitch
    ? (e: LayoutChangeEvent) => {
        const next = e.nativeEvent.layout.height > BASE_LINE * sc * 1.5;
        if (next !== wrapped) setWrapped(next);
      }
    : undefined;
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
        noWrap ? styles.wordWhole : styles.word,
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
      <View style={segments ? (noWrap ? styles.rubyRowWhole : styles.rubyRow) : styles.plain}>
        {segments ? (
          segments.map((seg, i) => {
            const cells = perColumn ? runs![i]! : null;
            const from = columnStarts[i] ?? 0;
            return (
              <View key={i} style={noWrap ? styles.segmentWhole : styles.segment}>
                {cells ? (
                  <PitchStrip cells={cells} pitch={pitch!.slice(from, from + moraCells(cells))} concealed={concealed} />
                ) : null}
                {perChar && starts ? (
                  <>
                    {/* The furigana follows the first character under it. */}
                    <BlurText text={seg.rt} at={starts[i]?.[0] ?? 0} span={grain!.span} blur={blur!} scale={radiusScale} highlight={lit} index={index} base={rubyBase} lit={litColor} style={rtStyle} />
                    <View style={styles.chars}>
                      {Array.from(seg.text).map((ch, ci) => (
                        <BlurText key={ci} text={ch} at={starts[i]?.[ci] ?? 0} span={grain!.span} blur={blur!} scale={radiusScale} highlight={lit} index={index} base={baseColor} lit={litColor} style={baseStyle} />
                      ))}
                    </View>
                  </>
                ) : blur ? (
                  <>
                    <BlurText text={seg.rt} blur={blur} scale={radiusScale} highlight={lit} index={index} base={rubyBase} lit={litColor} style={rtStyle} />
                    <BlurText text={seg.text} blur={blur} scale={radiusScale} highlight={lit} index={index} base={baseColor} lit={litColor} style={baseStyle} />
                  </>
                ) : (
                  <>
                    <Animated.Text style={[styles.rt, rtSize, rubyInk, rubyWeight ? { fontWeight: rubyWeight } : null]}>{seg.rt}</Animated.Text>
                    <Animated.Text style={[styles.base, baseSize, baseInk, ink]}>{seg.text}</Animated.Text>
                  </>
                )}
              </View>
            );
          })
        ) : (
          <>
            {/* The empty ruby row as a sized box: an empty Text measures 0 tall
                on some platforms, which lifted a plain word (か。) above its
                neighbours' baseline. */}
            {showRuby ? <View style={{ height: rtSize?.lineHeight ?? RT_LINE }} /> : null}
            {perChar && starts ? (
              // A row of characters never wraps, so no wrap check: the unit wrapper above keeps the line breaking.
              <View style={styles.chars}>
                {Array.from(word.text).map((ch, ci) => (
                  <BlurText key={ci} text={ch} at={starts[0]?.[ci] ?? 0} span={grain!.span} blur={blur!} scale={radiusScale} highlight={lit} index={index} base={baseColor} lit={litColor} style={baseStyle} />
                ))}
              </View>
            ) : blur ? (
              <BlurText text={word.text} blur={blur} scale={radiusScale} highlight={lit} index={index} base={baseColor} lit={litColor} style={baseStyle} onLayout={wrapCheck} />
            ) : (
              <Animated.Text style={[styles.base, baseSize, baseInk, ink]} onLayout={wrapCheck}>
                {word.text}
              </Animated.Text>
            )}
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

const BASE_LINE = 32;
const RT_LINE = 13;

/** A font size and line height pair, each multiplied by `k`. */
function scaled(v: { fontSize?: number; lineHeight?: number }, k: number) {
  return k === 1 ? v : { fontSize: (v.fontSize ?? 0) * k, lineHeight: (v.lineHeight ?? 0) * k };
}

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
  // `noWrap`: one row, no shrink and no width clamp, so Yoga's rounding can never push a column to a new row.
  wordWhole: { flexShrink: 0, paddingHorizontal: 4 },
  rubyRowWhole: { flexDirection: 'row', flexWrap: 'nowrap', alignItems: 'flex-end' },
  segmentWhole: { alignItems: 'center', flexShrink: 0 },
  // iOS's blur: the clipping box around a Text and the out-of-view copy whose shadow is the soft shape.
  shapeBox: { position: 'absolute', overflow: 'hidden' },
  shape: { position: 'absolute', left: 0, top: 0 },
  // The grain's characters, side by side as one run.
  chars: { flexDirection: 'row', alignItems: 'flex-end' },
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
});
