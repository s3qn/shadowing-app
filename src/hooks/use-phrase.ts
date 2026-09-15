import { useState } from 'react';

import type { AudioSpan, Line } from '@/lib/api';

/** A run of a line's words, by index, inclusive at both ends. */
export type PhraseSpan = { from: number; to: number };

// A phrase shorter than this is refused: the player's status arrives every
// 50ms, so a slice this short could end before the line's end is ever seen.
export const MIN_PHRASE_MS = 250;

/**
 * Milliseconds of the render at `speed` covered by `span`, or null when the
 * span is empty or shorter than MIN_PHRASE_MS.
 */
export function spanToAudio(line: Line, span: PhraseSpan, speed: number): AudioSpan | null {
  const { words } = line;
  if (span.from < 0 || span.to >= words.length || span.from > span.to) return null;
  const startMs = span.from === 0 ? 0 : Math.round((words[span.from].start / speed) * 1000);
  const endMs =
    span.to === words.length - 1
      ? Math.round((line.duration / speed) * 1000)
      : Math.round((words[span.to].end / speed) * 1000);
  if (endMs - startMs < MIN_PHRASE_MS) return null;
  return { startMs, endMs };
}

/**
 * A phrase is a run of words of one line, kept as word indices so it survives
 * a speed or pause change. It is keyed on the line (generation plus idx) so a
 * line switch or a regenerate hides it in the same render, and it is cleared
 * in that render too, so it does not come back when the user returns to the line.
 * The player loads the phrase as its own shorter audio; see the plan.
 */
export function usePhrase(lineKey: string, line: Line | undefined, speed: number) {
  const [saved, setSaved] = useState<{ key: string; span: PhraseSpan } | null>(null);
  // Adjusting state while rendering, the pattern React documents for resetting
  // state on a prop change: no effect, no render with the old phrase.
  if (saved && saved.key !== lineKey) setSaved(null);

  const span = saved && saved.key === lineKey ? saved.span : null;
  const audio = line && span ? spanToAudio(line, span, speed) : null;
  const offsetSec = audio ? audio.startMs / 1000 : 0;
  const label =
    line && span
      ? span.from === span.to
        ? line.words[span.from].text
        : `${line.words[span.from].text} 〜 ${line.words[span.to].text}`
      : null;

  function set(next: PhraseSpan): 'set' | 'same' | 'invalid' {
    if (span && span.from === next.from && span.to === next.to) return 'same';
    if (!line || spanToAudio(line, next, speed) === null) return 'invalid';
    setSaved({ key: lineKey, span: next });
    return 'set';
  }

  function clear() {
    setSaved(null);
  }

  return { span, audio, offsetSec, label, set, clear };
}
