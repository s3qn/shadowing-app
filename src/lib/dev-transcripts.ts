/**
 * Dev transcript review state: which video's candidates the open player shows,
 * which label is selected, and the tag counter. A module store (the player and
 * the bar read it with useTranscriptStore). Everything is a no-op outside __DEV__.
 */

import { useSyncExternalStore } from 'react';

import {
  getTranscriptVideo,
  postTranscriptTag,
  postTranscriptUndo,
  type Line,
  type TranscriptCandidate,
  type TranscriptTagBody,
} from '@/lib/api';

type State = {
  active: boolean;
  session: string;
  video: string;
  label: string;
  candidates: TranscriptCandidate[];
  counter: number;
  undoStack: string[];
  /** Set by the transcripts-end simulation: the open player jumps near the end, then clears it. */
  endPending: boolean;
};

const EMPTY: State = { active: false, session: '', video: '', label: '', candidates: [], counter: 0, undoStack: [], endPending: false };
let state: State = EMPTY;
const subs = new Set<() => void>();
function set(next: Partial<State>): void {
  state = { ...state, ...next };
  subs.forEach((f) => f());
}

// Simulation flags, cleared by resetTranscriptSim.
let simNoWords = false;
let simEmpty = false;
let simOffline = false;

export function setTranscriptSim(flag: 'nowords' | 'empty' | 'offline'): void {
  if (!__DEV__) return;
  if (flag === 'nowords') {
    simNoWords = true;
    set({});
  }
  if (flag === 'empty') simEmpty = true;
  if (flag === 'offline') simOffline = true;
}
export function resetTranscriptSim(): void {
  simNoWords = false;
  simEmpty = false;
  simOffline = false;
}
export const transcriptListEmpty = (): boolean => __DEV__ && simEmpty;
export function requestTranscriptEnd(): void {
  if (__DEV__) set({ endPending: true });
}

export function useTranscriptStore(): State {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => state,
  );
}

/** Whether the selected candidate has word timing (the simulation can force it off). */
export function candidateHasWords(c: TranscriptCandidate | undefined): boolean {
  return !!c && c.has_words && !simNoWords;
}

/** Start reviewing one video: a fresh session so labels reshuffle per visit. */
export async function startTranscripts(video: string): Promise<void> {
  if (!__DEV__) return;
  if (state.active && state.video === video) return;
  const session = `s${Date.now().toString(36)}`;
  set({ ...EMPTY, endPending: state.endPending, active: true, session, video });
  try {
    const candidates = await getTranscriptVideo(video, session);
    set({ candidates, label: candidates[0]?.label ?? '' });
  } catch {
    set({ candidates: [] });
  }
}

export function clearEndPending(): void {
  set({ endPending: false });
}

export function stopTranscripts(): void {
  set({ ...EMPTY, endPending: state.endPending });
}

export function selectCandidate(label: string): void {
  set({ label });
}

/** The selected candidate's lines in the player's Line shape. Word times are
 * made relative to the line start, as the island lines have them. */
export function mapCandidateLines(c: TranscriptCandidate | undefined): Line[] {
  if (!c) return [];
  const words = candidateHasWords(c);
  return c.lines.map((l, i) => ({
    idx: i,
    ja: l.text,
    kana: '',
    romaji: '',
    en: '',
    duration: Math.max(0, l.end - l.start),
    offset: l.start,
    timeline: [],
    words: words && l.words ? l.words.map((w) => ({ text: w.text, start: w.start - l.start, end: w.end - l.start })) : [],
  }));
}

/** Send one tag. False when the server refused (or the offline simulation ate it): the counter stays. */
export async function sendTag(tag: string, at: { playerTime: number; lineIndex: number; lineText: string }): Promise<boolean> {
  if (!__DEV__ || !state.active || !state.label) return false;
  if (simOffline) {
    simOffline = false;
    return false;
  }
  const body: TranscriptTagBody = { session: state.session, video: state.video, label: state.label, tag, ...at };
  if (!(await postTranscriptTag(body))) return false;
  set({ counter: state.counter + 1, undoStack: [...state.undoStack, tag] });
  return true;
}

export async function undoTag(): Promise<boolean> {
  if (!__DEV__ || state.undoStack.length === 0) return false;
  if (!(await postTranscriptUndo(state.session))) return false;
  set({ counter: Math.max(0, state.counter - 1), undoStack: state.undoStack.slice(0, -1) });
  return true;
}
