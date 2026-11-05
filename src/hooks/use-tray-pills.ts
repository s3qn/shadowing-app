import { createElement, useCallback, useMemo, type Dispatch, type SetStateAction } from 'react';

import { DOCK_GOLD_INK, type DockPill } from '@/components/tide/compact-dock';
import { blindValueLabel } from '@/components/tide/blind-popover';
import { READING_LABEL_KEY } from '@/components/tide/reading-popover';
import { repeatTileLabel } from '@/components/tide/repeat-popover';
import { BlindIcon, ReadingIcon, RepeatIcon } from '@/components/tide/toolbar-icons';
import { tide } from '@/constants/theme';
import type { TFn } from '@/lib/i18n';
import type { ReadingMode } from '@/lib/settings';

type SetBool = Dispatch<SetStateAction<boolean>>;

export type TrayPillsParams = {
  t: TFn;
  /** Target language of the island; reading pill only exists for 'ja'. */
  language: string;
  native: string;
  readingMode: ReadingMode;
  blind: boolean;
  englishShown: boolean;
  readingPopOpen: boolean;
  blindPopOpen: boolean;
  repeatPopOpen: boolean;
  setSpeedPopOpen: SetBool;
  setRepeatPopOpen: SetBool;
  setReadingPopOpen: SetBool;
  setBlindPopOpen: SetBool;
  /** Pass to show the Repeat pill (video and island). Podcast omits it. */
  repeat?: { times: number; pauseMs: number };
  /** Pills appended after Blind (video's Catch pill). Memoize in the caller. */
  extraPills?: DockPill[];
};

/**
 * The dock's settings tray pills (Repeat, Reading, Blind) and the speed chip
 * handler, shared by the video, podcast and island players. Opening one popover
 * closes the others and never touches playback.
 */
export function useTrayPills(p: TrayPillsParams) {
  const {
    t, language, native, readingMode, blind, englishShown, readingPopOpen, blindPopOpen, repeatPopOpen,
    setSpeedPopOpen, setRepeatPopOpen, setReadingPopOpen, setBlindPopOpen, repeat, extraPills,
  } = p;
  const times = repeat?.times;
  const pauseMs = repeat?.pauseMs;
  const hasRepeat = !!repeat;

  const trayPills = useMemo((): DockPill[] => {
    const ink = (on: boolean) => (on ? DOCK_GOLD_INK : tide.textDim);
    const readingOn = readingMode !== 'off';
    const blindOn = blind || !englishShown;
    const open = (which: 'repeat' | 'reading' | 'blind') => () => {
      setSpeedPopOpen(false);
      setRepeatPopOpen(which === 'repeat' ? (v) => !v : false);
      setReadingPopOpen(which === 'reading' ? (v) => !v : false);
      setBlindPopOpen(which === 'blind' ? (v) => !v : false);
    };
    const pills: DockPill[] = [];
    if (hasRepeat) {
      const repeatOn = (times ?? 1) > 1 || (pauseMs ?? 0) > 0;
      pills.push({
        key: 'repeat',
        icon: createElement(RepeatIcon, { color: ink(repeatOn), size: 15 }),
        value: repeatTileLabel(t, times ?? 1, pauseMs ?? 0),
        on: repeatOn,
        selected: repeatPopOpen,
        onPress: open('repeat'),
      });
    }
    // Reading modes (furigana, kana, romaji) only exist for Japanese.
    if (language === 'ja') {
      pills.push({
        key: 'reading',
        icon: createElement(ReadingIcon, { color: ink(readingOn), size: 15 }),
        value: t(READING_LABEL_KEY[readingMode]),
        on: readingOn,
        selected: readingPopOpen,
        onPress: open('reading'),
      });
    }
    pills.push({
      key: 'blind',
      icon: createElement(BlindIcon, { color: ink(blindOn), size: 15 }),
      value: blindValueLabel(t, blind, englishShown, language, native),
      on: blindOn,
      selected: blindPopOpen,
      onPress: open('blind'),
    });
    if (extraPills) pills.push(...extraPills);
    return pills;
  }, [t, language, native, readingMode, blind, englishShown, readingPopOpen, blindPopOpen, repeatPopOpen, hasRepeat, times, pauseMs, extraPills, setSpeedPopOpen, setRepeatPopOpen, setReadingPopOpen, setBlindPopOpen]);

  const onSpeedChip = useCallback(() => {
    setRepeatPopOpen(false);
    setReadingPopOpen(false);
    setBlindPopOpen(false);
    setSpeedPopOpen((v) => !v);
  }, [setRepeatPopOpen, setReadingPopOpen, setBlindPopOpen, setSpeedPopOpen]);

  return { trayPills, onSpeedChip };
}
