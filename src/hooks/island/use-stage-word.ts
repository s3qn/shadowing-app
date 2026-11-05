// focus-stories D8: the island's side of the stage's word tap.
//
// `io` is spread into the island's `LadderIo` and carries `word`
// (`{ islandId, language, native, onHear }`) once `island` is known. `onHear(text)`
// sets `hearText`; the island's `wordSource` memo falls back to it when its own
// TappableSentence has no selected word, and its load-then-play effect plays the
// word. The panel clears it with `onHear('')` when it closes.
import { useCallback, useMemo, useRef, useState } from 'react';

import type { LadderIo } from '@/hooks/ladder/ladder-types';
import { useStableHandler } from '@/hooks/use-stable-handler';
import type { Island } from '@/lib/api';

export type StageWord = {
  io: Pick<LadderIo, 'word'>;
  /** The word the stage panel's Hear asked for, null when none. */
  hearText: string | null;
};

export function useStageWord(island: Island | null, replay?: () => void): StageWord {
  const [hearText, setHearText] = useState<string | null>(null);
  // The word asked for again while it is still the current one: the island's load-then-play
  // effect sees no change, so `replay` (seek to 0 and play) sounds it instead.
  const cur = useRef<string | null>(null);
  const replayWord = useStableHandler(() => replay?.());
  const onHear = useCallback(
    (text: string) => {
      const next = text || null;
      if (next && next === cur.current) {
        replayWord();
        return;
      }
      cur.current = next;
      setHearText(next);
    },
    [replayWord],
  );
  const islandId = island?.id;
  const language = island?.language;
  const native = island?.native;
  const io = useMemo<Pick<LadderIo, 'word'>>(
    () => (islandId && language && native ? { word: { islandId, language, native, onHear } } : {}),
    [islandId, language, native, onHear],
  );
  return { io, hearText };
}
