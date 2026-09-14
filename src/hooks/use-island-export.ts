import * as Sharing from 'expo-sharing';
import { useEffect, useRef, useState } from 'react';

import * as api from '@/lib/api';

type Params = {
  islandId: string;
  title: string;
  speed: number;
  gapMs: number;
  onError: (message: string) => void;
};

// Each line twice, breath in between. The server accepts 1 to 4.
const EXPORT_REPEATS = 2;

const UNSAFE_CHARS = /[\\/:*?"<>|\x00-\x1f]/g;
const WHITESPACE = /\s+/g;

/** Mirrors the backend's `file_name` so the client and the server agree on
 * what the shared file is called. */
export function exportFileName(title: string, speed: number): string {
  let safe = title.replace(UNSAFE_CHARS, ' ').replace(WHITESPACE, ' ').trim();
  safe = safe.slice(0, 60).trim();
  if (!safe) safe = 'Island';
  return `${safe} ${speed.toFixed(2)}x.m4a`;
}

const SHARING_UNAVAILABLE = 'Sharing is not available on this device';
const GENERIC_ERROR = 'Could not export this island. Try again.';

/** The native download error carries only the HTTP status, worded per
 * platform ("response has status: 409" on Android, "response has status 409"
 * or "server returned HTTP 409" on iOS). Returns null when there is none. */
export function statusFromError(message: string): number | null {
  const match = /(?:status|HTTP)\s*:?\s*(\d{3})\b/i.exec(message);
  return match ? Number(match[1]) : null;
}

export function exportErrorText(e: unknown): string {
  const message = e instanceof Error ? e.message : '';
  if (message === SHARING_UNAVAILABLE) return message;
  switch (statusFromError(message)) {
    case 409:
      return 'This island is still being built, or a line has no audio yet.';
    case 502:
      return 'The voice engine is unavailable right now.';
    default:
      return GENERIC_ERROR;
  }
}

/**
 * Downloads the island as one m4a and hands it to the phone's share sheet,
 * so it can be saved to Files, Drive or a player app for listening outside
 * the app. Errors go through `onError` (the screen's own banner) instead of
 * an inline line, since the Island menu sheet has no room for one.
 */
export function useIslandExport({ islandId, title, speed, gapMs, onError }: Params) {
  const [working, setWorking] = useState(false);
  // A ref, not the state: two taps in the same frame both see working false.
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function exportNow() {
    if (busy.current) return;
    busy.current = true;
    setWorking(true);
    try {
      if (!(await Sharing.isAvailableAsync())) {
        throw new Error(SHARING_UNAVAILABLE);
      }
      const fileName = exportFileName(title, speed);
      const file = await api.exportIsland(islandId, speed, gapMs, EXPORT_REPEATS, fileName);
      // The user left the screen mid-download: no share sheet over another view.
      if (!mounted.current) return;
      await Sharing.shareAsync(file.uri, {
        mimeType: 'audio/mp4',
        UTI: 'public.mpeg-4-audio',
        dialogTitle: title || 'Island',
      });
    } catch (e) {
      if (mounted.current) onError(exportErrorText(e));
    } finally {
      busy.current = false;
      if (mounted.current) setWorking(false);
    }
  }

  return { exportNow, working };
}
