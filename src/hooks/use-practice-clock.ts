import { type AudioPlayer, type AudioStatus } from 'expo-audio';
import { useEffect, useRef } from 'react';

import { addPractice, flushPractice } from '@/lib/practice';

/**
 * Counts seconds the line player was audibly playing as shadowing practice,
 * breath included, across every mode that plays it (the ring, Repeat Line,
 * Repeat Island, phrase loop, locked or background playback, and the line
 * half of Calibrate speaker and Auto Echo's Listen step). It never counts a
 * take played back, including Auto Echo's Speak or Play steps.
 */
export function usePracticeClock(islandId: string | undefined, player: AudioPlayer, status: AudioStatus): void {
  const prev = useRef<{ player: AudioPlayer; time: number } | null>(null);

  useEffect(() => {
    // A swap lands a render with the new player but expo-audio's status
    // hook still holds the old player's last status until the new player's
    // first native event (it only resets state on a real event, not on the
    // player changing). Drop the baseline instead of trusting that status as
    // the new player's start: the next effect run only fires on an actual
    // currentTime/playing change, so it is guaranteed to be a genuine status
    // for the new player.
    if (prev.current && prev.current.player !== player) {
      prev.current = null;
      if (!status.playing) void flushPractice();
      return;
    }
    if (status.playing && prev.current) {
      const delta = status.currentTime - prev.current.time;
      // A negative delta is the native loop wrapping or a seek to 0; a delta
      // above 1s is a seek or a stall. Both are skipped.
      if (delta > 0 && delta <= 1 && islandId) addPractice(islandId, delta);
    }
    prev.current = { player, time: status.currentTime };
    // A stop point: end of Repeat Off, take start, compare handoff, tap word,
    // leaving the screen all pause first, so this is where the buffer lands.
    if (!status.playing) void flushPractice();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.currentTime, status.playing, player]);

  useEffect(() => {
    return () => {
      void flushPractice();
    };
  }, []);
}
