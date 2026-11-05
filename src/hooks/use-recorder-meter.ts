import type { AudioRecorder } from 'expo-audio';
import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { useSharedValue, type SharedValue } from 'react-native-reanimated';

import { meterLevel } from '@/components/level-bars';

/** How often the recorder is read while a take runs. */
const POLL_MS = 50;

/**
 * The recorder's meter and clock without a render per sample (D57). While
 * `active`, a 50 ms poll reads `recorder.getStatus()` into shared values:
 * `level` (0..1, noise-gated) for the bars and `progress` (0..1 of
 * `maxSeconds`) for the track, so both move without touching React. The
 * screen re-renders only when `seconds` changes, once a second. `millisRef`
 * holds the latest duration for a stop that needs the exact length;
 * `onSample` gets every level while active.
 */
export function useRecorderMeter(
  recorder: AudioRecorder,
  active: boolean,
  maxSeconds: number,
  onSample?: (level: number) => void,
): { level: SharedValue<number>; progress: SharedValue<number>; seconds: number; millisRef: MutableRefObject<number> } {
  const level = useSharedValue(0);
  const progress = useSharedValue(0);
  const [seconds, setSeconds] = useState(0);
  const millisRef = useRef(0);
  const onSampleRef = useRef(onSample);
  useEffect(() => {
    onSampleRef.current = onSample;
  });

  useEffect(() => {
    if (!active) {
      // Reset between takes, so the next one never starts on the last one's
      // clock (a stale count at the cap would stop it at once).
      level.value = 0;
      progress.value = 0;
      millisRef.current = 0;
      setSeconds(0);
      return;
    }
    let whole = -1;
    const id = setInterval(() => {
      let millis = 0;
      let db: number | undefined;
      try {
        const status = recorder.getStatus();
        millis = status.durationMillis ?? 0;
        db = status.metering;
      } catch {
        // The recorder is gone (released or never prepared): keep the last values.
        return;
      }
      const v = meterLevel(db);
      level.value = v;
      progress.value = Math.min(1, millis / (maxSeconds * 1000));
      millisRef.current = millis;
      onSampleRef.current?.(v);
      const next = Math.floor(millis / 1000);
      if (next !== whole) {
        whole = next;
        setSeconds(next);
      }
    }, POLL_MS);
    return () => clearInterval(id);
  }, [recorder, active, maxSeconds, level, progress]);

  return { level, progress, seconds: active ? seconds : 0, millisRef };
}
