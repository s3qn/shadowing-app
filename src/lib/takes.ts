/**
 * Where shadow takes live on disk. A take is the learner's own recording of a
 * line, kept on the phone under document storage: one file per line, newest
 * wins. Takes are wav (`<idx>-<ms>.wav`) and may have a cleaned sibling
 * (`<idx>-<ms>.clean.wav`) once the backend has removed the played line from
 * the recording, and a score sibling (`<idx>-<ms>.score.json`) with the
 * per-word timing marks, plus an analysis sibling (`<idx>-<ms>.analysis.json`)
 * with the per-mora length and pitch marks. Older takes recorded before this
 * change are `.m4a`; they still play, just never have a cleaned counterpart,
 * a score or an analysis.
 */

import { Directory, File, Paths } from 'expo-file-system';

import type { TakeAnalysis, TakeScore } from '@/lib/api';

export type Take = {
  uri: string;
  recordedAt: number;
  cleanUri: string | null;
  score: TakeScore | null;
  analysis: TakeAnalysis | null;
};

/** How a finished Auto Echo take is celebrated at the end of the Play step. */
export type ResultTier = 'great' | 'good' | 'retry';

/**
 * Tier from a score's ok-word ratio alone (`'none'` words are outside the
 * phrase span or unscoreable and excluded). `null` when the score has no
 * scoreable words, meaning the caller must fall back to something else.
 * Shared by `resultTier` and `lineTiers` so their ratio thresholds cannot
 * drift apart.
 */
function scoredTier(score: TakeScore | null): ResultTier | null {
  const scored = score?.words.filter((w) => w !== 'none') ?? [];
  if (scored.length === 0) return null;
  const okRatio = scored.filter((w) => w === 'ok').length / scored.length;
  if (okRatio >= 0.8) return 'great';
  if (okRatio >= 0.5) return 'good';
  return 'retry';
}

/**
 * How many of a take's scoreable words were kept up with (`ok` marks only;
 * `early`/`late`/`dropped` do not count). `none` words are excluded from
 * both `kept` and `total`, the same filtering `scoredTier` uses, so the two
 * never disagree about which words count. `null` when there is nothing
 * scoreable to count.
 */
export function wordsKeptUp(score: TakeScore | null): { kept: number; total: number } | null {
  const scored = score?.words.filter((w) => w !== 'none') ?? [];
  if (scored.length === 0) return null;
  return { kept: scored.filter((w) => w === 'ok').length, total: scored.length };
}

/**
 * Judge one Play-step take: scored (Speak played the line under the voice)
 * uses `scoredTier`. Silent (no score possible) falls back to how closely
 * `takeDuration` matches the line's own duration, a cheap on-device proxy,
 * not a scored fact. A score with zero scoreable words is treated as
 * unscored.
 */
export function resultTier(score: TakeScore | null, takeDuration: number, lineEnd: number): ResultTier {
  const tier = scoredTier(score);
  if (tier) return tier;
  if (lineEnd > 0 && takeDuration > 0) {
    const ratio = takeDuration / lineEnd;
    if (ratio >= 0.85 && ratio <= 1.15) return 'great';
    if (ratio >= 0.6 && ratio <= 1.4) return 'good';
    return 'retry';
  }
  return 'retry';
}

/** A line's celebration tier for the lantern wheel, or `'none'` untaken. */
export type LineTier = ResultTier | 'none';

const TIER_ORDER: LineTier[] = ['none', 'retry', 'good', 'great'];

/**
 * Tier for every line of an island, read from the newest base take per
 * index. A line with no take is `'none'`. A take with a scoreable score
 * uses `scoredTier`; a take without one (or with zero scoreable words) is
 * practiced but unscored, so it counts as `'good'` (the take's duration is
 * not kept here, so the duration fallback in `resultTier` cannot run).
 * Always returns exactly `lineCount` entries; an index past the last file
 * is `'none'`. Reads the folder once; never throws.
 */
export function lineTiers(islandId: string, lineCount: number): LineTier[] {
  const tiers: LineTier[] = new Array(lineCount).fill('none');
  try {
    const dir = takeDir(islandId);
    if (!dir.exists) return tiers;
    const newestByIdx = new Map<number, { ms: string; recordedAt: number }>();
    const scoreByKey = new Map<string, TakeScore>();
    for (const entry of dir.list()) {
      const name = entry.name;
      const dash = name.indexOf('-');
      if (dash < 0) continue;
      const idx = Number(name.slice(0, dash));
      if (!Number.isInteger(idx) || idx < 0 || idx >= lineCount) continue;
      const rest = name.slice(dash + 1);
      if (rest.endsWith('.clean.wav')) continue;
      if (rest.endsWith('.score.json')) {
        const ms = rest.slice(0, -'.score.json'.length);
        try {
          scoreByKey.set(`${idx}-${ms}`, JSON.parse(new File(entry.uri).textSync()) as TakeScore);
        } catch {
          // Bad or half-written JSON: treat as no score for this take.
        }
        continue;
      }
      let ms: string | null = null;
      if (rest.endsWith('.wav')) ms = rest.slice(0, -'.wav'.length);
      else if (rest.endsWith('.m4a')) ms = rest.slice(0, -'.m4a'.length);
      if (ms === null) continue;
      const recordedAt = Number(ms);
      if (!Number.isFinite(recordedAt)) continue;
      const prev = newestByIdx.get(idx);
      if (!prev || recordedAt > prev.recordedAt) newestByIdx.set(idx, { ms, recordedAt });
    }
    for (const [idx, base] of newestByIdx) {
      const score = scoreByKey.get(`${idx}-${base.ms}`) ?? null;
      tiers[idx] = scoredTier(score) ?? 'good';
    }
    return tiers;
  } catch {
    return tiers;
  }
}

/**
 * Island total for the "kept up with X of Y words" count: same newest
 * base take per line index and same `.score.json` lookup as `lineTiers`
 * above (a future change to the take file naming scheme has to be made in
 * both places), but sums `wordsKeptUp` per line instead of tiering it.
 * Lines with no scoreable take are skipped. Never throws.
 */
export function keptUpTotal(islandId: string, lineCount: number): { kept: number; total: number } {
  const total = { kept: 0, total: 0 };
  try {
    const dir = takeDir(islandId);
    if (!dir.exists) return total;
    const newestByIdx = new Map<number, { ms: string; recordedAt: number }>();
    const scoreByKey = new Map<string, TakeScore>();
    for (const entry of dir.list()) {
      const name = entry.name;
      const dash = name.indexOf('-');
      if (dash < 0) continue;
      const idx = Number(name.slice(0, dash));
      if (!Number.isInteger(idx) || idx < 0 || idx >= lineCount) continue;
      const rest = name.slice(dash + 1);
      if (rest.endsWith('.clean.wav')) continue;
      if (rest.endsWith('.score.json')) {
        const ms = rest.slice(0, -'.score.json'.length);
        try {
          scoreByKey.set(`${idx}-${ms}`, JSON.parse(new File(entry.uri).textSync()) as TakeScore);
        } catch {
          // Bad or half-written JSON: treat as no score for this take.
        }
        continue;
      }
      let ms: string | null = null;
      if (rest.endsWith('.wav')) ms = rest.slice(0, -'.wav'.length);
      else if (rest.endsWith('.m4a')) ms = rest.slice(0, -'.m4a'.length);
      if (ms === null) continue;
      const recordedAt = Number(ms);
      if (!Number.isFinite(recordedAt)) continue;
      const prev = newestByIdx.get(idx);
      if (!prev || recordedAt > prev.recordedAt) newestByIdx.set(idx, { ms, recordedAt });
    }
    for (const [idx, base] of newestByIdx) {
      const score = scoreByKey.get(`${idx}-${base.ms}`) ?? null;
      const line = wordsKeptUp(score);
      if (line === null) continue;
      total.kept += line.kept;
      total.total += line.total;
    }
    return total;
  } catch {
    return total;
  }
}

/**
 * Index of the weakest line, the first at the lowest tier present in order
 * none < retry < good < great. `-1` when every line is `'great'` (nothing
 * to flicker) or there are no lines.
 */
export function weakestLine(tiers: LineTier[]): number {
  for (const tier of TIER_ORDER) {
    const idx = tiers.indexOf(tier);
    if (idx >= 0) return tier === 'great' ? -1 : idx;
  }
  return -1;
}

/** Folder for one island's takes: <document>/takes/<islandId>. */
export function takeDir(islandId: string): Directory {
  return new Directory(Paths.document, 'takes', islandId);
}

/** Where a downloaded cleaned take for `<idx>-<recordedAt>.wav` should land. */
export function cleanTakeFile(islandId: string, idx: number, recordedAt: number): File {
  const dir = takeDir(islandId);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return new File(dir, `${idx}-${recordedAt}.clean.wav`);
}

/**
 * Newest take for a line, or null. Pairs a take with its cleaned sibling, its
 * score sibling and its analysis sibling by the `<ms>` stamp in the
 * filename; `cleanUri`, `score` and `analysis` are set only when that file is
 * actually present. Reads the folder; never throws.
 */
export function findTake(islandId: string, idx: number): Take | null {
  const prefix = `${idx}-`;
  try {
    const dir = takeDir(islandId);
    if (!dir.exists) return null;
    const bases: { uri: string; recordedAt: number; ms: string }[] = [];
    const cleanByMs = new Map<string, string>();
    const scoreByMs = new Map<string, TakeScore>();
    const analysisByMs = new Map<string, TakeAnalysis>();
    for (const entry of dir.list()) {
      const name = entry.name;
      if (!name.startsWith(prefix)) continue;
      const rest = name.slice(prefix.length);
      if (rest.endsWith('.clean.wav')) {
        cleanByMs.set(rest.slice(0, -'.clean.wav'.length), entry.uri);
        continue;
      }
      if (rest.endsWith('.score.json')) {
        const ms = rest.slice(0, -'.score.json'.length);
        try {
          scoreByMs.set(ms, JSON.parse(new File(entry.uri).textSync()) as TakeScore);
        } catch {
          // Bad or half-written JSON: treat as no score for this take.
        }
        continue;
      }
      if (rest.endsWith('.analysis.json')) {
        const ms = rest.slice(0, -'.analysis.json'.length);
        try {
          analysisByMs.set(ms, JSON.parse(new File(entry.uri).textSync()) as TakeAnalysis);
        } catch {
          // Bad or half-written JSON: treat as no analysis for this take.
        }
        continue;
      }
      let ms: string | null = null;
      if (rest.endsWith('.wav')) ms = rest.slice(0, -'.wav'.length);
      else if (rest.endsWith('.m4a')) ms = rest.slice(0, -'.m4a'.length);
      if (ms === null) continue;
      const recordedAt = Number(ms);
      if (!Number.isFinite(recordedAt)) continue;
      bases.push({ uri: entry.uri, recordedAt, ms });
    }
    let newest: { uri: string; recordedAt: number; ms: string } | null = null;
    for (const base of bases) {
      if (!newest || base.recordedAt > newest.recordedAt) newest = base;
    }
    if (!newest) return null;
    return {
      uri: newest.uri,
      recordedAt: newest.recordedAt,
      cleanUri: cleanByMs.get(newest.ms) ?? null,
      score: scoreByMs.get(newest.ms) ?? null,
      analysis: analysisByMs.get(newest.ms) ?? null,
    };
  } catch {
    return null;
  }
}

/** Write a take's timing score beside `<idx>-<recordedAt>.wav`. */
export function saveTakeScore(islandId: string, idx: number, recordedAt: number, score: TakeScore): void {
  const dir = takeDir(islandId);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  new File(dir, `${idx}-${recordedAt}.score.json`).write(JSON.stringify(score));
}

/** Write a take's mora length and pitch analysis beside `<idx>-<recordedAt>.wav`. */
export function saveTakeAnalysis(islandId: string, idx: number, recordedAt: number, analysis: TakeAnalysis): void {
  const dir = takeDir(islandId);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  new File(dir, `${idx}-${recordedAt}.analysis.json`).write(JSON.stringify(analysis));
}

/**
 * Move a finished recording into place as `<idx>-<ms>.wav` and drop every
 * other take of that line, wav, m4a or json, cleaned or raw, so a stale
 * `.clean.wav` or `.score.json` can never pair with the new take.
 */
export async function saveTake(islandId: string, idx: number, fromUri: string): Promise<Take> {
  const dir = takeDir(islandId);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  const recordedAt = Date.now();
  const name = `${idx}-${recordedAt}.wav`;
  const dest = new File(dir, name);
  const source = new File(fromUri);
  await source.move(dest);
  const prefix = `${idx}-`;
  for (const entry of dir.list()) {
    if (entry.name === name) continue;
    if (!entry.name.startsWith(prefix)) continue;
    if (!entry.name.endsWith('.wav') && !entry.name.endsWith('.m4a') && !entry.name.endsWith('.json')) continue;
    try {
      entry.delete();
    } catch {
      // Leftover file, not fatal: the newest take is what matters.
    }
  }
  return { uri: dest.uri, recordedAt, cleanUri: null, score: null, analysis: null };
}

/** Remove every take of one line, raw, cleaned and scored. Never throws. */
export function deleteTake(islandId: string, idx: number): void {
  const prefix = `${idx}-`;
  try {
    const dir = takeDir(islandId);
    if (!dir.exists) return;
    for (const entry of dir.list()) {
      if (!entry.name.startsWith(prefix)) continue;
      if (!entry.name.endsWith('.wav') && !entry.name.endsWith('.m4a') && !entry.name.endsWith('.json')) continue;
      try {
        entry.delete();
      } catch {
        // Leftover file, not fatal: findTake is not asked for it again until a new take replaces it.
      }
    }
  } catch {
    // No folder, or it could not be read: nothing to delete.
  }
}

/** Remove every take of an island. Missing folder is fine. */
export function deleteTakes(islandId: string): void {
  try {
    const dir = takeDir(islandId);
    if (dir.exists) dir.delete();
  } catch {
    // Nothing to clean up, or the folder was already gone.
  }
}

/** Root folder for every island's takes: <document>/takes. */
function takesRoot(): Directory {
  return new Directory(Paths.document, 'takes');
}

/** Total bytes used by every take on disk, across every island. */
export async function takesStorageBytes(): Promise<number> {
  try {
    const root = takesRoot();
    return root.exists ? (root.size ?? 0) : 0;
  } catch {
    return 0;
  }
}

/** Remove every take of every island. Missing folder is fine. */
export async function deleteAllTakes(): Promise<void> {
  try {
    const root = takesRoot();
    if (root.exists) root.delete();
  } catch {
    // Nothing to clean up, or the folder was already gone.
  }
}
