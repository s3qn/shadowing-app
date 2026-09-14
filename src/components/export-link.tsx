import * as Sharing from 'expo-sharing';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';

import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import * as api from '@/lib/api';

type Props = {
  islandId: string;
  title: string;
  speed: number;
  gapMs: number;
  disabled?: boolean;
};

// Each line twice, breath in between. The server accepts 1 to 4.
const EXPORT_REPEATS = 2;

const UNSAFE_CHARS = /[\\/:*?"<>|\x00-\x1f]/g;
const WHITESPACE = /\s+/g;

/** Mirrors the backend's `file_name` so the client and the server agree on
 * what the shared file is called. */
function exportFileName(title: string, speed: number): string {
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
function statusFromError(message: string): number | null {
  const match = /(?:status|HTTP)\s*:?\s*(\d{3})\b/i.exec(message);
  return match ? Number(match[1]) : null;
}

function exportErrorText(e: unknown): string {
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
 * A link that downloads the island as one m4a and hands it to the phone's
 * share sheet, so it can be saved to Files, Drive or a player app for
 * listening outside the app.
 */
export function ExportLink({ islandId, title, speed, gapMs, disabled }: Props) {
  const { palette } = useTheme();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');

  // A ref, not the state: two taps in the same frame both see working false.
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const onPress = async () => {
    if (disabled || busy.current) return;
    busy.current = true;
    setWorking(true);
    setError('');
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
      if (mounted.current) setError(exportErrorText(e));
    } finally {
      busy.current = false;
      if (mounted.current) setWorking(false);
    }
  };

  return (
    <>
      <Pressable onPress={onPress} disabled={disabled || working} style={styles.action}>
        <Text style={[styles.actionText, { color: disabled || working ? palette.muted : palette.accent }]}>
          {working ? 'Exporting…' : 'Export as audio'}
        </Text>
      </Pressable>
      {error ? (
        <Pressable onPress={() => setError('')}>
          <Text style={[styles.inlineError, { color: palette.danger }]}>{error}</Text>
        </Pressable>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  action: { alignItems: 'center', paddingVertical: Spacing.xs },
  actionText: { fontSize: 14, fontWeight: '600' },
  inlineError: { fontSize: 13, lineHeight: 18, textAlign: 'center' },
});
