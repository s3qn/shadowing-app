// Easy for me on the island: the glide to another line, the mark and unmark calls
// with their toast and rollback, and the stage chip's action. Owner: I1e.
// State (`known`, `easyOffer`, `easyDone`) and the timers stay in the route; this takes them.
import { router } from 'expo-router';
import { useMemo, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { Easing, withSpring, withTiming, type SharedValue } from 'react-native-reanimated';

import { useStableHandler } from '@/hooks/use-stable-handler';
import * as api from '@/lib/api';
import { alertSheet } from '@/lib/confirm-sheet';
import { getGuideStep, noteGuideEasyTap, setGuideStep } from '@/lib/guide';
import { useT } from '@/lib/i18n';
import { EASY_GLIDE_MS, ECHO_RESULT_HOLD_MS } from '@/lib/island/island-consts';
import { nextLongerIdx as nextLongerIdxPure } from '@/lib/island/word-hit';
import { noteAward } from '@/lib/progression';

type Timer = MutableRefObject<ReturnType<typeof setTimeout> | null>;

export type EasyMarkParams = {
  island: api.Island | null;
  setIsland: Dispatch<SetStateAction<api.Island | null>>;
  idx: number;
  line: api.Island['lines'][number] | undefined;
  lineKnown: boolean;
  known: ReadonlySet<number>;
  setKnown: Dispatch<SetStateAction<ReadonlySet<number>>>;
  setEasyOffer: Dispatch<SetStateAction<number | null>>;
  setEasyDone: Dispatch<SetStateAction<{ count: number } | null>>;
  easyTimer: Timer;
  glideTimer: Timer;
  glideY: SharedValue<number>;
  glideOp: SharedValue<number>;
  reducedMotion: boolean;
  go: (target: number, keepPlaying?: boolean) => void;
  ladderActive: boolean;
  auto: string | undefined;
  guideOn: boolean;
  endRun: () => void;
  runLine: (i: number) => void;
  autoRunRef: MutableRefObject<boolean>;
  autoIslandDone: () => void;
  t: ReturnType<typeof useT>['t'];
};

export function useEasyMark(p: EasyMarkParams) {
  const { island, setIsland, idx, line, lineKnown, known, setKnown, setEasyOffer, setEasyDone, easyTimer, glideTimer, glideY, glideOp, reducedMotion, go, auto, guideOn, endRun, runLine, autoRunRef, autoIslandDone, t } = p;
  // bl58-easy-for-me: Easy for me. A mark is a skip, never a grade: the line leaves Practice now and every later
  // line on this island runs Listen, Shadow, Compare. Nothing marks by itself; the 90+ offer only asks.
  const goLater = useStableHandler(go);
  function glideTo(target: number) {
    if (!island) return;
    const clamped = Math.max(0, Math.min(island.lines.length - 1, target));
    if (clamped === idx) return;
    if (reducedMotion) {
      go(clamped);
      return;
    }
    if (glideTimer.current) clearTimeout(glideTimer.current);
    const sink = { duration: EASY_GLIDE_MS, easing: Easing.bezier(0.4, 0, 1, 1) };
    glideY.value = withTiming(60, sink);
    glideOp.value = withTiming(0, sink);
    glideTimer.current = setTimeout(() => {
      goLater(clamped);
      glideY.value = 60;
      // The next line rises from the waterline 120 ms after the old one has sunk.
      glideTimer.current = setTimeout(() => {
        glideTimer.current = null;
        glideY.value = withSpring(0, { damping: 20, stiffness: 180 });
        glideOp.value = withTiming(1, { duration: 200 });
      }, 120);
    }, EASY_GLIDE_MS);
  }
  function nextLongerIdx(i: number): number {
    return nextLongerIdxPure(island, known, i);
  }
  function showEasyDone(count: number) {
    setEasyDone({ count });
    if (easyTimer.current) clearTimeout(easyTimer.current);
    easyTimer.current = setTimeout(() => {
      easyTimer.current = null;
      setEasyDone(null);
    }, ECHO_RESULT_HOLD_MS);
  }
  const markEasy = useStableHandler(async (i: number) => {
    const l = island?.lines[i];
    if (!island || !l) return;
    const islandId = island.id;
    const lineIdx = l.idx;
    setEasyOffer(null);
    // A run in progress ends first, as Pause does.
    // In a session the run carries on to the next line instead (below), as a Next tap inside a run does.
    const wasRun = p.ladderActive;
    const carryOn = wasRun && auto === '1' && !guideOn;
    if (wasRun && !carryOn) endRun();
    setKnown((s) => new Set(s).add(lineIdx));
    if (guideOn) {
      // Under the guide the mark is best effort and the island moves on as a finished Compare would; two taps end it.
      api.markKnown(islandId, lineIdx).catch(() => undefined);
      const step = getGuideStep();
      if (noteGuideEasyTap() >= 2 || step === 'solo') {
        setGuideStep('topics');
        router.replace('/phrases');
        return;
      }
      go(i + 1);
      if (step === 'listen' || step === 'shadow') setGuideStep('prep');
      else if (step === 'prep') setGuideStep('solo');
      return;
    }
    showEasyDone(known.has(lineIdx) ? known.size : known.size + 1);
    // A session keeps its order and its run; otherwise the island moves to the next longer line.
    if (carryOn && i + 1 < island.lines.length) runLine(i + 1);
    else if (carryOn) {
      endRun();
      if (autoRunRef.current) autoIslandDone();
    } else glideTo(auto === '1' ? i + 1 : nextLongerIdx(i));
    try {
      const res = await api.markKnown(islandId, lineIdx);
      setKnown(new Set(res.known));
      setIsland((cur) => (cur && cur.id === islandId ? { ...cur, known: res.known } : cur));
      noteAward(res.award);
      if (easyTimer.current) showEasyDone(res.known.length);
    } catch {
      setKnown((cur) => {
        const n = new Set(cur);
        n.delete(lineIdx);
        return n;
      });
      setEasyDone(null);
      void alertSheet(t('ladder.easyFailed'));
    }
  });
  const unmarkEasy = useStableHandler(async (i: number) => {
    const l = island?.lines[i];
    if (!island || !l) return;
    const islandId = island.id;
    const lineIdx = l.idx;
    // An unmark ends the count toast of the mark it undoes.
    if (easyTimer.current) clearTimeout(easyTimer.current);
    easyTimer.current = null;
    setEasyDone(null);
    setKnown((cur) => {
      const n = new Set(cur);
      n.delete(lineIdx);
      return n;
    });
    try {
      const res = await api.unmarkKnown(islandId, lineIdx);
      setKnown(new Set(res.known));
      setIsland((cur) => (cur && cur.id === islandId ? { ...cur, known: res.known } : cur));
    } catch {
      setKnown((cur) => new Set(cur).add(lineIdx));
      void alertSheet(t('ladder.easyFailed'));
    }
  });
  // The same mark for the stage view's small Easy chip above its hint.
  const hasLine = !!line;
  const easyChipAction = useMemo(
    () => (hasLine ? { on: lineKnown, onPress: () => (lineKnown ? unmarkEasy(idx) : markEasy(idx)) } : undefined),
    [hasLine, lineKnown, idx, markEasy, unmarkEasy],
  );
  return { glideTo, markEasy, unmarkEasy, easyChipAction };
}
