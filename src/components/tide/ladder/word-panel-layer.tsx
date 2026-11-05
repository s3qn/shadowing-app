// focus-stories D8: the word panel over the stage body, mounted last inside the body.
// `wordAt` is the tapped word's index or null, `hitRef.current.boxAt(wordAt)` that word's
// box in body coordinates (Sentence fills the ref). The panel sits under the word,
// clamped 16pt from the body's edges. A tap elsewhere reaches the body gesture, which
// calls `onWord(null)`; the panel's Close calls `onClose`.
import { useEffect, useState, type RefObject } from 'react';
import { StyleSheet, View } from 'react-native';

import { POPOVER_WIDTH, WordPanel } from '@/components/word-panel';
import type { LadderStageProps, SentenceHit, WordBox } from '@/hooks/ladder/ladder-types';
import { useWordGloss } from '@/hooks/use-word-gloss';
import { getSettingsSync } from '@/lib/settings';

export type WordPanelLayerProps = {
  p: LadderStageProps;
  wordAt: number | null;
  hitRef: RefObject<SentenceHit | null>;
  onClose: () => void;
  bodyW: number;
  bodyH: number;
  /** Height of the chips and hint band at the body's bottom, which the panel must stay above. */
  clearBottom: number;
};

const EDGE = 16;
/** Room the panel needs under a word; above that it flips over the word. */
const PANEL_H = 190;

export function WordPanelLayer({ p, wordAt, hitRef, onClose, bodyW, bodyH, clearBottom }: WordPanelLayerProps) {
  const w = p.word;
  const g = useWordGloss({ line: p.line ?? null, language: w?.language ?? 'ja', native: w?.native ?? 'en', islandId: w?.islandId ?? '' });
  const { tap, close } = g;
  const onHear = w?.onHear;
  // Follow the composer: a new index loads that word, null clears it.
  useEffect(() => {
    if (!w) return;
    if (wordAt === null) {
      close();
      onHear?.('');
    } else void tap(wordAt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wordAt, w?.islandId]);
  useEffect(() => () => onHear?.(''), [onHear]);

  // The word's box is read once the gloss selects it, after Sentence's layouts have landed.
  const [box, setBox] = useState<WordBox | null>(null);
  const [panelH, setPanelH] = useState(PANEL_H);
  const sel = g.selected;
  useEffect(() => {
    setBox(sel === null ? null : (hitRef.current?.boxAt(sel) ?? null));
  }, [sel, hitRef]);

  if (!w || wordAt === null || sel === null) return null;
  const word = p.line?.words[sel]?.text;
  if (!word || !box) return null;
  const left = Math.max(EDGE, Math.min(box.x + box.w / 2 - POPOVER_WIDTH / 2, bodyW - POPOVER_WIDTH - EDGE));
  // Keep the whole measured panel above the chips and hint band: under the word, else over it, else pinned to the band's top edge.
  const limit = bodyH - clearBottom;
  const below = box.y + box.h + 8;
  const above = box.y - panelH - 8;
  const top = below + panelH <= limit ? below : above >= EDGE ? above : Math.max(EDGE, limit - panelH);
  const hear = onHear ? () => onHear(word) : undefined;
  const closeAll = () => {
    close();
    onHear?.('');
    onClose();
  };
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <WordPanel
        word={word}
        gloss={g.gloss}
        context={g.context}
        left={left}
        top={top}
        romaji={getSettingsSync().reading === 'romaji'}
        dictionary={w.language === 'ja'}
        onHear={hear}
        onClose={closeAll}
        onHeight={setPanelH}
      />
    </View>
  );
}
