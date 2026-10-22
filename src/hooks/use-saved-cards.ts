import { useCallback, useEffect, useRef, useState } from 'react';

import { randomUUID } from 'expo-crypto';

import * as api from '@/lib/api';
import { autoPlaceOf } from '@/lib/auto-practice';
import { celebrateReview } from '@/lib/progression';
import { resetSessionScores, useSessionScore } from '@/lib/take-scores';

const NO_PICK: number[] = [];

const tagMap = (cards: api.ReviewCard[]) => new Map(cards.filter((c) => c.tag).map((c): [number, string] => [c.idx, c.tag!]));

/**
 * The saved sentences of one island for the track-span players (video, podcast):
 * line idx to card id, the star toggle, and the review set frozen at load.
 */
export function useSavedCards(islandId: string | undefined, id: string, review: boolean, session = false, pickedIdx: number[] = NO_PICK) {
  const [savedCards, setSavedCards] = useState<Map<number, string>>(new Map());
  const [saveError, setSaveError] = useState('');
  // BL-63: the grammar tag of each saved line (line idx to tag), only for AI-picked cards.
  const [tags, setTags] = useState<Map<number, string>>(new Map());
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
      .then((cards) => {
        if (!alive) return;
        setSavedCards(new Map(cards.map((c) => [c.idx, c.id])));
        setTags(tagMap(cards));
      })
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
    setTags(tagMap(cards));
    // A session picks the lines (weakest first) and owns the scores and the XP.
    // A session picks the weakest lines; "shadow the best bits" passes the easiest ones.
    const picked = session ? autoPlaceOf(id)?.idx : pickedIdx.length ? pickedIdx : undefined;
    if (picked) {
      const set = new Set(picked);
      setReviewSet({ idx: set, due: set });
      return;
    }
    resetSessionScores();
    run.current = { id: randomUUID(), start: Date.now(), done: false };
    dueIdx.current = new Set(cards.filter((c) => c.due_on <= today).map((c) => c.idx));
    setReviewSet({ idx: new Set(cards.map((c) => c.idx)), due: dueIdx.current });
  }, [session, id, pickedIdx]);

  /** Cards saved in bulk (the AI picks): the stars fill in and the tags show. */
  const addCards = useCallback((cards: api.ReviewCard[]) => {
    setSavedCards((m) => new Map([...m, ...cards.map((c): [number, string] => [c.idx, c.id])]));
    setTags((m) => new Map([...m, ...tagMap(cards)]));
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

  /** A finished shadow take saves its line, once per line, never unsaves, errors stay quiet. */
  const autoTried = useRef(new Set<number>());
  const autoSave = useCallback(
    (idx: number) => {
      if (autoTried.current.has(idx) || cardsRef.current.has(idx)) return;
      autoTried.current.add(idx);
      setSavedCards((m) => new Map(m).set(idx, 'pending'));
      api
        .saveReviewCard(id, idx)
        .then((c) => setSavedCards((m) => new Map(m).set(idx, c.id)))
        .catch(() =>
          setSavedCards((m) => {
            const next = new Map(m);
            if (next.get(idx) === 'pending') next.delete(idx);
            return next;
          }),
        );
    },
    [id],
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

  return { savedCards, tags, addCards, saveError, reviewSet, loadReviewCards, toggleSaved, autoSave, gradeOnce };
}
