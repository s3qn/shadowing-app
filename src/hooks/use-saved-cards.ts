import { useCallback, useEffect, useRef, useState } from 'react';

import * as api from '@/lib/api';

/**
 * The saved sentences of one island for the track-span players (video, podcast):
 * line idx to card id, the star toggle, and the review set frozen at load.
 */
export function useSavedCards(islandId: string | undefined, id: string, review: boolean) {
  const [savedCards, setSavedCards] = useState<Map<number, string>>(new Map());
  const [saveError, setSaveError] = useState('');
  // Review mode: only the saved lines, frozen at load, due ones decide the start.
  const [reviewSet, setReviewSet] = useState<{ idx: Set<number>; due: Set<number> } | null>(null);
  // Line idx already graded 'got' this session: a line repeated in the ladder grades once.
  const graded = useRef(new Set<number>());
  const cardsRef = useRef(savedCards);
  cardsRef.current = savedCards;

  useEffect(() => {
    // Review mode loads the cards with the island.
    if (!islandId || review) return;
    let alive = true;
    api
      .listReviewCards(islandId)
      .then((cards) => alive && setSavedCards(new Map(cards.map((c) => [c.idx, c.id]))))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [islandId, review]);

  /** Review mode: the cards fetched with the island become the saved map and the review set. */
  const loadReviewCards = useCallback((cards: api.ReviewCard[]) => {
    const today = new Date().toISOString().slice(0, 10);
    setSavedCards(new Map(cards.map((c) => [c.idx, c.id])));
    setReviewSet({ idx: new Set(cards.map((c) => c.idx)), due: new Set(cards.filter((c) => c.due_on <= today).map((c) => c.idx)) });
  }, []);

  const toggleSaved = useCallback(
    (idx: number) => {
      const existing = savedCards.get(idx);
      if (existing === 'pending') return;
      const setCard = (card: string | null) =>
        setSavedCards((m) => {
          const next = new Map(m);
          if (card) next.set(idx, card);
          else next.delete(idx);
          return next;
        });
      if (existing) {
        setCard('pending');
        api
          .removeReviewCard(existing)
          .then(() => {
            setCard(null);
            setSaveError('');
          })
          .catch((e) => {
            setCard(existing);
            setSaveError(e instanceof Error ? e.message : '');
          });
      } else {
        setCard('pending');
        api
          .saveReviewCard(id, idx)
          .then((c) => {
            setCard(c.id);
            setSaveError('');
          })
          .catch((e) => {
            setCard(null);
            setSaveError(e instanceof Error ? e.message : '');
          });
      }
    },
    [savedCards, id],
  );

  /** Marks the line's card reviewed, once per session. */
  const gradeOnce = useCallback((idx: number) => {
    const card = cardsRef.current.get(idx);
    if (card && card !== 'pending' && !graded.current.has(idx)) {
      graded.current.add(idx);
      api.gradeReviewCard(card, 'got').catch(() => {});
    }
  }, []);

  return { savedCards, saveError, reviewSet, loadReviewCards, toggleSaved, gradeOnce };
}
