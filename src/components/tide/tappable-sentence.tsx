import * as Clipboard from 'expo-clipboard';
import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { type LayoutChangeEvent, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector, type ScrollView } from 'react-native-gesture-handler';
import type { RefObject } from 'react';

import { RepeatPill, RepeatRing, type RepeatInfo } from '@/components/tide/repeat-ring';
import { RubyWord } from '@/components/ruby-word';
import { SELECTION_HANDLE_CLEARANCE, SelectionHandles } from '@/components/selection-handles';
import { SlideReveal } from '@/components/slide-reveal';
import { SELECTION_POPUP_WIDTH, SelectionPopup } from '@/components/selection-popup';
import type { Highlight } from '@/components/word-highlight';
import { POPOVER_WIDTH, WordPanel } from '@/components/word-panel';
import { fonts } from '@/constants/fonts';
import { Radius, tide } from '@/constants/theme';
import type { PhraseSpan } from '@/hooks/use-phrase';
import * as api from '@/lib/api';
import { hapticImpact } from '@/lib/haptics';
import { offlineGloss } from '@/lib/offline-islands';
import { fitScale } from '@/lib/fit-line';
import { kinsokuUnits } from '@/lib/kinsoku';
import { lineRomaji } from '@/lib/romaji';
import type { ReadingMode } from '@/lib/settings';
import { useSlideReveal } from '@/lib/slide-reveal';

export type ExplainSelection = {
  span: PhraseSpan;
  marked: string[];
  whole: boolean;
};

type Props = {
  line: api.Line;
  language: api.Language;
  native: api.NativeLanguage;
  islandId: string;
  highlight: Highlight;
  scrollRef: RefObject<ScrollView | null>;
  /** The learner chose Explain on a selection. */
  onExplain: (sel: ExplainSelection) => void;
  /** A word panel or selection opened, so the screen can pause the video. */
  onInteract?: () => void;
  /** How the reading shows (Japanese only). Default furigana. */
  readingMode?: ReadingMode;
  /** Conceal the words, as Blind does in the audio player. */
  blind?: boolean;
  /** Show the translation strip. Default true. */
  englishShown?: boolean;
  /** 'video' is the cinematic YouTube player: 26pt left-aligned type and no
   * card chrome (the screen draws the glass). Default off. */
  variant?: 'default' | 'video';
  /** Repeat feedback for the video card: a draining ring and pass dots. */
  repeat?: RepeatInfo;
};

type Box = { x: number; y: number; width: number; height: number };

// A setDragSpan updater that hands back the previous span when nothing moved,
// so React skips the render. Module level so the gestures never close over it.
const spanUpdate = (from: number, to: number) => (prev: PhraseSpan | null) =>
  prev && prev.from === from && prev.to === to ? prev : { from, to };

// The last measured block width per variant. A new line is keyed, so it mounts
// fresh; seeding from here sizes a long line right on its first frame.
const lastBlockWidth = { default: 0, video: 0 };

/**
 * The active line as a card on the waterline: tap a word for its reading and
 * translation, hold and drag to select a phrase, then Explain or Copy. No audio
 * of its own. Key it on the line so a line change resets the state.
 */
export const TappableSentence = memo(function TappableSentence({
  line,
  language,
  native,
  islandId,
  highlight,
  scrollRef,
  onExplain,
  onInteract,
  readingMode = 'furigana',
  blind = false,
  englishShown = true,
  variant = 'default',
  repeat,
}: Props) {
  const video = variant === 'video';
  const isJa = language === 'ja';
  const modeLine = !isJa
    ? null
    : readingMode === 'kana'
      ? line.kana
      : readingMode === 'romaji'
        ? lineRomaji(line)
        : null;
  const [blockWidth, setBlockWidth] = useState(() => lastBlockWidth[variant]);
  const fit = useMemo(
    () => fitScale(line, blockWidth, { base: video ? 26 : 22, min: video ? 20 : 18, em: isJa ? 1 : 0.6 }),
    [line, blockWidth, video, isJa],
  );
  const jaReveal = useSlideReveal(blind, scrollRef);
  const jaChars = useMemo(() => Array.from(line.ja), [line.ja]);
  // Rows break only between these units, so a particle or a closing "。"
  // never starts a row on its own.
  const units = useMemo(() => (isJa ? kinsokuUnits(line.words) : line.words.map((_, i) => [i])), [line.words, isJa]);
  const [selected, setSelected] = useState<number | null>(null);
  const [glossData, setGlossData] = useState<api.Gloss | null>(null);
  const [explainContext, setExplainContext] = useState<string | null | undefined>(undefined);
  const [dragSpan, setDragSpan] = useState<PhraseSpan | null>(null);
  const [handleDragging, setHandleDragging] = useState(false);

  const wordBoxes = useRef<Record<number, Box>>({});
  // A word inside a unit lays out against the unit, so its box in the words
  // view is the unit's origin plus its own.
  const wordLocal = useRef<Record<number, Box>>({});
  const unitOrigin = useRef<Record<number, { x: number; y: number }>>({});
  const wordRequestId = useRef(0);
  const anchorWord = useRef(0);
  const handleFixed = useRef(0);

  function closePanel() {
    setSelected(null);
    setGlossData(null);
    setExplainContext(undefined);
    wordRequestId.current++;
  }

  function clearSelection() {
    setDragSpan(null);
    setHandleDragging(false);
  }

  async function tapWord(i: number) {
    const w = line.words[i];
    if (!w) return;
    onInteract?.();
    setSelected(i);
    setGlossData(null);
    setExplainContext(undefined);
    const requestId = ++wordRequestId.current;
    const word = w.text;
    if (isJa) {
      try {
        const g = offlineGloss(islandId, word) ?? (await api.gloss(word));
        if (wordRequestId.current === requestId) setGlossData(g);
      } catch {
        if (wordRequestId.current === requestId) {
          setGlossData({
            word,
            base: '',
            reading: '',
            entries: [],
            found: false,
          });
        }
      }
    } else {
      setGlossData({ word, base: '', reading: '', entries: [], found: false });
    }
    try {
      const ctx = await api.explainWord(word, line.ja, line.en, language, native);
      if (wordRequestId.current === requestId) setExplainContext(ctx || null);
    } catch {
      if (wordRequestId.current === requestId) setExplainContext(null);
    }
  }

  // Hit-tests a point in the words view's own coordinates to a word index: the
  // row whose y-range holds the point (or the nearest row), then the word in
  // that row whose x-range is closest, so a drag past an edge clamps to it.
  function hitTest(x: number, y: number): number | null {
    const boxes = wordBoxes.current;
    const indices = Object.keys(boxes)
      .map(Number)
      .filter((i) => i < line.words.length);
    if (indices.length === 0) return null;
    let rowY = boxes[indices[0]!]!.y;
    let exact = false;
    for (const i of indices) {
      const b = boxes[i]!;
      if (y >= b.y && y < b.y + b.height) {
        rowY = b.y;
        exact = true;
        break;
      }
    }
    if (!exact) {
      let best = Infinity;
      for (const i of indices) {
        const b = boxes[i]!;
        const dist = Math.abs(y - (b.y + b.height / 2));
        if (dist < best) {
          best = dist;
          rowY = b.y;
        }
      }
    }
    const row = indices.filter((i) => Math.abs(boxes[i]!.y - rowY) < 2).sort((a, b) => a - b);
    let picked = row[0]!;
    let bestXDist = Infinity;
    for (const i of row) {
      const b = boxes[i]!;
      if (x >= b.x && x < b.x + b.width) return i;
      const dist = x < b.x ? b.x - x : x - (b.x + b.width);
      if (dist < bestXDist) {
        bestXDist = dist;
        picked = i;
      }
    }
    return picked;
  }

  // What the gestures read when they fire. They are built once, so a re-render
  // never hands GestureDetector new gesture objects.
  const liveNow = {
    hitTest,
    closePanel,
    tapWord,
    clearSelection,
    dragSpan,
    onInteract,
  };
  const live = useRef(liveNow);
  useLayoutEffect(() => {
    live.current = liveNow;
  });

  const sentenceGesture = useMemo(() => {
    const pan = Gesture.Pan()
      .activateAfterLongPress(450)
      .runOnJS(true)
      .onStart((e) => {
        const l = live.current;
        const i = l.hitTest(e.x, e.y);
        if (i === null) return;
        l.closePanel();
        l.onInteract?.();
        anchorWord.current = i;
        setDragSpan(spanUpdate(i, i));
      })
      .onUpdate((e) => {
        const i = live.current.hitTest(e.x, e.y);
        if (i === null) return;
        const a = anchorWord.current;
        setDragSpan(spanUpdate(Math.min(a, i), Math.max(a, i)));
      });
    const tap = Gesture.Tap()
      .runOnJS(true)
      .onEnd((e) => {
        const l = live.current;
        if (l.dragSpan) {
          l.clearSelection();
          return;
        }
        const i = l.hitTest(e.x, e.y);
        if (i !== null) void l.tapWord(i);
        else l.closePanel();
      });
    return Gesture.Exclusive(pan, tap);
  }, []);

  function grabHandle(which: 'start' | 'end') {
    if (!dragSpan) return;
    handleFixed.current = which === 'start' ? dragSpan.to : dragSpan.from;
    setHandleDragging(true);
    closePanel();
  }
  function dragHandle(x: number, y: number) {
    const i = hitTest(x, y);
    if (i === null) return;
    const f = handleFixed.current;
    setDragSpan(spanUpdate(Math.min(f, i), Math.max(f, i)));
  }
  function openExplain() {
    const span = dragSpan;
    if (!span) return;
    onExplain({
      span,
      marked: line.words.slice(span.from, span.to + 1).map((w) => w.text),
      whole: span.from === 0 && span.to === line.words.length - 1,
    });
    setDragSpan(null);
  }
  function copySelection() {
    const span = dragSpan;
    if (!span) return;
    void Clipboard.setStringAsync(
      line.words
        .slice(span.from, span.to + 1)
        .map((w) => w.text)
        .join(''),
    );
    void hapticImpact();
  }

  // The handlers the children hold are stable, and read the latest render's
  // closures through a ref.
  const fns = useRef({
    grabHandle,
    dragHandle,
    openExplain,
    copySelection,
    closePanel,
  });
  useLayoutEffect(() => {
    fns.current = {
      grabHandle,
      dragHandle,
      openExplain,
      copySelection,
      closePanel,
    };
  });
  const stable = useMemo(
    () => ({
      grab: (w: 'start' | 'end') => fns.current.grabHandle(w),
      drag: (x: number, y: number) => fns.current.dragHandle(x, y),
      release: () => setHandleDragging(false),
      explain: () => fns.current.openExplain(),
      copy: () => fns.current.copySelection(),
      close: () => fns.current.closePanel(),
    }),
    [],
  );

  // Each word's box lands in wordBoxes at once, for hit-testing.
  const unitOf = useRef<number[]>([]);
  unitOf.current = [];
  units.forEach((u, k) => u.forEach((i) => (unitOf.current[i] = k)));
  const placeWord = (i: number) => {
    const b = wordLocal.current[i];
    if (!b) return;
    const k = unitOf.current[i];
    const o = k !== undefined && (units[k]?.length ?? 0) > 1 ? unitOrigin.current[k] : undefined;
    wordBoxes.current[i] = o ? { ...b, x: b.x + o.x, y: b.y + o.y } : b;
  };
  const place = useRef(placeWord);
  place.current = placeWord;
  const onWordLayout = useRef((i: number, e: LayoutChangeEvent) => {
    wordLocal.current[i] = e.nativeEvent.layout;
    place.current(i);
  }).current;
  const onUnitLayout = (k: number, e: LayoutChangeEvent) => {
    const { x, y } = e.nativeEvent.layout;
    unitOrigin.current[k] = { x, y };
    for (const i of units[k] ?? []) place.current(i);
  };
  const onBlockLayout = useRef((e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    if (Number.isFinite(w) && w > 0) lastBlockWidth[variant] = w;
    setBlockWidth(w);
  }).current;

  // Popover under the tapped word, centred on it, kept inside the block.
  const box = selected !== null ? wordBoxes.current[selected] : undefined;
  const popLeft = box
    ? Math.max(0, Math.min(blockWidth - POPOVER_WIDTH, box.x + box.width / 2 - POPOVER_WIDTH / 2))
    : 0;
  const popTop = box ? box.y + box.height + 6 : 0;

  // The selection popup, anchored to the union of the span's word boxes.
  const dragBoxes = dragSpan
    ? Array.from({ length: dragSpan.to - dragSpan.from + 1 }, (_, k) => wordBoxes.current[dragSpan.from + k]).filter(
        (b): b is Box => !!b,
      )
    : [];
  const dragUnion = dragBoxes.length
    ? dragBoxes.reduce(
        (acc, b) => ({
          x: Math.min(acc.x, b.x),
          y: Math.min(acc.y, b.y),
          right: Math.max(acc.right, b.x + b.width),
          bottom: Math.max(acc.bottom, b.y + b.height),
        }),
        { x: Infinity, y: Infinity, right: -Infinity, bottom: -Infinity },
      )
    : null;
  const dragPopLeft = dragUnion
    ? Math.max(
        0,
        Math.min(
          blockWidth - SELECTION_POPUP_WIDTH,
          dragUnion.x + (dragUnion.right - dragUnion.x) / 2 - SELECTION_POPUP_WIDTH / 2,
        ),
      )
    : 0;
  const dragPopTop = dragUnion ? dragUnion.bottom + SELECTION_HANDLE_CLEARANCE : 0;

  return (
    <View style={video ? (repeat ? styles.videoCardRepeat : styles.videoCard) : styles.activeCard}>
      {video && repeat ? (
        <>
          <RepeatRing progress={repeat.progress} />
          <RepeatPill pass={repeat.pass} total={repeat.total} secsLeft={repeat.secsLeft} />
        </>
      ) : null}
      {line.words.length > 0 ? (
        <View style={styles.block} onLayout={onBlockLayout}>
          <GestureDetector gesture={blind ? jaReveal.gesture : sentenceGesture}>
            <View collapsable={false}>
              {blind ? (
                <SlideReveal
                  finger={jaReveal.finger}
                  count={line.words.length}
                  rowStyle={[styles.words, video && styles.wordsLeft]}
                  blur={4.5}
                  renderChunk={(i, sharp) => (
                  <RubyWord
                    key={i}
                    word={line.words[i]!}
                    showRuby={isJa && readingMode === 'furigana'}
                    showPosAndRomaji={isJa}
                    index={i}
                    highlight={highlight}
                    concealed={!sharp}
                    big={video}
                    scale={fit}
                    selected={false}
                    onLayout={onWordLayout}
                  />
                  )}
                />
              ) : (
              <View style={[styles.words, video && styles.wordsLeft]}>
                {units.map((u, k) => {
                  const words = u.map((i) => (
                    <RubyWord
                      key={i}
                      word={line.words[i]!}
                      showRuby={isJa && readingMode === 'furigana'}
                      showPosAndRomaji={isJa}
                      index={i}
                      highlight={highlight}
                      concealed={blind}
                      big={video}
                      scale={fit}
                      selected={i === selected || (!!dragSpan && i >= dragSpan.from && i <= dragSpan.to)}
                      onLayout={onWordLayout}
                    />
                  ));
                  return u.length > 1 ? (
                    <View key={`u${u[0]}`} style={styles.unit} onLayout={(e) => onUnitLayout(k, e)}>
                      {words}
                    </View>
                  ) : (
                    words[0]
                  );
                })}
              </View>
              )}
            </View>
          </GestureDetector>
          {dragSpan && wordBoxes.current[dragSpan.from] && wordBoxes.current[dragSpan.to] ? (
            <SelectionHandles
              start={wordBoxes.current[dragSpan.from]!}
              end={wordBoxes.current[dragSpan.to]!}
              scrollRef={scrollRef}
              onGrab={stable.grab}
              onDrag={stable.drag}
              onRelease={stable.release}
            />
          ) : null}
          {selected !== null && line.words[selected] ? (
            <WordPanel
              word={line.words[selected]!.text}
              gloss={glossData}
              context={explainContext}
              left={popLeft}
              top={popTop}
              romaji={isJa && readingMode === 'romaji'}
              dictionary={isJa}
              onClose={stable.close}
            />
          ) : null}
          {dragSpan && dragUnion && !handleDragging ? (
            <SelectionPopup left={dragPopLeft} top={dragPopTop} onExplain={stable.explain} onCopy={stable.copy} />
          ) : null}
        </View>
      ) : (
        <GestureDetector gesture={jaReveal.gesture}>
          <View collapsable={false}>
            {blind ? (
              <SlideReveal
                finger={jaReveal.finger}
                count={jaChars.length}
                rowStyle={[styles.words, video && styles.wordsLeft]}
                blur={4.5}
                renderChunk={(i) => (
                  <Text key={i} style={[styles.ja, isJa && { fontFamily: fonts.serifJp }, video && styles.jaVideo, fit !== 1 && { fontSize: (video ? 26 : 22) * fit, lineHeight: (video ? 34 : 32) * fit }]}>{jaChars[i]}</Text>
                )}
              />
            ) : (
          <Text style={[styles.ja, isJa && { fontFamily: fonts.serifJp }, video && styles.jaVideo, fit !== 1 && { fontSize: (video ? 26 : 22) * fit, lineHeight: (video ? 34 : 32) * fit }]}>{line.ja}</Text>
            )}
          </View>
        </GestureDetector>
      )}
      {modeLine && !blind ? <Text style={[styles.reading, video && styles.leftText]}>{modeLine}</Text> : null}
      {line.en && englishShown ? (
        <View style={video ? styles.enVideo : styles.enStrip}>
          <Text style={[styles.en, video && styles.enTextVideo]}>{line.en}</Text>
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  activeCard: {
    borderRadius: Radius.lg,
    backgroundColor: 'rgba(255,255,255,0.04)',
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  videoCard: {},
  videoCardRepeat: { borderRadius: 22, paddingTop: 22, paddingBottom: 14, paddingHorizontal: 16 },
  wordsLeft: { justifyContent: 'flex-start' },
  jaVideo: { fontSize: 26, lineHeight: 34, textAlign: 'left' },
  leftText: { textAlign: 'left' },
  enVideo: { marginTop: 8 },
  enTextVideo: { fontSize: 15, lineHeight: 21, textAlign: 'left' },
  block: { position: 'relative', zIndex: 5 },
  words: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center' },
  unit: { flexDirection: 'row', flexShrink: 1, maxWidth: '100%' },
  ja: {
    fontSize: 22,
    lineHeight: 32,
    textAlign: 'center',
    color: tide.text,
    fontFamily: fonts.ui,
  },
  reading: {
    fontFamily: fonts.serifJp,
    fontSize: 16,
    lineHeight: 24,
    textAlign: 'center',
    color: tide.textDim,
  },
  enStrip: {
    marginTop: 10,
    paddingVertical: 6,
    paddingHorizontal: 16,
    borderRadius: Radius.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.12)',
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  en: {
    fontFamily: fonts.ui,
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
    color: tide.textDim,
  },
});
