import { useCallback, useRef, useState } from 'react';
import type { LayoutChangeEvent } from 'react-native';

import type { DockAnchor, DockAnchorKey } from '@/components/tide/compact-dock';
import type { ExplainSelection } from '@/components/tide/tappable-sentence';
import { getSettingsSync, setBlind as persistBlind, setReading as persistReading, type ReadingMode } from '@/lib/settings';

/**
 * The dock, its popovers and the Explain selection, shared by the video and
 * podcast players: tile anchors, the dock's height and top, which popover is
 * open, and the reading and blind toggles that persist to Settings.
 */
export function useDockPopovers() {
  const [explainOpen, setExplainOpen] = useState(false);
  const [explainSpan, setExplainSpan] = useState<ExplainSelection['span'] | null>(null);
  const [explainMarked, setExplainMarked] = useState<string[]>([]);
  const [explainWhole, setExplainWhole] = useState(false);
  const [readingMode, setReadingMode] = useState<ReadingMode>(() => getSettingsSync().reading);
  const [blind, setBlind] = useState(() => getSettingsSync().blind);
  const [englishShown, setEnglishShown] = useState(() => !getSettingsSync().hideEnglish);
  const [speedPopOpen, setSpeedPopOpen] = useState(false);
  const [repeatPopOpen, setRepeatPopOpen] = useState(false);
  const [readingPopOpen, setReadingPopOpen] = useState(false);
  const [blindPopOpen, setBlindPopOpen] = useState(false);
  const [trayOpen, setTrayOpen] = useState(false);
  const anchors = useRef<Partial<Record<DockAnchorKey, DockAnchor>>>({});
  const dockY = useRef(0);
  // The floating dock's height: the transcript scrolls its last line clear
  // of it. State, set only on a real change.
  const [dockH, setDockH] = useState(0);
  const popOpenRef = useRef(false);
  popOpenRef.current = speedPopOpen || repeatPopOpen || readingPopOpen || blindPopOpen;
  const [, bumpAnchors] = useState(0);
  const anchorMoved = useCallback((moved: boolean) => {
    if (moved && popOpenRef.current) bumpAnchors((n) => n + 1);
  }, []);
  const onAnchor = useCallback(
    (key: DockAnchorKey, box: DockAnchor) => {
      const old = anchors.current[key];
      anchors.current[key] = box;
      anchorMoved(!old || old.x !== box.x || old.y !== box.y || old.width !== box.width);
    },
    [anchorMoved],
  );
  const onDockLayout = (e: LayoutChangeEvent) => {
    const { y, height } = e.nativeEvent.layout;
    anchorMoved(y !== dockY.current);
    dockY.current = y;
    if (Number.isFinite(height) && height > 0) setDockH((old) => (Math.abs(old - height) > 0.5 ? height : old));
  };

  const openExplain = useCallback((sel: ExplainSelection) => {
    setExplainMarked(sel.marked);
    setExplainWhole(sel.whole);
    setExplainSpan(sel.span);
    setExplainOpen(true);
  }, []);
  const pickReading = (mode: ReadingMode) => {
    setReadingMode(mode);
    persistReading(mode).catch(() => {});
  };
  const toggleBlind = () => {
    const next = !blind;
    setBlind(next);
    persistBlind(next).catch(() => {});
  };
  const toggleEnglish = () => setEnglishShown((v) => !v);

  return {
    explainOpen,
    setExplainOpen,
    explainSpan,
    explainMarked,
    explainWhole,
    openExplain,
    readingMode,
    blind,
    englishShown,
    pickReading,
    toggleBlind,
    toggleEnglish,
    speedPopOpen,
    setSpeedPopOpen,
    repeatPopOpen,
    setRepeatPopOpen,
    readingPopOpen,
    setReadingPopOpen,
    blindPopOpen,
    setBlindPopOpen,
    trayOpen,
    setTrayOpen,
    anchors,
    dockY,
    dockH,
    onAnchor,
    onDockLayout,
  };
}
