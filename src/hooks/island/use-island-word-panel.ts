// The island's word panel: the tapped word and its gloss, the word's own player with its
// play-once effect, the drag selection (span, anchor, handles, word boxes) and the touch
// bookkeeping the sentence block and the scene wrapper share. The route wires the gestures.
import * as Clipboard from 'expo-clipboard';
import { type AudioStatus, useAudioPlayer } from 'expo-audio';
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import type { LayoutChangeEvent } from 'react-native';
import type { ScrollView } from 'react-native-gesture-handler';

import type { IslandCore } from '@/hooks/island/island-core';
import type { StageWord } from '@/hooks/island/use-stage-word';
import { useLineStatus } from '@/hooks/use-line-status';
import type { PhraseSpan } from '@/hooks/use-phrase';
import { useStableHandler } from '@/hooks/use-stable-handler';
import * as api from '@/lib/api';
import { startPlayback, stopPlayback, useSessionPlayer } from '@/lib/audio-mode';
import { hapticImpact } from '@/lib/haptics';
import { noop } from '@/lib/island/island-consts';
import { spanUpdate } from '@/lib/island/player-timing';
import { hitTest as hitWord, type WordBoxes } from '@/lib/island/word-hit';
import { offlineGloss, offlineWordAudio } from '@/lib/offline-islands'; // offline-islands

type Params = {
  core: MutableRefObject<IslandCore | null>;
  player: ReturnType<typeof useAudioPlayer>;
  status: AudioStatus;
  hidden: boolean;
  line: api.Line | undefined;
  island: api.Island | null;
  isJa: boolean;
  stageWord: StageWord;
};

export function useIslandWordPanel({ core, player, status, hidden, line, island, isJa, stageWord }: Params) {
  // The tapped word, its dictionary result, and the timer that ends Hear it.
  const [selected, setSelected] = useState<number | null>(null);
  const [glossData, setGlossData] = useState<api.Gloss | null>(null);
  // How the tapped word functions in this sentence: undefined until the
  // fetch resolves, null once it resolves empty or fails. Guarded by
  // wordRequestId so a slow answer for a word that's no longer selected
  // never lands under a different one.
  const [explainContext, setExplainContext] = useState<string | null | undefined>(undefined);
  const wordRequestId = useRef(0);
  // Where each word sits inside the sentence block, so the popover can sit
  // right under the tapped one without moving anything else, and so the drag
  // gesture below can hit-test a touch point to a word.
  const wordBoxes = useRef<WordBoxes>({});
  const [blockWidth, setBlockWidth] = useState(0);
  const scrollRef = useRef<ScrollView>(null);
  // The run of words a drag has selected. Set on the pan gesture's start and
  // update, left alone on end: that is what shows the Repeat popup.
  const [dragSpan, setDragSpan] = useState<PhraseSpan | null>(null);
  // True while a selection handle is being dragged: hides the popup so it
  // does not sit under the finger, and keeps the two clear functions below
  // from stepping on each other.
  const [handleDragging, setHandleDragging] = useState(false);
  // The span edge a handle grab holds fixed, so dragging past it swaps
  // cleanly instead of leaving a gap or a stuck handle.
  const handleFixed = useRef(0);
  // Set by the sentence block's own onTouchStart so the scene wrapper's
  // touch guard below can tell a touch inside the block from one outside it.
  const blockTouched = useRef(false);
  const anchorWord = useRef(0);
  // Bumped on every line or speed change, so an answer that lands after the
  // line moved on can tell it no longer belongs to the sentence on screen.
  const [chatGeneration, setChatGeneration] = useState(0);

  // The tapped word has its own render and its own player, so hearing it never
  // moves the line's player or the highlight.
  // focus-stories D8: the stage panel's Hear word plays here too, when the player's own sentence has none selected.
  const hearText = line && selected !== null && line.words[selected] ? line.words[selected]!.text : stageWord.hearText;
  const wordSource = useMemo(
    () => (island && hearText ? { uri: offlineWordAudio(island.id, hearText, island.speaker) ?? api.wordAudioUrl(hearText, island.speaker) } : null), // offline-islands
    [island, hearText],
  );
  // keepAudioSessionActive for the same reason as the line player: closePanel
  // pauses this one just before a take starts, and a pause tears the audio
  // session down 100ms later, which would land on the prepared recorder.
  const wordPlayer = useAudioPlayer(wordSource, { keepAudioSessionActive: true });
  // Rendered only when the word loads or its playing flag flips, not per tick.
  const { status: wordStatus } = useLineStatus(wordPlayer, noop, (s) => `${s.isLoaded}:${s.playing}`);
  useSessionPlayer(wordPlayer);
  const autoPlayed = useRef<string | null>(null);

  // Play the word once as soon as its audio is ready, for each new selection.
  useEffect(() => {
    const key = wordSource?.uri ?? null;
    // No word (the panel closed): forget the last one, so the same word asked for again plays again.
    if (!key) {
      autoPlayed.current = null;
      return;
    }
    if (!wordStatus.isLoaded || autoPlayed.current === key) return;
    autoPlayed.current = key;
    startPlayback(wordPlayer);
  }, [wordSource, wordStatus.isLoaded, wordPlayer]);

  function closePanel() {
    stopPlayback(wordPlayer);
    setSelected(null);
    setGlossData(null);
    setExplainContext(undefined);
    wordRequestId.current++;
  }

  // The panel's share of the route's resetForNewAudio: the popover, the drag
  // selection and the Explain thread's generation, batched into the change's one render.
  function resetPanel() {
    closePanel();
    setDragSpan(null);
    setHandleDragging(false);
    setChatGeneration((g) => g + 1);
  }

  const clearDragSpan = useCallback(() => setDragSpan(null), []);

  async function tapWord(i: number) {
    if (!line) return;
    if (hidden) return;
    core.current?.setPlayWhenLoaded(false);
    core.current?.dropTake();
    if (status.playing) stopPlayback(player);
    setSelected(i);
    setGlossData(null);
    setExplainContext(undefined);
    const requestId = ++wordRequestId.current;
    const word = line.words[i]!.text;
    // languages: JMdict only covers Japanese, so es and en skip straight to
    // the context line instead of a dictionary lookup.
    if (isJa) {
      try {
        const g = offlineGloss(island!.id, word) ?? (await api.gloss(word)); // offline-islands
        setGlossData(g);
      } catch {
        setGlossData({ word, base: '', reading: '', entries: [], found: false });
      }
    } else {
      setGlossData({ word, base: '', reading: '', entries: [], found: false });
    }
    try {
      const ctx = await api.explainWord(word, line.ja, line.en, island?.language ?? 'ja', island?.native ?? 'en');
      if (wordRequestId.current === requestId) setExplainContext(ctx || null);
    } catch {
      if (wordRequestId.current === requestId) setExplainContext(null);
    }
  }

  async function hearWord() {
    await wordPlayer.seekTo(0);
    startPlayback(wordPlayer);
  }

  function hitTest(x: number, y: number): number | null {
    if (!line || hidden) return null;
    return hitWord(wordBoxes.current, line.words.length, x, y);
  }

  // The pan gesture's start and update, on the word it hit: the selection grows
  // from the anchor word. Stable, since the gestures are built once.
  const startDrag = useStableHandler((i: number) => {
    closePanel();
    anchorWord.current = i;
    setDragSpan(spanUpdate(i, i));
  });
  const dragTo = useStableHandler((i: number) => {
    const a = anchorWord.current;
    setDragSpan(spanUpdate(Math.min(a, i), Math.max(a, i)));
  });

  // A handle grab fixes the opposite edge of the span, so dragging past it
  // swaps the selection instead of leaving a gap or a stuck handle: the
  // start handle fixes `to`, the end handle fixes `from`.
  function grabHandle(which: 'start' | 'end') {
    if (!dragSpan) return;
    handleFixed.current = which === 'start' ? dragSpan.to : dragSpan.from;
    setHandleDragging(true);
    closePanel();
  }

  // Block coordinates of the dragged finger, every update: hit-test to a
  // word and rebuild the span around the fixed edge from the grab.
  function dragHandle(x: number, y: number) {
    const i = hitTest(x, y);
    if (i === null) return;
    const f = handleFixed.current;
    setDragSpan(spanUpdate(Math.min(f, i), Math.max(f, i)));
  }

  function releaseHandle() {
    setHandleDragging(false);
  }

  // The one place a selection actually clears, so handleDragging can never
  // stick once dragSpan is gone.
  function clearSelection() {
    setDragSpan(null);
    setHandleDragging(false);
  }

  // Any touch outside the sentence block clears a selection: the block's own
  // onTouchStart sets blockTouched first since child touch handlers fire
  // before the parent's, so a touch inside the block (words, handles, popup)
  // never reaches here as an outside touch.
  function onSceneTouch() {
    if (!blockTouched.current && dragSpan) clearSelection();
    if (!blockTouched.current && selected !== null) closePanel();
    blockTouched.current = false;
  }

  // The drag selection's popup Copy button: the same surface text Explain
  // marks, joined with no separator, to the clipboard. Unlike Repeat and
  // Explain this leaves the selection in place, so the learner can copy more
  // than once or still hit Repeat or Explain after.
  function copySelection() {
    const span = dragSpan;
    if (!span || !line) return;
    const text = line.words
      .slice(span.from, span.to + 1)
      .map((w) => w.text)
      .join('');
    void Clipboard.setStringAsync(text);
    void hapticImpact();
  }

  const onBlockLayout = useCallback((e: LayoutChangeEvent) => setBlockWidth(e.nativeEvent.layout.width), []);

  return {
    selected,
    glossData,
    explainContext,
    wordBoxes,
    blockWidth,
    scrollRef,
    dragSpan,
    handleDragging,
    blockTouched,
    chatGeneration,
    wordPlayer,
    wordStatus,
    closePanel,
    resetPanel,
    clearDragSpan,
    tapWord,
    hearWord,
    hitTest,
    startDrag,
    dragTo,
    grabHandle,
    dragHandle,
    releaseHandle,
    clearSelection,
    onSceneTouch,
    copySelection,
    onBlockLayout,
  };
}
