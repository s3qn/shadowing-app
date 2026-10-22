import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';

import * as Haptics from 'expo-haptics';
import { Easing, useSharedValue, withSequence, withTiming } from 'react-native-reanimated';

import * as api from '@/lib/api';
import { confirmSheet } from '@/lib/confirm-sheet';
import { hapticImpact, hapticNotify } from '@/lib/haptics';
import { t } from '@/lib/i18n';

/** Seconds before the word's start a tap still counts: the YouTube clock's
 * 250 ms granularity plus whisper's word times, which run 100 to 300 ms off. */
export const CATCH_EARLY_S = 0.3;
/** Seconds after the word's end a tap still counts: reaction time plus a
 * Bluetooth headphone's delay. The picker keeps the window inside the line. */
export const CATCH_LATE_S = 1.0;
const FLASH_EASING = Easing.out(Easing.quad);
/** How long the no-words or failed-fetch hint stays under the dock. */
const ERROR_MS = 4000;

export type CatchPhase = 'off' | 'loading' | 'armed' | 'card' | 'done';

/** The player's controls the game drives. Held in a ref by the screen, so
 * the hook can be called before the controls exist. */
export type CatchDeps = {
  /** Seeks to a line of `lines` and plays it. */
  jump: (i: number) => void;
  /** Lifts the highlight's hold at a line's end. */
  releaseLine: () => void;
  setPlaying: (v: boolean) => void;
  /** Runs before the fetch: stops the ladder and leaves fullscreen. */
  onStart: () => void;
  /** The player's time in seconds, null before the first reply after a seek. */
  now: () => number | null;
};

/** A server target placed in the player: its index in `lines` and the
 * absolute player seconds a tap counts in. */
export type CatchPlaced = api.CatchTarget & { line: number; from: number; to: number };

function place(targets: api.CatchTarget[], lines: api.Line[], startS: number): CatchPlaced[] {
  const out: CatchPlaced[] = [];
  for (const target of targets) {
    // A target on a hidden back-channel line has no line to hold, so it is left out.
    const line = lines.findIndex((l) => l.idx === target.line_idx);
    if (line < 0) continue;
    const base = startS + (lines[line]!.offset ?? 0);
    out.push({ ...target, line, from: base + target.start - CATCH_EARLY_S, to: base + target.end + CATCH_LATE_S });
  }
  return out;
}

/**
 * Catch the word: the video plays on, the learner taps when the armed word is
 * said, and the card grades it. The server picks the targets and owns the
 * schedule; this hook holds the run, the armed word and the tap window.
 */
export function useCatch(islandId: string | undefined, lines: api.Line[], startS: number, deps: MutableRefObject<CatchDeps>) {
  const [phase, setPhaseState] = useState<CatchPhase>('off');
  const phaseRef = useRef<CatchPhase>('off');
  /** A line-final target's line has ended but its late tolerance has not: the miss card waits for it. */
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearHold = useCallback(() => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = null;
  }, []);
  const setPhase = useCallback(
    (p: CatchPhase) => {
      clearHold();
      phaseRef.current = p;
      setPhaseState(p);
    },
    [clearHold],
  );
  const [targets, setTargets] = useState<CatchPlaced[]>([]);
  const targetsRef = useRef<CatchPlaced[]>([]);
  const [armed, setArmedState] = useState(0);
  const armedRef = useRef(0);
  /** One wrong tap per target: a tap outside the window disarms the button
   * until the target's line ends, so the word counts as missed. */
  const [disarmed, setDisarmedState] = useState(false);
  const disarmedRef = useRef(false);
  const setDisarmed = useCallback((v: boolean) => {
    disarmedRef.current = v;
    setDisarmedState(v);
  }, []);
  const setArmed = useCallback(
    (i: number) => {
      clearHold();
      setDisarmed(false);
      armedRef.current = i;
      setArmedState(i);
    },
    [clearHold, setDisarmed],
  );
  const [hit, setHitState] = useState(false);
  const hitRef = useRef(false);
  const setHit = useCallback((v: boolean) => {
    hitRef.current = v;
    setHitState(v);
  }, []);
  /** The word the card is about. Kept past the grade, so the card never
   * shows the next word while it slides out. */
  const [cardTarget, setCardTarget] = useState<CatchPlaced | null>(null);
  /** 0 to 1: a hit flashes the HUD word gold (100 ms up, 400 ms back). */
  const flash = useSharedValue(0);
  const [error, setError] = useState('');
  const caught = useRef(0);
  /** The fetch in flight: a stop or a second start drops an older reply. */
  const run = useRef(0);

  // A word whose meaning missed at load time is fetched when its card opens.
  const missingId = cardTarget && !cardTarget.meaning ? cardTarget.id : '';
  useEffect(() => {
    if (!missingId || !islandId) return;
    let live = true;
    api
      .catchMeaning(islandId, missingId)
      .then((meaning) => {
        if (!live || !meaning) return;
        targetsRef.current = targetsRef.current.map((x) => (x.id === missingId ? { ...x, meaning } : x));
        setCardTarget((c) => (c && c.id === missingId ? { ...c, meaning } : c));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [missingId, islandId]);

  // The hint under the dock (no words, a failed fetch) goes after a few seconds.
  useEffect(() => {
    if (!error) return;
    const id = setTimeout(() => setError(''), ERROR_MS);
    return () => clearTimeout(id);
  }, [error]);

  useEffect(
    () => () => {
      run.current += 1;
      clearHold();
    },
    [clearHold],
  );

  const start = useCallback(() => {
    if (!islandId || phaseRef.current !== 'off') return;
    const id = run.current + 1;
    run.current = id;
    setError('');
    caught.current = 0;
    deps.current.onStart();
    setPhase('loading');
    api
      .catchWords(islandId)
      .then((res) => {
        if (id !== run.current) return;
        const list = place(res.targets, lines, startS);
        if (list.length === 0) {
          setError(t('video.catch.noWords'));
          setPhase('off');
          return;
        }
        targetsRef.current = list;
        setTargets(list);
        setArmed(0);
        setHit(false);
        setPhase('armed');
        deps.current.jump(list[0]!.line);
      })
      .catch((e) => {
        if (id !== run.current) return;
        setError(e instanceof Error ? e.message : t('video.loadFailed'));
        setPhase('off');
        // A throw after the targets landed (the jump) leaves none behind for the HUD.
        targetsRef.current = [];
        setTargets([]);
      });
  }, [islandId, lines, startS, deps, setPhase, setArmed, setHit]);

  const stop = useCallback(() => {
    run.current += 1;
    clearHold();
    if (phaseRef.current === 'off') return;
    setPhase('off');
    targetsRef.current = [];
    setTargets([]);
    // A held line (a miss, a replay) is let go; harmless when nothing is held.
    deps.current.releaseLine();
  }, [clearHold, deps, setPhase]);

  /** The summary once the last word is graded, then the video plays on. */
  const finish = useCallback(() => {
    const n = targetsRef.current.length;
    void confirmSheet({
      title: t('video.catch.done.title', { x: caught.current, y: n }),
      actions: [{ label: t('video.catch.done.ok'), verb: 'tools' }],
    }).then(() => {
      if (phaseRef.current !== 'done') return;
      setPhase('off');
      targetsRef.current = [];
      setTargets([]);
      deps.current.releaseLine();
      deps.current.setPlaying(true);
    });
  }, [deps, setPhase]);

  /** Arms the next target, or ends the game after the last one. */
  const next = useCallback(() => {
    const k = armedRef.current + 1;
    if (k < targetsRef.current.length) {
      setArmed(k);
      setPhase('armed');
      deps.current.releaseLine();
      deps.current.setPlaying(true);
      return;
    }
    // The card's exit runs first; its onDismissed opens the summary.
    setPhase('done');
  }, [deps, setArmed, setPhase]);

  /** The Catch button, with the player's time on the JS side (null before the first reply after a seek). */
  const tap = (now: number | null) => {
    if (phaseRef.current !== 'armed' || disarmedRef.current) return;
    const target = targetsRef.current[armedRef.current];
    if (!target) return;
    if (now !== null && now >= target.from && now <= target.to) {
      caught.current += 1;
      void hapticNotify(Haptics.NotificationFeedbackType.Success);
      flash.value = withSequence(withTiming(1, { duration: 100, easing: FLASH_EASING }), withTiming(0, { duration: 400, easing: FLASH_EASING }));
      deps.current.setPlaying(false);
      setHit(true);
      setCardTarget(target);
      setPhase('card');
      return;
    }
    void hapticImpact(Haptics.ImpactFeedbackStyle.Light);
    setDisarmed(true);
  };

  /** The miss card for the armed target, once its tap window has closed. A
   * line-final word's window runs past its line's end, so the card waits on
   * the player's clock (rechecked, as the speed may not be 1). */
  const missWhenClosed = useCallback(() => {
    const check = () => {
      holdTimer.current = null;
      if (phaseRef.current !== 'armed') return;
      const target = targetsRef.current[armedRef.current];
      if (!target) return;
      const now = deps.current.now();
      const left = now === null || disarmedRef.current ? 0 : target.to - now;
      if (Number.isFinite(left) && left > 0.05) {
        holdTimer.current = setTimeout(check, Math.max(50, left * 1000));
        return;
      }
      deps.current.setPlaying(false);
      setHit(false);
      setCardTarget(target);
      setPhase('card');
    };
    check();
  }, [deps, setHit, setPhase]);

  /** A line's end while the game is on. Returns false when the game is off,
   * so the screen's Repeat handling runs instead. */
  const onLineEnd = useCallback(
    (i: number): boolean => {
      const p = phaseRef.current;
      if (p === 'off') return false;
      const d = deps.current;
      if (p === 'armed') {
        const target = targetsRef.current[armedRef.current];
        if (target && i === target.line) {
          // Missed unless a tap lands in the rest of the window: the line holds at its end, then under the card.
          clearHold();
          missWhenClosed();
        } else if (target && i > target.line) {
          // The learner moved past the target (Next, a line tap): no grade, the next one ahead is armed.
          const k = targetsRef.current.findIndex((x, j) => j > armedRef.current && x.line > i);
          if (k >= 0) {
            setArmed(k);
            d.releaseLine();
          } else {
            d.setPlaying(false);
            setPhase('done');
            finish();
          }
        } else d.releaseLine();
        return true;
      }
      // Card: Hear again played the line once, it holds at its end.
      if (p === 'card') d.setPlaying(false);
      else d.releaseLine();
      return true;
    },
    [deps, clearHold, missWhenClosed, setPhase, setArmed, finish],
  );

  const grade = useCallback(
    (knew: boolean) => {
      if (phaseRef.current !== 'card') return;
      const target = targetsRef.current[armedRef.current];
      if (target && islandId) api.catchReview(islandId, target.id, hitRef.current, knew).catch(() => {});
      next();
    },
    [islandId, next],
  );

  /** The card dismissed without a grade: no POST, the word stays as it was. */
  const skip = useCallback(() => {
    if (phaseRef.current !== 'card') return;
    next();
  }, [next]);

  const hearAgain = useCallback(() => {
    if (phaseRef.current !== 'card') return;
    const target = targetsRef.current[armedRef.current];
    if (target) deps.current.jump(target.line);
  }, [deps]);

  /** The card's exit has settled: after the last word, the summary opens here so the two sheets never overlap. */
  const onCardDismissed = useCallback(() => {
    if (phaseRef.current === 'done') finish();
  }, [finish]);

  return {
    phase,
    targets,
    armed,
    target: targets[armed] ?? null,
    cardTarget,
    hit,
    flash,
    error,
    disarmed,
    /** The transcript hides while a word is armed, so it cannot be read off the screen. */
    hideText: phase === 'armed',
    start,
    stop,
    tap,
    onLineEnd,
    grade,
    skip,
    hearAgain,
    onCardDismissed,
  };
}
