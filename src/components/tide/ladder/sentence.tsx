// The centred sentence (mock 7 `.jp`): the words in RubyWord or the plain line, fitted to
// the body, with the count-in's grey copy and band and the Final take's blur over it.
// Split out of ladder-stage.tsx as a pure move, no behaviour change.
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, { useReducedMotion } from 'react-native-reanimated';

import { BlurText, RubyWord } from '@/components/ruby-word';
import { BandWindow } from '@/components/tide/ladder/band-window';
import type { Frame } from '@/components/tide/ladder/stage-model';
import { BAND, BODY_PAD_H, COUNT_GREY, noop, PLAIN_INK, towardWhite, XP_GOLD } from '@/components/tide/ladder/stage-tokens';
import { useCountIn } from '@/components/tide/ladder/use-count-in';
import { useSentenceBlur } from '@/components/tide/ladder/use-sentence-blur';
import { useSentenceFit } from '@/components/tide/ladder/use-sentence-fit';
import { fonts } from '@/constants/fonts';
import type { LadderStageProps, SentenceHit, WordBox } from '@/hooks/ladder/ladder-types';
import { useT } from '@/lib/i18n';
import { kinsokuUnits } from '@/lib/kinsoku';

/**
 * The centred sentence (mock 7 `.jp`): 36pt down to 20pt to fit the body, the
 * furigana and POS colours of RubyWord, the highlight while the model line plays,
 * and the Final take's blur of the whole sentence. Transparent: no box, rim or chips.
 * Through the announce and count it waits in grey under the step colour's sweep
 * (`counting`); `countRun` restarts that for a new count-in that follows straight on.
 * `onFitted` is told once the line has its size (each line, each new room). The still
 * preview draws it from the same fields, so both fit to the same size and wrap.
 */
export function Sentence({ p, frame, hidden, maxH, counting, countRun, tint, sweepMs, hitRef, onFitted }: { p: Pick<LadderStageProps, 'round' | 'speaker' | 'line' | 'text' | 'lineIndex' | 'highlight'>; frame: Frame; hidden: boolean; maxH: number; counting: boolean; countRun: number; tint: string; sweepMs: number; hitRef?: RefObject<SentenceHit | null>; onFitted?: () => void }) {
  const reduced = useReducedMotion();
  const { t } = useT();
  const { width } = useWindowDimensions();
  // The Final take (round 2, the blind take): its count-in is the grain blur itself (V4 "Grain",
  // research/pre-animator/final-take-blur/recipe.md), no grey dim and no band; the take starts once
  // the text is fully soft. `countMs` is the whole count's length. Bob P fills these in.
  const final = p.round === 2;
  const { blur, greyStyle, grain } = useSentenceBlur(hidden, counting, { final, countMs: sweepMs });
  const { sweep, bandW, greyOn, textStyle } = useCountIn({ counting, countRun, hidden, sweepMs, final, countMs: sweepMs });
  // The highlight wherever the model line plays: Listen, Mumble, Read along, Compare, and a headphone
  // take (a speaker take records in silence, so it has no clock to follow).
  const follow = frame === 'listen' || frame === 'memorise' || frame === 'say' || frame === 'compare' || (frame === 'recording' && !p.speaker);
  const line = p.line ?? null;
  const words = line && line.words.length > 0 ? line.words : null;
  const units = useMemo(() => (words ? kinsokuUnits(words) : []), [words]);
  const chars = words ? words.reduce((n, w) => n + w.text.length, 0) : p.text.length;
  const innerW = Math.max(width - BODY_PAD_H * 2, 1);
  const lineKey = `${p.lineIndex ?? 0}|${p.text}`;
  const { fit, onSize, onUnit } = useSentenceFit({ lineKey, chars, innerW, maxH });
  const pt = fit.pt;
  const fittedRef = useRef(onFitted);
  fittedRef.current = onFitted;
  useEffect(() => {
    if (fit.done) fittedRef.current?.();
  }, [fit.done, fit.key]);
  // Word boxes in body coordinates for the stage's word tap: the word in its unit, the unit in the
  // units view, the units view and the ScrollView in their parents. Only the main (ink-less) layer
  // reports, the grey and band copies are the same boxes.
  const wordLocal = useRef<Record<number, WordBox>>({});
  const unitOrigin = useRef<Record<number, { x: number; y: number }>>({});
  const unitsOrigin = useRef({ x: 0, y: 0 });
  const scrollOrigin = useRef({ x: 0, y: 0 });
  const unitOf = useRef(new Map<number, number>());
  // Re-indexes the words by unit; a box of a word the new line lacks is ignored, the others are
  // overwritten by the layouts that follow.
  useEffect(() => {
    unitOf.current = new Map();
    units.forEach((u, k) => u.forEach((wi) => unitOf.current.set(wi, k)));
  }, [units]);
  const [{ boxAt, hitTest }] = useState(() => {
    const at = (i: number): WordBox | null => {
      const b = wordLocal.current[i];
      if (!b) return null;
      const o = unitOrigin.current[unitOf.current.get(i) ?? -1] ?? { x: 0, y: 0 };
      return { x: b.x + o.x + unitsOrigin.current.x + scrollOrigin.current.x, y: b.y + o.y + unitsOrigin.current.y + scrollOrigin.current.y, w: b.w, h: b.h };
    };
    const hit = (x: number, y: number): number | null => {
      for (const key of Object.keys(wordLocal.current)) {
        const i = Number(key);
        const b = unitOf.current.has(i) ? at(i) : null;
        if (b && x >= b.x - HIT_SLOP && x <= b.x + b.w + HIT_SLOP && y >= b.y - HIT_SLOP && y <= b.y + b.h + HIT_SLOP) return i;
      }
      return null;
    };
    return { boxAt: at, hitTest: hit };
  });
  useEffect(() => {
    if (hitRef) hitRef.current = { hitTest, boxAt };
    return () => {
      if (hitRef) hitRef.current = null;
    };
  }, [hitRef, hitTest, boxAt]);
  // The text in one colour (`ink`), or in its own colours with the highlight. `plainBlur` (the ink and
  // grey copies) takes the Final take's blur; the band runs only through the count, always sharp.
  const content = (ink: string | undefined, layer: typeof textStyle | null, plainBlur: boolean) => (
    <Animated.View style={[styles.layer, layer]} pointerEvents="none">
      {words ? (
          <View
            style={styles.units}
            onLayout={
              ink
                ? undefined
                : (e) => {
                    unitsOrigin.current = { x: e.nativeEvent.layout.x, y: e.nativeEvent.layout.y };
                  }
            }>
            {units.map((unit, k) => (
              <View
                key={unit[0]}
                style={styles.unit}
                onLayout={
                  ink
                    ? undefined
                    : (e) => {
                        unitOrigin.current[k] = { x: e.nativeEvent.layout.x, y: e.nativeEvent.layout.y };
                        onUnit(e.nativeEvent.layout.width);
                      }
                }>

                {unit.map((wi) => (
                  <RubyWord
                    key={wi}
                    word={words[wi]!}
                    showRuby
                    index={wi}
                    selected={false}
                    onLayout={
                      ink
                        ? noop
                        : (i, e) => {
                            const l = e.nativeEvent.layout;
                            wordLocal.current[i] = { x: l.x, y: l.y, w: l.width, h: l.height };
                          }
                    }
                    showPosAndRomaji={false}
                    scale={pt / 22}
                    highlight={follow && !ink ? p.highlight : undefined}
                    litColor={XP_GOLD}
                    color={ink}
                    blur={plainBlur ? blur : undefined}
                    grain={plainBlur ? grain : undefined}
                    noWrap
                  />
                ))}
              </View>
            ))}
          </View>
        ) : (
          plainBlur ? (
            <BlurText text={p.text} blur={blur} scale={1} base={ink ?? PLAIN_INK} style={[styles.plain, { fontSize: pt, lineHeight: pt * 1.75 }]} />
          ) : (
            <Animated.Text style={[styles.plain, { fontSize: pt, lineHeight: pt * 1.75 }, ink ? { color: ink } : null]}>{p.text}</Animated.Text>
          )
        )}
    </Animated.View>
  );
  const core = towardWhite(tint, 0.85);
  return (
    // Remounted per line, size step and fit pass, so each one reports its height.
    <ScrollView
      key={`${fit.mount}|${pt}`}
      style={[styles.sentenceScroll, { width: innerW, maxHeight: Math.max(1, maxH) }]}
      bounces={false}
      showsVerticalScrollIndicator={false}
      contentContainerStyle={[styles.sentence, !fit.done && !fit.shown && styles.fitting]}
      onLayout={(e) => {
        const w = e.nativeEvent.layout.width;
        bandW.value = Number.isFinite(w) ? w : 0;
        scrollOrigin.current = { x: e.nativeEvent.layout.x, y: e.nativeEvent.layout.y };
      }}
      onContentSizeChange={onSize}
      accessible={(hidden && !counting) || undefined}
      accessibilityLabel={hidden && !counting ? t('ladder.sentenceHidden') : undefined}>
      {/* Drawn first, so the ink lifts over it. */}
      {greyOn ? (
        <Animated.View style={[styles.copy, greyStyle]} pointerEvents="none">
          {content(COUNT_GREY, null, true)}
        </Animated.View>
      ) : null}
      {content(undefined, textStyle, true)}
      {/* The Final take's count has no band (the blur is its count), so its three copies are not drawn. */}
      {counting && !reduced && !final
        ? BAND.map((b) => (
            <BandWindow key={b.w} w={bandW} sweep={sweep} share={b.w} opacity={b.o}>
              {content(b.core ? core : tint, null, false)}
            </BandWindow>
          ))
        : null}
    </ScrollView>
  );
}

/** How far outside a word's box a tap still counts as that word. */
const HIT_SLOP = 0;

const styles = StyleSheet.create({
  sentenceScroll: { flexGrow: 0, flexShrink: 1 },
  sentence: { alignItems: 'center' },
  fitting: { opacity: 0 },
  // Every copy (ink, grey, band windows) is the full body width, so all of them wrap at the same points.
  layer: { alignSelf: 'stretch', alignItems: 'center' },
  units: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', columnGap: 8 },
  // Never shrinks: a unit wider than the body keeps its real width, so onUnit sees it and steps the size
  // down, instead of its words wrapping inside it.
  unit: { flexDirection: 'row', flexShrink: 0 },
  plain: { fontFamily: fonts.serifJp, fontWeight: '600', color: PLAIN_INK, textAlign: 'center' },
  // The count-in's copies: the grey one under the ink, the band's windows over it.
  copy: { ...StyleSheet.absoluteFill, alignItems: 'center' },
});
