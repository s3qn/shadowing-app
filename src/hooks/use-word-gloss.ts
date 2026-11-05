// focus-stories D8: one word's gloss and explanation, shared by TappableSentence
// (the video and podcast players) and the ladder stage's word panel.
//
// `tap(i)` selects word `i` of `line`, calls `onInteract`, reads the gloss
// (`offlineGloss(islandId, word) ?? api.gloss(word)` for Japanese, a `found: false`
// gloss otherwise or on failure) and then `api.explainWord(word, line.ja, line.en,
// language, native)` into `context` (null on failure); a stale request never lands
// (`wordRequestId`). `close()` clears all three and bumps the request id.
// `context` is undefined while loading, null when there is none.
import { useRef, useState } from 'react';

import * as api from '@/lib/api';
import type { Gloss, Language, Line, NativeLanguage } from '@/lib/api';
import { offlineGloss } from '@/lib/offline-islands';

export type WordGlossOptions = {
  line: Line | null;
  language: Language;
  native: NativeLanguage;
  islandId: string;
  /** Called on every word tap (TappableSentence's `onInteract`). */
  onInteract?: () => void;
};

export type WordGloss = {
  selected: number | null;
  gloss: Gloss | null;
  context: string | null | undefined;
  tap: (i: number) => Promise<void>;
  close: () => void;
};

export function useWordGloss({ line, language, native, islandId, onInteract }: WordGlossOptions): WordGloss {
  const [selected, setSelected] = useState<number | null>(null);
  const [gloss, setGloss] = useState<Gloss | null>(null);
  const [context, setContext] = useState<string | null | undefined>(undefined);
  const wordRequestId = useRef(0);

  function close() {
    setSelected(null);
    setGloss(null);
    setContext(undefined);
    wordRequestId.current++;
  }

  async function tap(i: number) {
    if (!line) return;
    const w = line.words[i];
    if (!w) return;
    onInteract?.();
    setSelected(i);
    setGloss(null);
    setContext(undefined);
    const requestId = ++wordRequestId.current;
    const word = w.text;
    if (language === 'ja') {
      try {
        const g = offlineGloss(islandId, word) ?? (await api.gloss(word));
        if (wordRequestId.current === requestId) setGloss(g);
      } catch {
        if (wordRequestId.current === requestId) {
          setGloss({ word, base: '', reading: '', entries: [], found: false });
        }
      }
    } else {
      setGloss({ word, base: '', reading: '', entries: [], found: false });
    }
    try {
      const ctx = await api.explainWord(word, line.ja, line.en, language, native);
      if (wordRequestId.current === requestId) setContext(ctx || null);
    } catch {
      if (wordRequestId.current === requestId) setContext(null);
    }
  }

  return { selected, gloss, context, tap, close };
}
