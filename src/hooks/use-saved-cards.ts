import { useCallback, useEffect, useRef, useState } from 'react';

import { randomUUID } from 'expo-crypto';

import * as api from '@/lib/api';
import { autoPlaceOf } from '@/lib/auto-practice';
import { celebrateReview } from '@/lib/progression';
import { resetSessionScores, useSessionScore } from '@/lib/take-scores';

/**
 * The saved sentences of one island for the track-span players (video, podcast):
 * line idx to card id, the star toggle, and the review set frozen at load.
 */
export function useSavedCards(islandId: string | undefined, id: string, review: boolean, session = false) {
  const [savedCards, setSavedCards] = useState<Map<number, string>>(new Map());
  const [saveError, setSaveError] = useState('');
  // Review mode: only the saved lines, frozen at load, due ones decide the start.
  const [reviewSet, setReviewSet] = useState<{ idx: Set<number>; due: Set<number> } | null>(null);
  // Line idx already graded 'got' this session: a line repeated in the ladder grades once.
  const graded = useRef(new Set<number>());
  // BL-51 xp: one run per load; paid once when every due line has been graded.
  const run = useRef({ id: randomUUID(), start: 0, done: false });
  const dueIdx = useRef(new Set<number>());
  const { average } = useSessionScore();
  const averageRef = useRef(average);
  averageRef.current = average;
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
    // The device's local day, the same one finishReviewSession sends as local_day.
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    setSavedCards(new Map(cards.map((c) => [c.idx, c.id])));
    // A session picks the lines (weakest first) and owns the scores and the XP.
    const picked = session ? autoPlaceOf(id)?.idx : undefined;
    if (picked) {
      const set = new Set(picked);
      setReviewSet({ idx: set, due: set });
      return;
    }
    resetSessionScores();
    run.current = { id: randomUUID(), start: Date.now(), done: false };
    dueIdx.current = new Set(cards.filter((c) => c.due_on <= today).map((c) => c.idx));
    setReviewSet({ idx: new Set(cards.map((c) => c.idx)), due: dueIdx.current });
  }, [session, id]);

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
      const r = run.current;
      const dueDone = [...dueIdx.current].filter((i) => graded.current.has(i)).length;
      if (!session && !r.done && dueIdx.current.size > 0 && dueDone >= dueIdx.current.size) {
        r.done = true;
        const avg = averageRef.current;
        api
          .finishReviewSession({ session_id: r.id, sentences: dueDone, seconds: (Date.now() - r.start) / 1000, ...(avg === null ? {} : { avg_score: avg }) })
          .then((res) => celebrateReview(res, dueDone, avg, null))
          .catch(() => {});
      }
    }
  }, [session]);

  return { savedCards, saveError, reviewSet, loadReviewCards, toggleSaved, gradeOnce };
}
