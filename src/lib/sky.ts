import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { tideSkies } from '@/constants/theme';
import { getSettingsSync, subscribeSettings } from '@/lib/settings';

// Allow testing different times of day without waiting. Set to null to use real time.
export let DEV_TIME_OVERRIDE: number | null = null;

export type Period = keyof typeof tideSkies;

function periodFor(date: Date): Period {
  const hour = DEV_TIME_OVERRIDE ?? date.getHours();
  if (hour >= 5 && hour < 7) return 'morning';
  if (hour >= 7 && hour < 17) return 'day';
  if (hour >= 17 && hour < 19) return 'sunset';
  return 'night';
}

/** Returns gradient stops [top, middle, bottom] for the current or overridden time. */
export function getSkyPalette(date: Date): (typeof tideSkies)[Period] {
  return tideSkies[periodFor(date)];
}

// When the "always night" setting is on, the sky palette ignores the clock
// entirely, so this checks it ahead of the time-of-day lookup.
function currentPalette(date: Date): (typeof tideSkies)[Period] {
  return getSettingsSync().skyAlwaysNight ? tideSkies.night : getSkyPalette(date);
}

/** The current (or overridden) time-of-day period, honouring the "always
 * night" setting the same way `currentPalette` does. Used to pick the
 * Tide player's water palette. */
export function currentPeriod(date: Date): Period {
  return getSettingsSync().skyAlwaysNight ? 'night' : periodFor(date);
}

/** Checks if the current time is night (19–5). */
export function isNight(date: Date): boolean {
  const hour = DEV_TIME_OVERRIDE ?? date.getHours();
  return hour >= 19 || hour < 5;
}

function gradientStyle(palette: (typeof tideSkies)[Period]) {
  const [top, middle, bottom] = palette;
  return { experimental_backgroundImage: `linear-gradient(180deg, ${top}, ${middle} 60%, ${bottom})` };
}

const CROSSFADE_MS = 1500;

/**
 * Hook that tracks the sky palette for the current time of day, re-evaluating
 * every 5 minutes so the app transitions between periods without a restart.
 *
 * Returns `top` (the current period's top stop, for headers and any flat
 * background that can't crossfade) plus `from`/`to`/`fadeStyle`: two gradient
 * layers and an animated opacity for the top one. Render both layers
 * stacked, in that order, so a period change crossfades instead of jumping:
 *
 * ```tsx
 * <View style={[StyleSheet.absoluteFill, sky.from]} />
 * <Animated.View style={[StyleSheet.absoluteFill, sky.to, sky.fadeStyle]} />
 * ```
 */
export function useSkyStyle() {
  const [palette, setPalette] = useState(() => currentPalette(new Date()));
  const prevPalette = useRef(palette);
  const [layers, setLayers] = useState({ from: palette, to: palette });
  const fade = useSharedValue(1);

  useEffect(() => {
    setPalette(currentPalette(new Date()));
    const interval = setInterval(() => {
      setPalette(currentPalette(new Date()));
    }, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  // "Always night sky" (and, incidentally, the clock) should apply the
  // moment it changes, not wait for the next 5-minute poll: re-evaluate
  // whenever a setting is saved anywhere in the app.
  useEffect(() => subscribeSettings(() => setPalette(currentPalette(new Date()))), []);

  // Also catch up on focus: a screen left mounted in the background (a
  // stack underneath a modal, a tab that stays alive) can otherwise sit on
  // a stale palette until its own poll happens to land.
  useFocusEffect(
    useCallback(() => {
      setPalette(currentPalette(new Date()));
    }, []),
  );

  useEffect(() => {
    if (palette === prevPalette.current) return;
    setLayers({ from: prevPalette.current, to: palette });
    prevPalette.current = palette;
    fade.value = 0;
    fade.value = withTiming(1, { duration: CROSSFADE_MS });
  }, [palette, fade]);

  const fadeStyle = useAnimatedStyle(() => ({ opacity: fade.value }));

  return {
    top: palette[0],
    from: gradientStyle(layers.from),
    to: gradientStyle(layers.to),
    fadeStyle,
  };
}
