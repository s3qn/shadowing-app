import { useIsFocused } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { type SharedValue, useFrameCallback, useSharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { devWelcomeSlow } from '@/lib/dev-simulate';

/** The hand-off length in ms: the welcome layer unmounts once `tk - tapT` reaches it. */
export const HANDOFF_MS = 760;

/**
 * The welcome's one clock. `tk` is ms since the welcome mounted, advanced on
 * the UI thread; `tapT` is Infinity until Get started is pressed, then the
 * `tk` of that press. Every hero, exit and Account-entrance value is a
 * worklet of these two: `h = tapT === Infinity ? -1 : tk - tapT`.
 */
export type HeroClock = { tk: SharedValue<number>; tapT: SharedValue<number> };

/**
 * Runs the clock while `running`, the screen is focused and the app is in
 * the foreground (a blur freezes it; on return it continues from the same
 * ms). Reduced motion keeps it running: the fades read `h` too. `press`
 * stamps `tapT` once; a second press is a no-op. `onDone` fires once, from
 * the frame after `h` reaches `HANDOFF_MS`, the only JS crossing.
 */
export function useHeroClock({ running, onDone }: { running: boolean; onDone: () => void }): HeroClock & { press: () => void } {
  const tk = useSharedValue(0);
  const tapT = useSharedValue(Infinity);
  const fired = useSharedValue(0);
  // Read once: the frame worklet is registered on the first render only.
  const slow = useRef(devWelcomeSlow()).current;
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const done = useCallback(() => doneRef.current(), []);

  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => setAppActive(state === 'active'));
    return () => sub.remove();
  }, []);
  const isFocused = useIsFocused();

  const frame = useFrameCallback((info) => {
    // Capped: the first frame after a pause reports the whole gap.
    tk.value += Math.min(64, info.timeSincePreviousFrame ?? 16) / slow;
    const gate = tapT.value;
    if (gate !== Infinity && tk.value - gate >= HANDOFF_MS && fired.value === 0) {
      fired.value = 1;
      scheduleOnRN(done);
    }
  }, false);
  const setActive = frame.setActive;
  const active = running && isFocused && appActive;
  useEffect(() => {
    setActive(active);
  }, [active, setActive]);

  const press = useCallback(() => {
    if (tapT.value === Infinity) tapT.value = tk.value;
  }, [tapT, tk]);

  return { tk, tapT, press };
}
