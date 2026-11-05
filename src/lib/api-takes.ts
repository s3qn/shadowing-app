// Api domain: takes.
import { File } from 'expo-file-system';

import { BASE, expoFetch } from '@/lib/api-http';
import { headers, json } from '@/lib/api-core';
import type { AudioSpan } from '@/lib/api-types';

export type PracticeReply = {
  award?: { xp: number; cap_note?: boolean };
  /** Owner-wide seconds today after the daily max. */
  counted_today_seconds?: number;
  daily_max_seconds?: number;
  /** Lifetime seconds, uncapped. */
  total_seconds?: number;
};

/** Thrown when the server refused a practice post for good (unknown island,
 * bad seconds): the outbox drops it instead of retrying forever. */
export class PracticeRefused extends Error {}

export async function postPracticeEvent(islandId: string, seconds: number, appState: '' | 'active' | 'background' = ''): Promise<PracticeReply> {
  const form = new FormData();
  form.append('island_id', islandId);
  form.append('seconds', String(seconds));
  form.append('app_state', appState);
  const res = await expoFetch(`${BASE}/schedule/practice`, { method: 'POST', headers: headers(), body: form });
  if (res.status === 400 || res.status === 404) throw new PracticeRefused(String(res.status));
  return json<PracticeReply>(res);
}

/** How one word of a scored take lines up against the reference: on time,
 * early, late, dropped out, or not scored (outside a phrase span, or the
 * take could not be scored at all). */
export type WordMark = 'ok' | 'early' | 'late' | 'dropped' | 'none';

/** Timing score for a take, index-aligned with the line's words. `behindMs`
 * is the take's median offset against the reference minus the Lag setting,
 * null when nothing could be scored; `note` explains why when it is empty
 * for none of the words. */
export type TakeScore = {
  words: WordMark[];
  offsetsMs: (number | null)[];
  behindMs: number | null;
  anchor: 'echo' | 'clock' | null;
  note: string;
  /** 0..100 blend of content, timing and pitch; null when unscorable. Absent in score files saved before it existed. */
  total?: number | null;
  parts?: { content: number | null; timing: number | null; pitch: number | null };
  /** What the speech recogniser heard in the take. */
  heard?: string;
  totalNote?: string;
};

/** What makes a mora take longer to say than a plain short one, when known. */
export type MoraKind = 'long' | 'geminate' | 'n' | null;

/** How a mora's length compared to the line: `'ok'`, cut short (`'clipped'`),
 * not said at all (`'none'`), or not judged (`null`). */
export type LengthMark = 'ok' | 'clipped' | 'none' | null;

/** Whether a phrase's pitch fall landed on this mora: `'hit'`, `'miss'`, not
 * said (`'none'`), or not the phrase's nucleus (`null`). */
export type NucleusMark = 'hit' | 'miss' | 'none' | null;

/** One mora of a take's analysis, indexed into the line's `timeline` by `i`.
 * `lineSt`/`takeSt` are mean semitones per mora, centred on that voice's own
 * median, null where unvoiced. */
export type AnalysedMora = {
  i: number;
  text: string | null;
  kind: MoraKind;
  lineMs: number;
  takeMs: number | null;
  length: LengthMark;
  high: boolean | null;
  lineSt: number | null;
  takeSt: number | null;
  nucleus: NucleusMark;
};

/** Length and pitch feedback for a take, per mora inside the take's span. A
 * non-empty `note` ("Take too noisy to analyse", "No voice heard in the
 * take", "Could not follow the take") means every mark is `'none'`. `curve`
 * is deliberately left off this type: the row draws per mora and the stored
 * copy must not carry two 10 ms point lists. */
export type TakeAnalysis = {
  note: string;
  aligned: 'dtw' | 'offset' | null;
  coverage: number;
  moras: AnalysedMora[];
};

/** Result of an echo cancellation pass on an uploaded take, or a calibration recording. */
export type TakeClean = {
  cleaned: boolean;
  erleDb: number | null;
  delayMs: number | null;
  driftSamples: number | null;
  note: string;
  /** Missing on a calibration upload. */
  score?: TakeScore;
  /** Missing on a calibration upload. */
  analysis?: TakeAnalysis;
  /** The XP this take earned; missing on a calibration upload or a failed award. */
  award?: { xp: number };
};

/**
 * Upload a take (or a calibration recording, when `calibrate` is true) and run
 * the echo canceller against the line's reference audio. For a calibration
 * upload this replaces the stored speaker profile instead of cleaning a take.
 * `cleaned` is false when no echo was found (earphones) or no profile exists
 * yet; then there is nothing to fetch from cleanTakeUrl. `span`, when set, is
 * the phrase that was playing while the take was recorded, so the cleaner's
 * reference matches it. `lagMs` is the phone's Lag setting and `lineStartMs`
 * is when the line's first audio played, measured from the start of the
 * recording; both feed the take's timing score and are ignored for a
 * calibration upload. `guide` marks the first-run guide's shadow take.
 * `silent` is a turn-taking take (speaker, no line under the voice): the
 * backend skips the speaker profile and the bleed check and scores it on
 * `lineStartMs` alone.
 */
export async function uploadTake(
  islandId: string,
  idx: number,
  uri: string,
  speed: number,
  calibrate = false,
  span: AudioSpan | null = null,
  lagMs = 0,
  lineStartMs: number | null = null,
  guide = false,
  silent = false,
): Promise<TakeClean> {
  const form = new FormData();
  form.append('take', new File(uri), 'take.wav');
  form.append('speed', speed.toFixed(2));
  form.append('calibrate', calibrate ? '1' : '0');
  if (span) {
    form.append('start', String(Math.round(span.startMs)));
    form.append('end', String(Math.round(span.endMs)));
  }
  form.append('lag', String(Math.round(lagMs)));
  if (lineStartMs !== null) {
    form.append('line_start', String(Math.round(lineStartMs)));
  }
  if (guide) form.append('guide', '1');
  if (silent) form.append('silent', '1');

  return json<TakeClean>(
    await expoFetch(`${BASE}/islands/${islandId}/lines/${idx}/take`, {
      method: 'POST',
      headers: headers(),
      body: form,
    }),
  );
}
