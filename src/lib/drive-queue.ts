import type { IslandSummary } from '@/lib/api';
import { toIslandLanguage, type LearningLanguage } from '@/lib/settings';

/** The silent gap after a line is this many times the line's own duration. */
export const DRIVE_GAP_FACTOR = 1.2;
/** Shortest and longest gap the backend is asked to append (its pad cap is 20 s). */
export const DRIVE_PAD_MIN_MS = 1500;
export const DRIVE_PAD_MAX_MS = 20000;

/** Where the radio is: an index into the queue and a line index in that island. */
export type DrivePos = { island: number; line: number };

/**
 * The islands Drive plays: ready, with audio (a captions-only island has none),
 * in the learning language unless all languages are shown, newest first (Home's
 * default order). `has_audio` absent means true.
 */
export function driveQueue(islands: IslandSummary[], lang: LearningLanguage, showAll: boolean): IslandSummary[] {
  const want = toIslandLanguage(lang);
  return islands
    .filter((i) => i.status === 'ready' && i.has_audio !== false && i.line_count > 0 && (showAll || i.language === want))
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

/** Silence appended after a line: the line's length at this speed times the gap factor, clamped. */
export function drivePadMs(durationS: number, speed: number): number {
  const ms = Math.round((durationS / speed) * 1000 * DRIVE_GAP_FACTOR);
  return Math.min(DRIVE_PAD_MAX_MS, Math.max(DRIVE_PAD_MIN_MS, ms));
}

/** Start position from route params: island 0 and line 0 when absent or unknown. */
export function startPos(queue: IslandSummary[], id: string | undefined, line: number | undefined): DrivePos {
  const island = Math.max(0, queue.findIndex((i) => i.id === id));
  const count = queue[island]?.line_count ?? 0;
  const l = line !== undefined && Number.isFinite(line) ? Math.floor(line) : 0;
  return { island, line: Math.min(Math.max(0, l), Math.max(0, count - 1)) };
}

/**
 * One line forward or back. Forward past an island's last line starts the next
 * island at line 0 and wraps after the last island. Back from line 0 goes to the
 * previous island's last line, wrapping to the last island. Islands with no
 * lines are skipped; if none has lines the position is returned unchanged.
 */
export function stepLine(pos: DrivePos, dir: 1 | -1, lineCounts: number[]): DrivePos {
  const n = lineCounts.length;
  if (n === 0) return pos;
  const here = lineCounts[pos.island] ?? 0;
  const line = pos.line + dir;
  if (line >= 0 && line < here) return { island: pos.island, line };
  for (let k = 1; k <= n; k++) {
    const island = (((pos.island + dir * k) % n) + n) % n;
    const count = lineCounts[island] ?? 0;
    if (count > 0) return { island, line: dir === 1 ? 0 : count - 1 };
  }
  return pos;
}
