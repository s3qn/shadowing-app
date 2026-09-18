/**
 * Where shadow takes live on disk. A take is the learner's own recording of a
 * line, kept on the phone under document storage: one file per line, newest
 * wins. Takes are wav (`<idx>-<ms>.wav`) and may have a cleaned sibling
 * (`<idx>-<ms>.clean.wav`) once the backend has removed the played line from
 * the recording, and a score sibling (`<idx>-<ms>.score.json`) with the
 * per-word timing marks, plus an analysis sibling (`<idx>-<ms>.analysis.json`)
 * with the per-mora length and pitch marks, and a meta sibling
 * (`<idx>-<ms>.meta.json`) holding the speed the line was spoken at. Older
 * takes recorded before this change are `.m4a`; they still play, just never
 * have a cleaned counterpart, a score or an analysis.
 *
 * One take per line is the rule for the island folder only. The first take a
 * line ever had is kept one level down in `first/`: instead of deleting the
 * outgoing take, `saveTake` moves it there when that line has nothing there
 * yet, so a line already recorded before any of this existed still has its
 * older take the first time it is recorded over. `first/` is written once per
 * line and then only read (`findFirstTake`), and goes with the island folder
 * when the island's takes are deleted.
 */

import { Directory, File, Paths } from 'expo-file-system';

import type { TakeAnalysis, TakeScore } from '@/lib/api';

export type Take = {
  uri: string;
  recordedAt: number;
  cleanUri: string | null;
  score: TakeScore | null;
  analysis: TakeAnalysis | null;
  /** Playback speed the line ran at while this was recorded, `null` when the take predates the meta sibling. */
  speed: number | null;
};

/** A line's kept first take, read from `first/`. No analysis: nothing draws one for it. */
export type ThenTake = {
  uri: string;
  recordedAt: number;
  cleanUri: string | null;
  score: TakeScore | null;
  speed: number | null;
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

/** Folder for one island's kept first takes: <document>/takes/<islandId>/first. */
function firstTakeDir(islandId: string): Directory {
  return new Directory(takeDir(islandId), 'first');
}

/** Whether `<idx>-<recordedAt>`'s raw take sits in this folder. */
function hasBaseTake(dir: Directory, idx: number, recordedAt: number): boolean {
  return new File(dir, `${idx}-${recordedAt}.wav`).exists || new File(dir, `${idx}-${recordedAt}.m4a`).exists;
}

/**
 * Folder holding `<idx>-<recordedAt>`'s files right now: the island folder
 * normally, `first/` once a later recording moved that take there. Cleaning
 * and scoring finish well after the take is written, so a score, an analysis
 * or a cleaned file can land on a take that has since been kept: writing
 * through this puts it with its own wav rather than beside a file that is no
 * longer there. Neither folder holding the take (it was deleted) answers the
 * island folder, where the next `saveTake` clears the orphan.
 */
export function takeHome(islandId: string, idx: number, recordedAt: number): Directory {
  const dir = takeDir(islandId);
  try {
    if (hasBaseTake(dir, idx, recordedAt)) return dir;
    const kept = firstTakeDir(islandId);
    if (kept.exists && hasBaseTake(kept, idx, recordedAt)) return kept;
  } catch {
    // Unreadable folder: the island folder is the answer anyway.
  }
  return dir;
}

/** Where a downloaded cleaned take for `<idx>-<recordedAt>.wav` should land. */
export function cleanTakeFile(islandId: string, idx: number, recordedAt: number): File {
  const dir = takeHome(islandId, idx, recordedAt);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return new File(dir, `${idx}-${recordedAt}.clean.wav`);
}

/**
 * Newest take for a line inside one folder. Pairs a take with its cleaned
 * sibling, its score sibling, its analysis sibling and its meta sibling by
 * the `<ms>` stamp in the filename; `cleanUri`, `score`, `analysis` and
 * `speed` are set only when that file is actually present. Used on the
 * island folder by `findTake` and on `first/` by `findFirstTake`, so both
 * read a take the same way. Reads the folder; throws only if the folder
 * cannot be listed.
 */
function newestTakeIn(dir: Directory, idx: number): Take | null {
  const prefix = `${idx}-`;
  const bases: { uri: string; recordedAt: number; ms: string }[] = [];
  const cleanByMs = new Map<string, string>();
  const scoreByMs = new Map<string, TakeScore>();
  const analysisByMs = new Map<string, TakeAnalysis>();
  const speedByMs = new Map<string, number>();
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
    if (rest.endsWith('.meta.json')) {
      const ms = rest.slice(0, -'.meta.json'.length);
      try {
        const meta = JSON.parse(new File(entry.uri).textSync()) as { speed?: unknown };
        if (typeof meta.speed === 'number' && Number.isFinite(meta.speed)) speedByMs.set(ms, meta.speed);
      } catch {
        // Bad or half-written JSON: treat as no speed for this take.
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
    speed: speedByMs.get(newest.ms) ?? null,
  };
}

/** Newest take for a line, or null. Reads the island folder; never throws. */
export function findTake(islandId: string, idx: number): Take | null {
  try {
    const dir = takeDir(islandId);
    if (!dir.exists) return null;
    return newestTakeIn(dir, idx);
  } catch {
    return null;
  }
}

/**
 * A line's kept first take, or null when nothing was ever kept for it.
 * `first/` holds at most one take per line: the one `saveTake` moved there
 * the first time the line was recorded over, with whichever siblings had
 * landed by then. Reads the folder; never throws.
 */
export function findFirstTake(islandId: string, idx: number): ThenTake | null {
  try {
    const dir = firstTakeDir(islandId);
    if (!dir.exists) return null;
    const take = newestTakeIn(dir, idx);
    if (!take) return null;
    const { uri, recordedAt, cleanUri, score, speed } = take;
    return { uri, recordedAt, cleanUri, score, speed };
  } catch {
    return null;
  }
}

/** Write a take's timing score beside its own wav, wherever that wav now lives. */
export function saveTakeScore(islandId: string, idx: number, recordedAt: number, score: TakeScore): void {
  const dir = takeHome(islandId, idx, recordedAt);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  new File(dir, `${idx}-${recordedAt}.score.json`).write(JSON.stringify(score));
}

/** Write a take's mora length and pitch analysis beside its own wav, wherever that wav now lives. */
export function saveTakeAnalysis(islandId: string, idx: number, recordedAt: number, analysis: TakeAnalysis): void {
  const dir = takeHome(islandId, idx, recordedAt);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  new File(dir, `${idx}-${recordedAt}.analysis.json`).write(JSON.stringify(analysis));
}

/** Whether `first/` already holds a raw take for this line. */
function hasKeptTake(dir: Directory, idx: number): boolean {
  try {
    if (!dir.exists) return false;
    const prefix = `${idx}-`;
    for (const entry of dir.list()) {
      if (!entry.name.startsWith(prefix)) continue;
      if (entry.name.endsWith('.m4a')) return true;
      if (entry.name.endsWith('.wav') && !entry.name.endsWith('.clean.wav')) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Move a finished recording into place as `<idx>-<ms>.wav`, write the speed
 * it was spoken at beside it, and clear every other take of that line, wav,
 * m4a or json, cleaned or raw, so a stale `.clean.wav` or `.score.json` can
 * never pair with the new take.
 *
 * Clearing the outgoing take means moving it into `first/` the one time that
 * line has nothing kept there, and deleting it every time after. Moving what
 * leaves rather than copying what arrives is what lets a line recorded long
 * before any of this keep the take it already had: its files are on disk
 * with whatever siblings they gathered, and they are simply carried down a
 * folder instead of thrown away.
 */
export async function saveTake(islandId: string, idx: number, fromUri: string, speed: number | null): Promise<Take> {
  const dir = takeDir(islandId);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  const recordedAt = Date.now();
  const name = `${idx}-${recordedAt}.wav`;
  const metaName = `${idx}-${recordedAt}.meta.json`;
  const dest = new File(dir, name);
  const source = new File(fromUri);
  await source.move(dest);
  try {
    new File(dir, metaName).write(JSON.stringify({ speed }));
  } catch {
    // Best effort: the take just has no speed to show beside it later.
  }
  const kept = firstTakeDir(islandId);
  // Decided once, before anything moves: asking again after the outgoing wav
  // landed in `first/` would answer differently and leave its score and meta
  // behind in the island folder, where the loop deletes them.
  const keeping = !hasKeptTake(kept, idx);
  const prefix = `${idx}-`;
  for (const entry of dir.list()) {
    if (entry.name === name || entry.name === metaName) continue;
    if (!entry.name.startsWith(prefix)) continue;
    if (!entry.name.endsWith('.wav') && !entry.name.endsWith('.m4a') && !entry.name.endsWith('.json')) continue;
    try {
      if (keeping) {
        if (!kept.exists) kept.create({ intermediates: true, idempotent: true });
        entry.move(kept);
      } else {
        entry.delete();
      }
    } catch {
      // Leftover file, not fatal: the newest take is what matters.
    }
  }
  return { uri: dest.uri, recordedAt, cleanUri: null, score: null, analysis: null, speed };
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

/**
 * Total bytes used by every take on disk, across every island. `Directory.size`
 * walks the whole tree (`subpathsOfDirectory` on iOS, `walkTopDown` on
 * Android), so the per-island folders and the first takes inside them are all
 * counted.
 */
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
