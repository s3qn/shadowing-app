import { useAudioPlayer, type AudioMetadata, type AudioStatus } from 'expo-audio';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Easing, useReducedMotion, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';

import { usePracticeClock } from '@/hooks/use-practice-clock';
import * as api from '@/lib/api';
import {
  LOCK_SCREEN_AVAILABLE,
  lockArtwork,
  setExclusivePlayback,
  scheduleAudioSessionRelease,
  startPlayback,
  stopPlayback,
  useSessionPlayer,
} from '@/lib/audio-mode';
import { driveQueue, drivePadMs, startPos, stepLine, type DrivePos } from '@/lib/drive-queue';
import { t } from '@/lib/i18n';
import { prewarmIsland, readCachedIsland } from '@/lib/island-cache';
import { localLineAudio, prefetchLineAudio } from '@/lib/line-audio-cache';
import { getSettingsSync } from '@/lib/settings';
import { getRung } from '@/lib/speed-ladder';

export type DrivePhase = 'loading' | 'listen' | 'repeat' | 'paused' | 'offline' | 'empty';

// Statuses this soon after a replace() can belong to the old item.
const STALE_MS = 400;
// A native status can repeat didJustFinish; mirrors FINISH_GUARD_MS in island/[id].tsx.
const FINISH_GUARD_MS = 600;
const LOAD_TIMEOUT_MS = 8000;
const ERROR_WAIT_MS = 2000;
const MAX_ERRORS = 3;
// Time given to startPlayback before a not-playing status counts as a pause.
const PLAY_GRACE_MS = 1500;
const JUMP_FORWARD_S = 2;
const JUMP_BACK_S = -0.3;

type Item = { url: string; tag: string; padMs: number; island: api.Island; line: api.Line };

/**
 * The Drive Mode engine: a continuous radio over the user's islands with audio.
 * Each line is one audio item that already ends in its silent gap (the backend
 * appends it), so the lock screen stays "playing" through the gap. No recording,
 * no scoring. Status handling lives in refs; React state changes only when the
 * phase, line or island change.
 */
export function useDrive(start: { id?: string; line?: number }): {
  phase: DrivePhase;
  island: { id: string; title: string; lineCount: number } | null;
  line: { idx: number; ja: string; en: string } | null;
  progress: SharedValue<number>;
  toggle(): void;
  next(): void;
  previous(): void;
} {
  const reduced = useReducedMotion();
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;
  const progress = useSharedValue(0);
  const player = useAudioPlayer(null, { updateInterval: 250, keepAudioSessionActive: true });
  useSessionPlayer(player);

  const [phase, setPhaseState] = useState<DrivePhase>('loading');
  const [island, setIsland] = useState<{ id: string; title: string; lineCount: number } | null>(null);
  const [line, setLine] = useState<{ idx: number; ja: string; en: string } | null>(null);
  const [clockId, setClockId] = useState<string | undefined>(undefined);
  usePracticeClock(clockId, player);

  const startRef = useRef(start);
  const phaseRef = useRef<DrivePhase>('loading');
  const queue = useRef<api.IslandSummary[]>([]);
  const islands = useRef(new Map<string, Promise<api.Island>>());
  const pos = useRef<DrivePos>({ island: 0, line: 0 });
  const token = useRef(0);
  const busy = useRef(true);
  const replaceAt = useRef(0);
  const padMs = useRef(0);
  const prevTime = useRef<number | null>(null);
  const ownSeekUntil = useRef(0);
  const lastFinish = useRef(0);
  const lastPlaying = useRef(false);
  const errors = useRef(0);
  const failTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lockOn = useRef(false);
  const goRef = useRef<(p: DrivePos) => Promise<void>>(async () => {});

  const setPhase = useCallback((p: DrivePhase) => {
    if (phaseRef.current === p) return;
    phaseRef.current = p;
    setPhaseState(p);
  }, []);

  const clearTimers = useCallback(() => {
    if (failTimer.current) clearTimeout(failTimer.current);
    if (loadTimer.current) clearTimeout(loadTimer.current);
    failTimer.current = null;
    loadTimer.current = null;
  }, []);

  const loadIsland = useCallback((id: string): Promise<api.Island> => {
    let p = islands.current.get(id);
    if (!p) {
      p = (async () => {
        const cached = await readCachedIsland(id);
        return cached ? cached.island : api.getIsland(id);
      })();
      p.catch(() => islands.current.delete(id));
      islands.current.set(id, p);
    }
    return p;
  }, []);

  const itemAt = useCallback(
    async (at: DrivePos): Promise<Item | null> => {
      const summary = queue.current[at.island];
      if (!summary) return null;
      const isl = await loadIsland(summary.id);
      const ln = isl.lines[Math.min(at.line, isl.lines.length - 1)];
      if (!ln) return null;
      const speed = (await getRung(isl.id, getSettingsSync().defaultSpeed)).speed;
      const pad = drivePadMs(ln.duration, speed);
      const url = api.lineAudioUrl(isl.id, ln.idx, `${isl.speaker}-0`, speed, pad);
      return { url, tag: ln.ja, padMs: pad, island: isl, line: ln };
    },
    [loadIsland],
  );

  const prefetchAhead = useCallback(
    async (from: DrivePos, tok: number) => {
      const counts = queue.current.map((i) => i.line_count);
      let at = from;
      const items: { url: string; tag: string }[] = [];
      for (let k = 0; k < 3; k++) {
        at = stepLine(at, 1, counts);
        try {
          const it = await itemAt(at);
          if (tok !== token.current) return;
          if (it) items.push({ url: api.withUser(it.url), tag: it.tag });
        } catch {
          break;
        }
      }
      if (tok === token.current && items.length) prefetchLineAudio(items);
    },
    [itemAt],
  );

  const lockMeta = useCallback((it: Item): AudioMetadata => {
    return {
      title: it.line.ja,
      artist: it.island.title || t('player.island'),
      albumTitle: t('player.lineOfTotal', { index: it.line.idx + 1, total: it.island.lines.length }),
      artworkUrl: lockArtwork(),
    };
  }, []);

  const fail = useCallback(() => {
    if (failTimer.current) return;
    errors.current += 1;
    if (errors.current >= MAX_ERRORS) {
      stopPlayback(player);
      busy.current = true;
      setPhase('offline');
      return;
    }
    failTimer.current = setTimeout(() => {
      failTimer.current = null;
      const counts = queue.current.map((i) => i.line_count);
      void goRef.current(stepLine(pos.current, 1, counts));
    }, ERROR_WAIT_MS);
  }, [player, setPhase]);

  const go = useCallback(
    async (target: DrivePos) => {
      const tok = ++token.current;
      busy.current = true;
      replaceAt.current = Date.now();
      clearTimers();
      let it: Item | null;
      try {
        it = await itemAt(target);
      } catch {
        if (tok === token.current) fail();
        return;
      }
      if (tok !== token.current) return;
      if (!it) {
        fail();
        return;
      }
      pos.current = target;
      padMs.current = it.padMs;
      setIsland((p) =>
        p && p.id === it.island.id ? p : { id: it.island.id, title: it.island.title, lineCount: it.island.lines.length },
      );
      setLine({ idx: it.line.idx, ja: it.line.ja, en: it.line.en });
      setClockId(it.island.id);
      if (phaseRef.current !== 'loading') setPhase('listen');
      progress.value = 0;
      prevTime.current = null;
      lastPlaying.current = false;
      replaceAt.current = Date.now();
      try {
        player.replace({ uri: localLineAudio(it.url, it.tag) ?? api.withUser(it.url) });
        if (!LOCK_SCREEN_AVAILABLE) {
          // Web and Android Expo Go have no lock screen controls.
        } else if (!lockOn.current) {
          lockOn.current = true;
          player.setActiveForLockScreen(true, lockMeta(it), { showSeekForward: true, showSeekBackward: true });
        } else {
          player.updateLockScreenMetadata(lockMeta(it));
        }
      } catch {
        // The screen is unmounting and the player is released.
        return;
      }
      busy.current = false;
      startPlayback(player);
      loadTimer.current = setTimeout(fail, LOAD_TIMEOUT_MS);
      // Warm what comes next: the following island once this one starts, the lines after this one.
      const counts = queue.current.map((i) => i.line_count);
      const nextIsland = queue.current[stepLine({ island: target.island, line: it.island.lines.length - 1 }, 1, counts).island];
      if (nextIsland && nextIsland.id !== it.island.id) prewarmIsland(nextIsland.id);
      void prefetchAhead(target, tok);
    },
    [clearTimers, fail, itemAt, lockMeta, player, prefetchAhead, progress, setPhase],
  );
  goRef.current = go;

  const step = useCallback((dir: 1 | -1) => {
    if (queue.current.length === 0) return;
    errors.current = 0;
    void goRef.current(stepLine(pos.current, dir, queue.current.map((i) => i.line_count)));
  }, []);
  const next = useCallback(() => step(1), [step]);
  const previous = useCallback(() => step(-1), [step]);

  const toggle = useCallback(() => {
    if (phaseRef.current === 'offline') {
      errors.current = 0;
      void goRef.current(pos.current);
      return;
    }
    if (phaseRef.current === 'loading' || phaseRef.current === 'empty') return;
    if (lastPlaying.current || phaseRef.current !== 'paused') {
      stopPlayback(player);
      lastPlaying.current = false;
      setPhase('paused');
      return;
    }
    try {
      ownSeekUntil.current = Date.now() + 1000;
      prevTime.current = null;
      void player.seekTo(0);
    } catch {
      return;
    }
    startPlayback(player);
    replaceAt.current = Date.now();
  }, [player, setPhase]);

  // Status: one listener, refs only.
  useEffect(() => {
    const sub = player.addListener('playbackStatusUpdate', (s: AudioStatus) => {
      const now = Date.now();
      if (busy.current || now - replaceAt.current < STALE_MS) return;
      if (s.error) {
        fail();
        return;
      }
      if (!s.isLoaded) return;
      if (loadTimer.current) {
        clearTimeout(loadTimer.current);
        loadTimer.current = null;
      }
      errors.current = 0;
      lastPlaying.current = s.playing;
      if (s.didJustFinish) {
        if (now - lastFinish.current < FINISH_GUARD_MS) return;
        lastFinish.current = now;
        step(1);
        return;
      }
      const prev = prevTime.current;
      prevTime.current = s.currentTime;
      if (prev !== null && now > ownSeekUntil.current) {
        const delta = s.currentTime - prev;
        if (delta > JUMP_FORWARD_S) {
          step(1);
          return;
        }
        if (delta < JUMP_BACK_S) {
          step(-1);
          return;
        }
      }
      if (s.duration > 0) {
        const to = Math.min(1, s.currentTime / s.duration);
        progress.value = reducedRef.current ? to : withTiming(to, { duration: 250, easing: Easing.linear });
      }
      if (!s.playing) {
        if (!s.isBuffering && now - replaceAt.current > PLAY_GRACE_MS) setPhase('paused');
        return;
      }
      const audioEnd = s.duration - padMs.current / 1000;
      setPhase(s.currentTime < audioEnd ? 'listen' : 'repeat');
    });
    return () => sub.remove();
  }, [player, fail, step, progress, setPhase]);

  // Queue and first line.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        await setExclusivePlayback(true);
        const all = await api.listIslands();
        if (!alive) return;
        const s = getSettingsSync();
        const q = driveQueue(all, s.learningLanguage, s.showAllLanguages);
        queue.current = q;
        if (q.length === 0) {
          setPhase('empty');
          return;
        }
        void goRef.current(startPos(q, startRef.current.id, startRef.current.line));
      } catch {
        if (alive) setPhase('offline');
      }
    })();
    return () => {
      alive = false;
    };
  }, [setPhase]);

  // Keep awake, per the setting.
  useEffect(() => {
    if (!getSettingsSync().keepAwake) return;
    void activateKeepAwakeAsync('drive');
    return () => {
      void deactivateKeepAwake('drive');
    };
  }, []);

  useEffect(() => {
    return () => {
      token.current += 1;
      busy.current = true;
      clearTimers();
      stopPlayback(player);
      if (LOCK_SCREEN_AVAILABLE) {
        try {
          player.clearLockScreenControls();
        } catch {
          // Already released.
        }
      }
      void setExclusivePlayback(false);
      scheduleAudioSessionRelease();
    };
  }, [player, clearTimers]);

  return { phase, island, line, progress, toggle, next, previous };
}
