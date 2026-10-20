import { router, useNavigation } from 'expo-router';
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { BackHandler, type View } from 'react-native';

import { progressNow, type Progress } from '@/lib/progression';
import { type GuideStep, getSettingsSync, setGuideStep as saveStep, subscribeSettings } from '@/lib/settings';

export type { GuideStep };

/** BL-56 first-run guide: which moment it is on (persisted) and where the lit controls are (memory). */
export function getGuideStep(): GuideStep {
  return getSettingsSync().guideStep;
}

export function setGuideStep(step: GuideStep): void {
  if (step === 'done' || step === 'home') easyTaps = 0;
  if (getGuideStep() !== step) void saveStep(step);
}

/** bl58-easy-for-me: Easy taps on the guide's island, memory only. The second one ends the island. Returns the new count. */
let easyTaps = 0;
export function noteGuideEasyTap(): number {
  easyTaps += 1;
  return easyTaps;
}

export function useGuideStep(): GuideStep {
  return useSyncExternalStore(subscribeSettings, getGuideStep);
}

/** A box in window coordinates. */
export type GuideBox = { x: number; y: number; width: number; height: number };
export type GuideKey =
  | 'addFab'
  | 'addPhrases'
  | 'podcastTab'
  | 'settingsTab'
  | 'topicGrid'
  | 'topicFirstTile'
  | 'sizeTray'
  | 'size5'
  | 'practiceNow'
  | 'sizeRetry' // the Retry on Practice's offline error, lit instead of the size tray
  | 'lineCard'
  | 'easyChip' // bl58-easy-for-me
  | 'homeHead' // bl58-easy-for-me: Home's profile, stats and sort tray block, so the cat sits under it
  | 'homeEmpty' // bl58-easy-for-me: Home's "No islands yet" text, so the bubble keeps clear of it
  | 'catBadge' // BL-64: Home's cat card, lit on the cat step
  | 'wardrobeTrophy' // BL-64: the wardrobe header's trophy, lit on the wardrobe step
  | 'wardrobeStage' // BL-64: the wardrobe's level header and Rive cat, see-through
  | 'ranksTop' // BL-64: the ranks spotlight, see-through
  | 'ranksMe'; // BL-64: the viewer's pinned row on the ranks, see-through

let anchors: Partial<Record<GuideKey, GuideBox>> = {};
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export function setGuideAnchor(key: GuideKey, box: GuideBox | null): void {
  const old = anchors[key];
  if (!box && !old) return;
  if (box && old && old.x === box.x && old.y === box.y && old.width === box.width && old.height === box.height) return;
  const next = { ...anchors };
  if (box) next[key] = box;
  else delete next[key];
  anchors = next;
  listeners.forEach((l) => l());
}

export function useGuideAnchors(): Partial<Record<GuideKey, GuideBox>> {
  return useSyncExternalStore(subscribe, () => anchors);
}

/**
 * Registers a control's window box while `active`. Put `ref` and `onLayout` on
 * the control; the box comes from measureInWindow, so it is right inside a Modal.
 */
export function useGuideAnchor(key: GuideKey, active: boolean) {
  const ref = useRef<View>(null);
  const measure = useCallback((done?: (ok: boolean) => void) => {
    if (!active) return;
    const view = ref.current;
    if (!view) return done?.(false);
    view.measureInWindow((x, y, width, height) => {
      const ok = [x, y, width, height].every(Number.isFinite) && width > 0;
      if (ok) setGuideAnchor(key, { x, y, width, height });
      done?.(ok);
    });
  }, [key, active]);
  useEffect(() => {
    if (!active) return;
    // A cold start measures before the screen settles (hidden, mid-transition, or the control not mounted yet): retry until a box lands.
    let id: ReturnType<typeof setTimeout>;
    let tries = 0;
    const attempt = () => {
      measure((ok) => {
        if (!ok && ++tries < 20) id = setTimeout(attempt, 250);
      });
    };
    id = setTimeout(attempt, 60);
    return () => {
      clearTimeout(id);
      setGuideAnchor(key, null);
    };
  }, [key, active, measure]);
  return { ref, onLayout: () => measure() };
}

/**
 * The intro and the guide always begin on Home. At a cold start the stack holds one
 * route: the tabs (another tab switches to Home) or a deep-linked screen (replaced by
 * Home, so nothing sits under it). Anything deeper pops to the tabs first.
 */
export function guideStartHome(onTabs: boolean, pathname: string): void {
  if (pathname === '/') return;
  if (!onTabs && !router.canDismiss()) router.replace('/');
  else router.navigate('/');
}

/** Progress when Practice now was pressed, for the level-up screen's arrow. */
let before: Progress | null = null;
export function getGuideBefore(): Progress | null {
  return before;
}

export function guidePracticeStarted(): void {
  before = progressNow();
  setGuideStep('practice');
}

/** Called when any practice session ends: the guide moves on to the level-up. */
export function guideSessionEnded(): void {
  if (getGuideStep() === 'practice') setGuideStep('levelup');
}

/**
 * While `locked` (the first-run guide after "Let's start") the screen cannot be
 * left: no swipe back, no header back, and the Android back button does nothing.
 */
export function useGuideLock(locked: boolean): void {
  const nav = useNavigation();
  useEffect(() => {
    if (!locked) return;
    nav.setOptions({ gestureEnabled: false, headerBackVisible: false });
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => {
      sub.remove();
      nav.setOptions({ gestureEnabled: true, headerBackVisible: true });
    };
  }, [locked, nav]);
}
