// The body's gestures (focus-stories, Instagram Stories map on focus layout 7): the cube pan
// to a neighbour island raced against the hold (translation, peek) and the tap (a word, else
// the quarter zones). The step swipe and its edge light are gone (D12): the bar and the step
// chip change steps, the cube is its own feedback.
import { useMemo, useState, type RefObject } from 'react';
import { useWindowDimensions } from 'react-native';
import { Gesture, type PanGesture } from 'react-native-gesture-handler';

import type { LadderStageProps, SentenceHit } from '@/hooks/ladder/ladder-types';

/** What the body's gestures act on: the stage's callbacks and the state that gates them. */
export type BodyGestureOptions = {
  stopOnce: () => void;
  onRecord: LadderStageProps['onRecord'];
  onPause: LadderStageProps['onPause'];
  /** Right quarter: the next sentence (past the last line the hook falls through to `io.advance()`). */
  onSkip: LadderStageProps['onSkip'];
  /** Left quarter: the previous sentence (line 0 restarts it); a host without it restarts the line at Listen. */
  onPrev: LadderStageProps['onPrev'];
  onJump: LadderStageProps['onJump'];
  isRecording: LadderStageProps['isRecording'];
  /** D8: hidden text (the Final take) has no word boxes, so a tap on it is a zone tap. The hold itself is always on (D5). */
  textHidden: LadderStageProps['textHidden'];
  waiting: boolean;
  paused: boolean;
  setPeek: (on: boolean) => void;
  /** D3/D4: the cube's pan from `useCubePan`, raced against the hold and the tap; null while there is none. */
  cube?: PanGesture | null;
  /** D8: the sentence's word boxes; a tap's `e.x, e.y` through `hitTest` wins over the quarter zones. */
  hitTestRef?: RefObject<SentenceHit | null>;
  /** D8: the open panel's word, null when closed. Open and no hit: `onWord(null)` then `onResume`, no zone tap. */
  wordAt?: number | null;
  /** D8: a word hit: `onWord(i)` then `onPause` (a second word only swaps); null closes. Absent: words are zone taps. */
  onWord?: (i: number | null) => void;
  /** D5/D8: release of a hold and a panel close resume the step from its start. */
  onResume?: LadderStageProps['onResume'];
};

/**
 * The body's gesture: the cube pan (when the host has one) racing `Exclusive(hold, tap)`.
 * The hold and the tap run on JS (`runOnJS`), so they read the captured values, never `p`
 * on the UI thread. D1: no gesture here is ever `.enabled(false)`. The tap waits for the
 * hold to fail, and on web a disabled awaited handler stays UNDETERMINED, so the tap would
 * never fire; every state gate lives inside the callbacks instead.
 */
export function useBodyGesture({ stopOnce, onRecord, onPause, onSkip, onPrev, onJump, isRecording, textHidden, waiting, paused, setPeek, cube, hitTestRef, wordAt, onWord, onResume }: BodyGestureOptions) {
  // D4: the zones split the window width, which is the body's width.
  const { width } = useWindowDimensions();
  // The live hold: null when none, else whether its pause was ours (the panel's pause stays on
  // release). State, not a ref: the detector swaps in the rebuilt callbacks mid-hold, so the
  // release reads what the start wrote.
  const [heldPause, setHeldPause] = useState<boolean | null>(null);
  const panelOpen = wordAt !== null && wordAt !== undefined;
  const gesture = useMemo(() => {
    // D5: hold = pause and translation (peek shows hidden text). A middle-tap pause owns the body
    // (dim and pills), so a hold there is a no-op. Recording: `pause()` is a no-op by its own rule
    // and `resume()` is a no-op when nothing paused, so the release leaves the take alone.
    const hold = Gesture.LongPress()
      .minDuration(300)
      .maxDistance(20)
      .runOnJS(true)
      .onStart(() => {
        if (paused && !panelOpen) return;
        setHeldPause(!panelOpen);
        setPeek(true);
        if (!panelOpen) onPause?.();
      })
      .onFinalize(() => {
        // Release, or a drag past 20pt: both end the hold the same way, so the stage never rests paused without its pills.
        if (heldPause === null) return;
        setHeldPause(null);
        setPeek(false);
        if (heldPause) onResume?.();
      });
    // D2: a word hit wins, then the quarters. Left quarter = the previous sentence, right quarter =
    // the next, middle = pause (waiting: start the take). The same in Hebrew: not mirrored.
    const tap = Gesture.Tap()
      .maxDuration(300)
      .runOnJS(true)
      // The hit test reads the sentence's ref at tap time (D8). The detector fires this on a touch, never in render; the lint cannot see the builder as an event registration.
      // eslint-disable-next-line react-hooks/refs
      .onEnd((e) => {
        // Recording: any tap anywhere stops the take and keeps it; no quarter tap ever loses a take.
        if (isRecording) {
          stopOnce();
          return;
        }
        const x = Number.isFinite(e.x) ? e.x : width / 2;
        const y = Number.isFinite(e.y) ? e.y : 0;
        // D8: a word under the finger, only when the host wired the panel; hidden text has no boxes.
        const hit = onWord && !textHidden && hitTestRef?.current ? hitTestRef.current.hitTest(x, y) : null;
        // D8: the panel is open. Another word swaps it; anything else closes it and resumes.
        if (panelOpen) {
          if (hit !== null) {
            if (hit !== wordAt) onWord?.(hit);
          } else {
            onWord?.(null);
            onResume?.();
          }
          return;
        }
        // A middle-tap pause: the dim's own Pressable resumes (both see the touch), so nothing here.
        if (paused) return;
        if (hit !== null) {
          onWord?.(hit);
          onPause?.();
          return;
        }
        if (x < width / 4) (onPrev ?? (() => onJump(0)))();
        else if (x > (width * 3) / 4) onSkip?.();
        else if (waiting) onRecord?.();
        else onPause?.();
      });
    const body = Gesture.Exclusive(hold, tap);
    // The cube wins once the finger moves sideways; otherwise a hold pauses with the translation and, if released first, the tap fires.
    return cube ? Gesture.Race(cube, body) : body;
  }, [stopOnce, onRecord, onPause, onSkip, onPrev, onJump, isRecording, textHidden, waiting, paused, setPeek, cube, hitTestRef, wordAt, panelOpen, onWord, onResume, width, heldPause]);
  return { gesture };
}
