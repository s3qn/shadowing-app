import type { useDockPopovers } from '@/hooks/use-dock-popovers';

import { BlindPopover } from './blind-popover';
import { ReadingPopover } from './reading-popover';
import { RepeatPopover } from './repeat-popover';
import { SpeedPopover } from './speed-popover';

type Dock = ReturnType<typeof useDockPopovers>;

type Props = {
  dock: Dock;
  /** Player width the popovers clamp to. */
  width: number;
  language: string;
  native: string;
  speed: number;
  onSpeed: (v: number) => void;
  onSpeedSettle: (v: number) => void;
  /** Pass to enable the Repeat popover (video and island). Podcast omits it. */
  repeat?: {
    times: number;
    pauseMs: number;
    onTimes: (v: number) => void;
    onPause: (v: number) => void;
    onPauseSettle: (v: number) => void;
  };
};

/**
 * The dock's four popovers (speed, reading, blind, repeat), each anchored over
 * its tile. Shared by the video, podcast and island players.
 */
export function DockPopovers({ dock, width, language, native, speed, onSpeed, onSpeedSettle, repeat }: Props) {
  const { anchors, dockY } = dock;
  const a = anchors.current;
  return (
    <>
      {dock.speedPopOpen && a.speed ? (
        <SpeedPopover
          anchorX={a.speed.x + a.speed.width / 2}
          anchorTop={dockY.current + a.speed.y}
          width={width}
          speed={speed}
          onSpeed={onSpeed}
          onSettle={onSpeedSettle}
          onClose={() => dock.setSpeedPopOpen(false)}
        />
      ) : null}
      {dock.readingPopOpen && a.reading ? (
        <ReadingPopover
          anchorX={a.reading.x + a.reading.width / 2}
          anchorTop={dockY.current + a.reading.y}
          width={width}
          value={dock.readingMode}
          onChange={dock.pickReading}
          onClose={() => dock.setReadingPopOpen(false)}
        />
      ) : null}
      {dock.blindPopOpen && a.blind ? (
        <BlindPopover
          anchorX={a.blind.x + a.blind.width / 2}
          anchorTop={dockY.current + a.blind.y}
          width={width}
          jaHidden={dock.blind}
          enHidden={!dock.englishShown}
          onToggleJa={dock.toggleBlind}
          onToggleEn={dock.toggleEnglish}
          onClose={() => dock.setBlindPopOpen(false)}
          lang={language}
          native={native}
        />
      ) : null}
      {repeat && dock.repeatPopOpen && a.repeat ? (
        <RepeatPopover
          anchorX={a.repeat.x + a.repeat.width / 2}
          anchorTop={dockY.current + a.repeat.y}
          width={width}
          times={repeat.times}
          pauseMs={repeat.pauseMs}
          onTimes={repeat.onTimes}
          onPause={repeat.onPause}
          onPauseSettle={repeat.onPauseSettle}
          onClose={() => dock.setRepeatPopOpen(false)}
        />
      ) : null}
    </>
  );
}
