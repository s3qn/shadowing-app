import { useLayoutEffect, useRef } from 'react';
import {
  cancelAnimation,
  runOnJS,
  type SharedValue,
  useAnimatedStyle,
  withTiming,
} from 'react-native-reanimated';

import {
  PIECE_RISE,
  PLAIN_MS,
  resetReveal,
  revealCard,
  revealDock,
  revealRise,
  revealRows,
  revealToolbar,
  setRevealLines,
} from '@/lib/content-reveal';

export { PIECE_RISE };

/** On back the content fades out together before the card morph starts. */
const OUT_MS = 120;

export type ContentReveal = {
  card: SharedValue<number>;
  rows: SharedValue<number>;
  toolbar: SharedValue<number>;
  dock: SharedValue<number>;
  /** 1 while pieces rise as they fade in, 0 for a fade without movement. */
  rise: SharedValue<number>;
};

const VALUES: ContentReveal = {
  card: revealCard,
  rows: revealRows,
  toolbar: revealToolbar,
  dock: revealDock,
  rise: revealRise,
};

type Options = {
  /** The island's lines are on screen to reveal. */
  ready: boolean;
  /** An open card morph covered the screen when it mounted: the morph armed
   * the reveal and its landing starts it. Read once, at mount. */
  coveredAtMount: boolean;
  /** The screen was opened by the card morph, with motion allowed. */
  staged: boolean;
};

function finite(n: number, fallback = 0) {
  'worklet';
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

/**
 * The player's content reveal, on module-level UI-thread values (see
 * lib/content-reveal.ts) so the card morph's landing starts it without a
 * JS round trip. Held at 0 while the morph covers the screen; once it lands,
 * or once the lines arrive after that, the pieces rise in one after another.
 * `hide` fades them all out together, for the back morph. This hook never
 * renders the screen.
 */
export function useContentReveal({ ready, coveredAtMount, staged }: Options) {
  const leaving = useRef(false);
  const mountedRef = useRef(false);

  // Before the ready effect below, in the same commit.
  useLayoutEffect(() => {
    if (mountedRef.current) return;
    mountedRef.current = true;
    if (!coveredAtMount) resetReveal();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read once, at mount
  }, []);

  useLayoutEffect(() => {
    if (leaving.current) return;
    setRevealLines(ready, staged);
  }, [ready, staged]);

  /** Fades every piece out together, then runs `then` on the JS thread. It
   * runs even if the fade is cut short, so a back is never left hanging;
   * `then` checks the screen is still there. */
  function hide(then: () => void) {
    leaving.current = true;
    revealRise.value = 0;
    [revealCard, revealRows, revealToolbar].forEach((v) => {
      cancelAnimation(v);
      v.value = withTiming(0, { duration: OUT_MS });
    });
    cancelAnimation(revealDock);
    revealDock.value = withTiming(0, { duration: OUT_MS }, () => {
      runOnJS(then)();
    });
  }

  /** Brings the content back after a `hide` whose back never happened. */
  function show() {
    leaving.current = false;
    revealRise.value = 0;
    [revealCard, revealRows, revealToolbar, revealDock].forEach((v) => {
      cancelAnimation(v);
      v.value = withTiming(1, { duration: PLAIN_MS });
    });
  }

  return { values: VALUES, hide, show };
}

/** Opacity and the rise for one piece. */
export function usePieceStyle(piece: SharedValue<number>, rise: SharedValue<number>) {
  return useAnimatedStyle(() => {
    const v = finite(piece.value, 1);
    return {
      opacity: v,
      transform: [{ translateY: finite(rise.value) * (1 - v) * PIECE_RISE }],
    };
  });
}
