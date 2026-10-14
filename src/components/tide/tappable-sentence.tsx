import * as Clipboard from 'expo-clipboard';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { type LayoutChangeEvent, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector, type ScrollView } from 'react-native-gesture-handler';
import { useReducedMotion, useSharedValue } from 'react-native-reanimated';
import type { RefObject } from 'react';

import { RubyWord } from '@/components/ruby-word';
import { SELECTION_HANDLE_CLEARANCE, SelectionHandles } from '@/components/selection-handles';
import { SELECTION_POPUP_WIDTH, SelectionPopup } from '@/components/selection-popup';
import type { Highlight, WordBox } from '@/components/word-highlight';
import { WordOutline } from '@/components/word-outline';
import { POPOVER_WIDTH, WordPanel } from '@/components/word-panel';
import { fonts } from '@/constants/fonts';
import { Radius, tide } from '@/constants/theme';
import type { PhraseSpan } from '@/hooks/use-phrase';
import * as api from '@/lib/api';
import { hapticImpact } from '@/lib/haptics';
import { offlineGloss } from '@/lib/offline-islands';
import { lineRomaji } from '@/lib/romaji';
import type { ReadingMode } from '@/lib/settings';

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
  /** 'video' is the cinematic YouTube player: 26pt left-aligned type, karaoke
   * colour sweep, no card chrome (the screen draws the glass). Default off. */
  variant?: 'default' | 'video';
};

type Box = { x: number; y: number; width: number; height: number };

// A setDragSpan updater that hands back the previous span when nothing moved,
// so React skips the render. Module level so the gestures never close over it.
const spanUpdate = (from: number, to: number) => (prev: PhraseSpan | null) =>
  prev && prev.from === from && prev.to === to ? prev : { from, to };

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
}: Props) {
  const video = variant === 'video';
  const reduceMotion = useReducedMotion();
  const isJa = language === 'ja';
  const modeLine = !isJa
    ? null
    : readingMode === 'kana'
      ? line.kana
      : readingMode === 'romaji'
        ? lineRomaji(line)
        : null;
  const [blockWidth, setBlockWidth] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [glossData, setGlossData] = useState<api.Gloss | null>(null);
  const [explainContext, setExplainContext] = useState<string | null | undefined>(undefined);
  const [dragSpan, setDragSpan] = useState<PhraseSpan | null>(null);
  const [handleDragging, setHandleDragging] = useState(false);

  const wordBoxes = useRef<Record<number, Box>>({});
  const wordBoxesUI = useSharedValue<(WordBox | null)[]>([]);
  const boxesFrame = useRef<number | null>(null);
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

  // Each word's box lands in wordBoxes at once for hit-testing and reaches the
  // UI thread's copy once per frame, after the whole batch of layouts.
  const writeBoxesSoon = useRef(() => {});
  writeBoxesSoon.current = () => {
    if (boxesFrame.current !== null) return;
    boxesFrame.current = requestAnimationFrame(() => {
      boxesFrame.current = null;
      wordBoxesUI.value = Array.from({ length: line.words.length }, (_, k) => wordBoxes.current[k] ?? null);
    });
  };
  const onWordLayout = useRef((i: number, e: LayoutChangeEvent) => {
    wordBoxes.current[i] = e.nativeEvent.layout;
    writeBoxesSoon.current();
  }).current;
  useEffect(
    () => () => {
      if (boxesFrame.current !== null) cancelAnimationFrame(boxesFrame.current);
    },
    [],
  );
  const onBlockLayout = useRef((e: LayoutChangeEvent) => setBlockWidth(e.nativeEvent.layout.width)).current;

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
    <View style={video ? styles.videoCard : styles.activeCard}>
      {line.words.length > 0 ? (
        <View style={styles.block} onLayout={onBlockLayout}>
          <GestureDetector gesture={sentenceGesture}>
            <View collapsable={false}>
              <View style={[styles.words, video && styles.wordsLeft]}>
                {line.words.map((w, i) => (
                  <RubyWord
                    key={i}
                    word={w}
                    showRuby={isJa && readingMode === 'furigana'}
                    showPosAndRomaji={isJa}
                    index={i}
                    highlight={highlight}
                    concealed={blind}
                    karaoke={video ? (reduceMotion ? 'step' : 'sweep') : undefined}
                    selected={i === selected || (!!dragSpan && i >= dragSpan.from && i <= dragSpan.to)}
                    onLayout={onWordLayout}
                  />
                ))}
              </View>
              <WordOutline highlight={highlight} boxes={wordBoxesUI} />
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
        <Text style={[styles.ja, isJa && { fontFamily: fonts.serifJp }, video && styles.jaVideo]}>{line.ja}</Text>
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
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,158,128,0.35)',
    backgroundColor: 'rgba(255,255,255,0.04)',
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  videoCard: {},
  wordsLeft: { justifyContent: 'flex-start' },
  jaVideo: { fontSize: 26, lineHeight: 34, textAlign: 'left' },
  leftText: { textAlign: 'left' },
  enVideo: { marginTop: 8 },
  enTextVideo: { fontSize: 15, lineHeight: 21, textAlign: 'left' },
  block: { position: 'relative', zIndex: 5 },
  words: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center' },
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
