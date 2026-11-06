// The sentence card's gestures on the island: the phrase-selection pan, the word tap, the swipe
// (next line or restart) with the card's drag and glide style, and the two slide reveals. Owner: I3.
// The gestures are built once and read this render's state and handlers through `live`.
import { useLayoutEffect, useMemo, useRef, type RefObject } from 'react';
import { Gesture, type ScrollView } from 'react-native-gesture-handler';
import { Extrapolation, interpolate, useAnimatedStyle, useSharedValue, withSpring, type SharedValue } from 'react-native-reanimated';

import type { PhraseSpan } from '@/hooks/use-phrase';
import { DRAG_LIMIT, rubberBandDragY } from '@/lib/island/player-timing';
import { useSlideReveal } from '@/lib/slide-reveal';

// What the gestures read when they fire: this render's state and handlers.
export type SentenceLive = {
  hitTest: (x: number, y: number) => number | null;
  tapWord: (i: number) => Promise<void>;
  tapEmptySentence: () => void;
  startDrag: (i: number) => void;
  dragTo: (i: number) => void;
  clearSelection: () => void;
  go: (target: number, keepPlaying?: boolean) => void;
  runLine: (i: number) => void;
  echoActive: boolean;
  playFromTop: () => Promise<void>;
  setPlayWhenLoaded: (on: boolean) => void;
  reducedMotion: boolean;
  idx: number;
  dragSpan: PhraseSpan | null;
};

export type SentenceGesturesParams = {
  live: SentenceLive;
  scrollRef: RefObject<ScrollView | null>;
  blind: boolean;
  englishShown: boolean;
};

// The latest render's value behind one object, written at commit (like useStableHandler), so the
// gestures built once below read this render's state and handlers when they fire.
function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

// The three gestures, built once per card. Plain code outside the hook: the handlers read
// `live.current` only when they fire.
function buildSentenceGesture(live: { readonly current: SentenceLive }, dragY: SharedValue<number>, scrollRef: RefObject<ScrollView | null>) {
  const pan = Gesture.Pan()
    .activateAfterLongPress(450)
    .runOnJS(true)
    .onStart((e) => {
      const l = live.current;
      const i = l.hitTest(e.x, e.y);
      if (i === null) return;
      l.startDrag(i);
    })
    .onUpdate((e) => {
      const l = live.current;
      const i = l.hitTest(e.x, e.y);
      if (i === null) return;
      l.dragTo(i);
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
      else l.tapEmptySentence();
    });
  const swipe = Gesture.Pan()
    .runOnJS(true)
    .activeOffsetY([-16, 16])
    .failOffsetX([-24, 24])
    .blocksExternalGesture(scrollRef)
    .onUpdate((e) => {
      if (live.current.reducedMotion) return;
      dragY.set(rubberBandDragY(e.translationY));
    })
    .onEnd((e) => {
      const l = live.current;
      const fires = e.translationY < -40 || e.velocityY < -500 || e.translationY > 40 || e.velocityY > 500;
      if (!l.reducedMotion) {
        dragY.set(fires ? 0 : withSpring(0, { damping: 26, stiffness: 300 }));
      }
      if (e.translationY < -40 || e.velocityY < -500) {
        // Mid-run the next line starts at its first pass.
        if (l.echoActive) l.runLine(l.idx + 1);
        else l.go(l.idx + 1);
      } else if (e.translationY > 40 || e.velocityY > 500) {
        l.setPlayWhenLoaded(false);
        l.clearSelection();
        void l.playFromTop();
      }
    });
  return Gesture.Exclusive(pan, swipe, tap);
}

export function useSentenceGestures(p: SentenceGesturesParams) {
  const { scrollRef, blind, englishShown } = p;
  // The gestures are built once, so a re-render never hands GestureDetector
  // new gesture objects (which makes it reattach every handler); they read
  // this render's state and handlers here.
  const live = useLatest(p.live);
  // The active card's vertical offset while a swipe drags it: 0 at rest,
  // rubber-banded toward the finger while dragging, snapped or sprung back
  // to 0 on release (the `swipe` gesture in buildSentenceGesture).
  const dragY = useSharedValue(0);
  // A drag picks the phrase, snapped to whole words: hold still for the pan
  // to activate (the ScrollView is free to claim a vertical drag until then),
  // then the highlight follows the touch as `dragSpan`. A plain tap falls
  // through to the word popover instead, and also dismisses a drag selection
  // sitting from before. Both run on the JS thread: nothing here is a
  // worklet, so state and the existing async handlers can be called directly.
  //
  // A quick vertical drag reads as a swipe instead of the phrase-selection
  // pan: the pan only activates after a 450ms hold, so a fast flick falls
  // through to this before that timer fires. blocksExternalGesture holds the
  // outer scroll view off until the swipe fails, so a horizontal or slow drag
  // still reaches it. While it drags, the card follows the finger with
  // resistance (dragY, read by cardDragStyle below); on release it either
  // snaps straight back to 0 (the swipe fired, and the rise-from-water line
  // change takes over from there) or springs back with high damping (the
  // swipe fell short).
  //
  // Blind mode's only gesture on the sentence is the reveal drag: no word
  // taps, no selection and no swipes while it is frosted.
  const sentenceGesture = useMemo(() => buildSentenceGesture(live, dragY, scrollRef), [live, dragY, scrollRef]);
  const jaReveal = useSlideReveal(blind, scrollRef);
  const enReveal = useSlideReveal(!englishShown, scrollRef);
  // Follows dragY while a swipe drags the card, with a slight scale down so
  // it reads as lifting off the waterline rather than just sliding.
  // bl58-easy-for-me: E4's glide after an Easy tap: the card sinks into the water, the next line rises from the waterline.
  const glideY = useSharedValue(0);
  const glideOp = useSharedValue(1);
  const cardDragStyle = useAnimatedStyle(() => ({
    opacity: glideOp.value,
    transform: [
      { translateY: dragY.value + glideY.value },
      { scale: interpolate(Math.abs(dragY.value), [0, DRAG_LIMIT], [1, 0.99], Extrapolation.CLAMP) * (0.97 + 0.03 * glideOp.value) },
    ],
  }));
  return { sentenceGesture, cardDragStyle, glideY, glideOp, jaReveal, enReveal };
}
