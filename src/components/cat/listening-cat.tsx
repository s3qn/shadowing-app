import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import { CatAvatar } from '@/components/cat/cat-avatar';
import type { ArtSpec, Equipped, KagenekoEmotion, KagenekoMode } from '@/constants/cosmetics';
import { ITEM_IMAGES } from '@/constants/cosmetic-images';
import { tide } from '@/constants/theme';
import { useEmotionPulse } from '@/hooks/use-emotion-pulse';
import type { Line } from '@/lib/api';
import { useDir } from '@/lib/i18n';
import { equippedArt, useProgressCache } from '@/lib/progression';

// Placement. Option 1 (recommended). Option 2 is SIZE 80, BOTTOM -24, INSET 8.
const CAT_SIZE = 64;
/** Below the slot's bottom edge; the slot's margin is 8, so the cat overlaps the 56 px capsule by 12. */
const CAT_BOTTOM = -20;
/** From the trailing edge of the screen (the leading edge in Hebrew). */
const CAT_INSET = 16;

const SLEEPY_AFTER_MS = 90_000;
const BUSY_CPS = 6;
const BUSY_WORDS_PER_S = 2.5;
const CURIOUS_MAX_MS = 6000;

/**
 * The one art slot of this file: headphones. Add assets/cosmetics/head.headphones.png (same canvas as
 * the other head items) and its 'head.headphones' line in ITEM_IMAGES (src/constants/cosmetic-images.ts),
 * and the cat wears it in the player. Until then the cat listens bare-headed. No require here: Metro
 * resolves every require at bundle time, so a missing file would break the whole bundle.
 */
const HEADPHONES: number | undefined = ITEM_IMAGES['head.headphones'];

export type ListeningCatInput = {
  playing: boolean;
  /** The active line, or null. */
  line: Line | null;
  rate: number;
  /** The active line is saved. */
  saved: boolean;
  /** Bumped by the player when the user saves a line that was not saved. */
  saveTick: number;
  /** Fullscreen, the ladder's stage view or no transcript: the cat is not mounted. */
  hidden: boolean;
};

function isBusy(line: Line): boolean {
  if (!(line.duration > 0)) return false;
  const chars = line.ja.replace(/\s/g, '').length;
  return chars / line.duration >= BUSY_CPS || line.words.length / line.duration >= BUSY_WORDS_PER_S;
}

/**
 * The cat that listens with the user, for the video and podcast players. Returns `cat` for the dock slot
 * and `noteTouch` for the player root's onTouchStart. The root touch is a ref write and a timer reset;
 * only waking from sleep sets state.
 */
export function useListeningCat(input: ListeningCatInput): { cat: ReactNode; noteTouch: () => void } {
  const { playing, line, rate, saved, saveTick, hidden } = input;
  const [pulse, firePulse] = useEmotionPulse();
  const [sleepy, setSleepy] = useState(false);
  const [petKey, setPetKey] = useState(0);
  const sleepyRef = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const live = useRef({ playing, rate, saved });
  useEffect(() => {
    live.current = { playing, rate, saved };
  });

  const arm = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      sleepyRef.current = true;
      setSleepy(true);
    }, SLEEPY_AFTER_MS);
  }, []);
  useEffect(() => {
    arm();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [arm]);
  const noteTouch = useCallback(() => {
    if (sleepyRef.current) {
      sleepyRef.current = false;
      setSleepy(false);
    }
    arm();
  }, [arm]);

  const pulseIfAwake = useCallback(
    (e: 'curious' | 'excited', ms: number) => {
      if (!sleepyRef.current) firePulse(e, ms);
    },
    [firePulse],
  );

  // A line starts while playing: ears up if it is saved, curious if it is busy.
  const idx = line?.idx;
  const lineRef = useRef(line);
  useEffect(() => {
    lineRef.current = line;
  });
  useEffect(() => {
    const l = lineRef.current;
    if (!l || idx === undefined || !live.current.playing) return;
    if (live.current.saved) pulseIfAwake('excited', 2000);
    else if (isBusy(l)) pulseIfAwake('curious', Math.min(CURIOUS_MAX_MS, (l.duration / Math.max(0.25, live.current.rate)) * 1000));
  }, [idx, pulseIfAwake]);

  const lastSave = useRef(saveTick);
  useEffect(() => {
    if (lastSave.current === saveTick) return;
    lastSave.current = saveTick;
    pulseIfAwake('excited', 2500);
  }, [saveTick, pulseIfAwake]);

  const onPet = useCallback(() => {
    noteTouch();
    setPetKey((k) => k + 1);
  }, [noteTouch]);

  const cat = hidden ? null : (
    <ListeningCat mode={playing ? 'listening' : 'idle'} emotion={sleepy ? 'sleepy' : pulse} petKey={petKey} onPet={onPet} />
  );
  return { cat, noteTouch };
}

type ViewProps = {
  mode: KagenekoMode;
  emotion: KagenekoEmotion;
  petKey: number;
  onPet: () => void;
};

/** Rive only: on web and in Expo Go this renders nothing. Mounted inside the dock slot. */
function ListeningCat({ mode, emotion, petKey, onPet }: ViewProps) {
  const { rtl } = useDir();
  const { width } = useWindowDimensions();
  const { progress, catalog } = useProgressCache();
  const equipped = useMemo<Equipped>(() => {
    const base: Equipped = progress && catalog ? { ...equippedArt(progress, catalog) } : {};
    if (HEADPHONES === undefined) return base;
    // A hat under headphones reads wrong, so the head slot is the headphones while the cat is here.
    const phones: ArtSpec = { shape: 'headphones', color: '#2B2733', accent: tide.lang.ja, image: HEADPHONES };
    return { ...base, head: phones };
  }, [progress, catalog]);
  return (
    // A screen-wide, centred row: the dock slot is as wide as its content, so the inset is measured from the screen.
    <Animated.View
      entering={FadeIn.duration(160)}
      pointerEvents="box-none"
      style={[styles.row, { width, marginLeft: -width / 2, paddingHorizontal: CAT_INSET, justifyContent: rtl ? 'flex-start' : 'flex-end' }]}>
      <Pressable accessibilityRole="button" onPress={onPet}>
        <View>
          <CatAvatar riveOnly size={CAT_SIZE} equipped={equipped} mode={mode} emotion={emotion} petKey={petKey} frameRate={24} />
        </View>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  row: { position: 'absolute', left: '50%', bottom: CAT_BOTTOM, flexDirection: 'row' },
});
