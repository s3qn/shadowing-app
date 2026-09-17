import { type AudioPlayer, type AudioStatus } from 'expo-audio';
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * The line player's status without a render on every native update.
 *
 * expo-audio's `useAudioPlayerStatus` sets state on every update, which is
 * every 50ms while a line plays, and re-renders the whole player screen each
 * time. Here `onStatus` runs for every update with the fresh status, for the
 * work that only moves shared values and refs (the ring, the Auto Echo fill,
 * the line-end crossing). The returned `status` is state, replaced only when
 * `renderKey` reads differently for the new status than for the committed
 * one, so the screen renders when something it draws changes (playing
 * flipping, a countdown second) and not on each position tick.
 *
 * `accept` drops a status before any of that sees it: the screen swaps
 * sources on one player, and a status the old source sent just before the
 * swap can arrive after it.
 *
 * `latest` always holds the newest accepted status, for effects that need the
 * position at the moment they run. Neither resets when the source swaps: both
 * keep the old source's last status until the new source's first update.
 */
export function useLineStatus(
  player: AudioPlayer,
  onStatus: (s: AudioStatus) => void,
  renderKey: (s: AudioStatus) => string,
  accept: (s: AudioStatus) => boolean = () => true,
): { status: AudioStatus; latest: RefObject<AudioStatus> } {
  const [status, setStatus] = useState<AudioStatus>(() => player.currentStatus);
  const latest = useRef<AudioStatus>(status);
  const committed = useRef<AudioStatus>(status);
  // Read through refs, so the listener below is subscribed once per player
  // and still calls this render's handlers.
  const onStatusRef = useRef(onStatus);
  const renderKeyRef = useRef(renderKey);
  const acceptRef = useRef(accept);
  useLayoutEffect(() => {
    onStatusRef.current = onStatus;
    renderKeyRef.current = renderKey;
    acceptRef.current = accept;
  });

  useEffect(() => {
    const sub = player.addListener('playbackStatusUpdate', (s: AudioStatus) => {
      if (!acceptRef.current(s)) return;
      latest.current = s;
      onStatusRef.current(s);
      const key = renderKeyRef.current;
      if (key(s) !== key(committed.current)) {
        committed.current = s;
        setStatus(s);
      }
    });
    return () => sub.remove();
  }, [player]);

  return { status, latest };
}
