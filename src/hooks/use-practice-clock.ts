import { type AudioPlayer, type AudioStatus } from 'expo-audio';
import { useEffect, useRef } from 'react';

import { addPractice, flushPractice } from '@/lib/practice';

/**
 * Counts seconds the line player was audibly playing as shadowing practice,
 * breath included, across every mode that plays it (the ring, a line's
 * repeats, the island running on, phrase loop, locked or background playback, and the line
 * half of Calibrate speaker and Auto Echo's Listen step). It never counts a
 * take played back, including Auto Echo's Speak or Play steps.
 *
 * Listens to the player itself rather than taking a status, so the screen
 * does not have to re-render on every 50ms update for this to see them.
 */
export function usePracticeClock(islandId: string | undefined, player: AudioPlayer): void {
  const prev = useRef<{ player: AudioPlayer; time: number; playing: boolean } | null>(null);
  const idRef = useRef(islandId);
  idRef.current = islandId;

  useEffect(() => {
    // A new player starts without a baseline: its first update is the one
    // the next delta is measured from. The old player's last status decides
    // whether this was a stop point.
    if (prev.current && prev.current.player !== player) {
      const wasPlaying = prev.current.playing;
      prev.current = null;
      if (!wasPlaying) void flushPractice();
    }
    const sub = player.addListener('playbackStatusUpdate', (s: AudioStatus) => {
      const p = prev.current;
      // Only a change of position or playing counts, as an effect keyed on
      // those two would.
      if (p && p.player === player && p.time === s.currentTime && p.playing === s.playing) return;
      if (s.playing && p && p.player === player) {
        const delta = s.currentTime - p.time;
        // A negative delta is the native loop wrapping or a seek to 0; a delta
        // above 1s is a seek or a stall. Both are skipped.
        if (delta > 0 && delta <= 1 && idRef.current) addPractice(idRef.current, delta);
      }
      prev.current = { player, time: s.currentTime, playing: s.playing };
      // A stop point: take start, compare handoff, tap word,
      // leaving the screen all pause first, so this is where the buffer lands.
      if (!s.playing) void flushPractice();
    });
    return () => sub.remove();
  }, [player]);

  useEffect(() => {
    return () => {
      void flushPractice();
    };
  }, []);
}
