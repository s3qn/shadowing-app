/**
 * Islands kept on the phone so they play with no connection. One download is
 * the island JSON, its line audio at the speeds the player reaches without a
 * scored take, the audio of every word and the meanings of every word.
 *
 * Layout under Paths.document/offline/<owner>/<islandId>/: manifest.json
 * (written last, a folder without one is not a download), island.json,
 * glosses.json, audio/<idx>@<speed>+<pad>.wav and words/<hash>.wav. Files land
 * as <name>.part and are moved into place, so a half file is never served.
 * The transfers are native; the JS thread only writes small JSON files.
 */
import { useCallback, useSyncExternalStore } from 'react';
import { Directory, File, Paths } from 'expo-file-system';

import * as api from '@/lib/api';
import type { Gloss, Island, IslandSummary } from '@/lib/api';
import { userIdSync } from '@/lib/auth';
import { deviceIdSync } from '@/lib/device';
import { readCachedIsland } from '@/lib/island-cache';
import { hash } from '@/lib/line-audio-cache';
import { getSettingsSync } from '@/lib/settings';
import { peekRung } from '@/lib/speed-ladder';

const CONCURRENT = 3;
const WORD_STRIP = '、。！？!?…「」『』（）() ,.;:¿¡«»"\'';

type Manifest = {
  v: 1;
  islandId: string;
  owner: string;
  summary: IslandSummary;
  speaker: number;
  speeds: number[];
  pads: number[];
  lines: Record<string, string>;
  words: Record<string, string>;
  bytes: number;
  downloadedAt: number;
};

export type DownloadStatus = {
  state: 'none' | 'downloading' | 'done' | 'failed';
  done: number;
  total: number;
  bytes: number;
};

const NONE: DownloadStatus = { state: 'none', done: 0, total: 0, bytes: 0 };
const FAILED: DownloadStatus = { state: 'failed', done: 0, total: 0, bytes: 0 };

/** The one place the owner is decided: the signed-in user, or the device in
 * the Expo Go dev bypass, so two accounts on one phone never share downloads. */
function ownerKey(): string {
  const user = userIdSync();
  return user ? `user_${user}` : deviceIdSync();
}

const manifests = new Map<string, Manifest>();
const live = new Map<string, DownloadStatus>();
const aborts = new Map<string, AbortController>();
/** Islands whose last download stopped on an error (not on a user stop). */
const failed = new Set<string>();
const listeners = new Map<string | null, Set<() => void>>();
let totalSnapshot = { count: 0, bytes: 0 };

function safe(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_');
}

function ownerDir(): Directory {
  return new Directory(Paths.document, 'offline', safe(ownerKey() || 'none'));
}

function islandDir(id: string): Directory {
  return new Directory(ownerDir(), safe(id));
}

function speedKey(speed: number): string {
  return speed.toFixed(2);
}

function audioName(idx: number | string, speed: number, pad: number): string {
  return `${idx}@${speedKey(speed)}+${pad}.wav`;
}

function status(id: string): DownloadStatus {
  const l = live.get(id);
  if (l) return l;
  const m = manifests.get(id);
  if (m) return doneStatus(m);
  return failed.has(id) ? FAILED : NONE;
}

const doneCache = new Map<string, DownloadStatus>();
function doneStatus(m: Manifest): DownloadStatus {
  const hit = doneCache.get(m.islandId);
  if (hit && hit.bytes === m.bytes) return hit;
  const s: DownloadStatus = { state: 'done', done: 1, total: 1, bytes: m.bytes };
  doneCache.set(m.islandId, s);
  return s;
}

function notify(id: string) {
  const total = computeTotal();
  if (total.count !== totalSnapshot.count || total.bytes !== totalSnapshot.bytes) totalSnapshot = total;
  for (const key of [id, null]) {
    for (const cb of [...(listeners.get(key) ?? [])]) cb();
  }
}

function computeTotal(): { count: number; bytes: number } {
  let bytes = 0;
  for (const m of manifests.values()) bytes += m.bytes;
  return { count: manifests.size, bytes };
}

export function subscribe(id: string | null, cb: () => void): () => void {
  let set = listeners.get(id);
  if (!set) {
    set = new Set();
    listeners.set(id, set);
  }
  set.add(cb);
  return () => {
    set!.delete(cb);
  };
}

export function useDownloadStatus(id: string): DownloadStatus {
  const sub = useCallback((cb: () => void) => subscribe(id, cb), [id]);
  return useSyncExternalStore(sub, () => status(id), () => NONE);
}

/** Only the state, so a card does not re-render on every finished file. */
export function useDownloadState(id: string): DownloadStatus['state'] {
  const sub = useCallback((cb: () => void) => subscribe(id, cb), [id]);
  return useSyncExternalStore(sub, () => status(id).state, () => 'none');
}

export function isDownloaded(id: string): boolean {
  return manifests.has(id);
}

export function downloadStatus(id: string): DownloadStatus {
  return status(id);
}

export function totalDownloaded(): { count: number; bytes: number } {
  return totalSnapshot;
}

/** Reads every manifest under the owner folder into memory. Never throws. */
export async function loadOfflineIndex(): Promise<void> {
  try {
    const root = ownerDir();
    if (!root.exists) return;
    for (const entry of root.list()) {
      if (!(entry instanceof Directory)) continue;
      try {
        const file = new File(entry, 'manifest.json');
        if (!file.exists) {
          // A download that never finished: drop leftover .part files, keep
          // the finished ones so a new attempt resumes.
          dropParts(entry);
          continue;
        }
        const m = JSON.parse(await file.text()) as Manifest;
        if (m && m.v === 1 && m.islandId) manifests.set(m.islandId, m);
      } catch {
        // A damaged folder is not a download.
      }
    }
  } catch {
    // No offline folder yet.
  }
  totalSnapshot = computeTotal();
  for (const cb of [...(listeners.get(null) ?? [])]) cb();
}

function dropParts(dir: Directory) {
  try {
    for (const sub of dir.list()) {
      if (!(sub instanceof Directory)) continue;
      for (const f of sub.list()) {
        if (f instanceof File && f.name.endsWith('.part')) f.delete();
      }
    }
  } catch {
    // Leftovers only cost space.
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function unique(values: number[]): number[] {
  return [...new Set(values)];
}

type Task = { url: string; dir: Directory; name: string };

/** Downloads the island for offline use. Resolves true when it finished,
 * false when it was stopped or failed. Never throws. */
export async function startDownload(id: string): Promise<boolean> {
  const before = status(id).state;
  if (before !== 'none' && before !== 'failed') return false;
  failed.delete(id);
  const ctl = new AbortController();
  aborts.set(id, ctl);
  // False once this run was stopped, failed or replaced by a newer run: from
  // then on it must not touch the shared state.
  const current = () => aborts.get(id) === ctl && !ctl.signal.aborted;
  live.set(id, { state: 'downloading', done: 0, total: 0, bytes: 0 });
  notify(id);
  try {
    const cached = await readCachedIsland(id);
    let island: Island;
    let text: string;
    if (cached) {
      island = cached.island;
      text = cached.text;
    } else {
      ({ island, text } = await api.getIslandWithText(id));
    }
    if (island.status !== 'ready') throw new Error('island is not ready');
    if (!current()) return false;

    const dir = islandDir(id);
    const audioDir = new Directory(dir, 'audio');
    const wordsDir = new Directory(dir, 'words');
    dir.create({ intermediates: true, idempotent: true });
    audioDir.create({ intermediates: true, idempotent: true });
    wordsDir.create({ intermediates: true, idempotent: true });
    dropParts(dir);
    writeText(new File(dir, 'island.json'), text);

    const S = peekRung(id)?.speed ?? getSettingsSync().defaultSpeed;
    const speeds = unique([S, 1.0].map(round2));
    const pads = unique([0, getSettingsSync().defaultPauseMs]);

    const lines: Record<string, string> = {};
    const words: Record<string, string> = {};
    const tasks: Task[] = [];
    for (const line of island.lines) {
      lines[String(line.idx)] = line.ja;
      for (const speed of speeds) {
        for (const pad of pads) {
          tasks.push({
            url: api.withUser(api.lineAudioUrl(id, line.idx, '', speed, pad)),
            dir: audioDir,
            name: audioName(line.idx, speed, pad),
          });
        }
      }
      for (const w of line.words ?? []) {
        if (!w.text || words[w.text]) continue;
        const name = `${hash(w.text)}.wav`;
        words[w.text] = name;
        tasks.push({ url: api.wordAudioUrl(w.text, island.speaker), dir: wordsDir, name });
      }
    }

    const glosses: Record<string, Gloss> =
      island.language === 'ja' ? await api.offlineGlosses(id) : {};
    if (!current()) return false;
    writeText(new File(dir, 'glosses.json'), JSON.stringify(glosses));

    let bytes = sizeOf(new File(dir, 'island.json')) + sizeOf(new File(dir, 'glosses.json'));
    let done = 0;
    live.set(id, { state: 'downloading', done, total: tasks.length, bytes });
    notify(id);

    let next = 0;
    const worker = async () => {
      while (current()) {
        const task = tasks[next++];
        if (!task) return;
        const final = new File(task.dir, task.name);
        if (!final.exists) {
          const part = new File(task.dir, `${task.name}.part`);
          await File.downloadFileAsync(task.url, part, { idempotent: true, signal: ctl.signal });
          if (!current()) return;
          part.move(final);
        }
        if (!current()) return;
        bytes += sizeOf(final);
        done++;
        live.set(id, { state: 'downloading', done, total: tasks.length, bytes });
        notify(id);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENT, tasks.length) }, worker));
    if (!current()) return false;

    const manifest: Manifest = {
      v: 1,
      islandId: id,
      owner: ownerKey(),
      summary: summaryOf(island),
      speaker: island.speaker,
      speeds,
      pads,
      lines,
      words,
      bytes,
      downloadedAt: Date.now(),
    };
    writeText(new File(dir, 'manifest.json'), JSON.stringify(manifest));
    manifests.set(id, manifest);
    live.delete(id);
    return true;
  } catch {
    // Offline or a failed file: the finished files stay for a retry. A user
    // stop is not a failure. Aborting stops the other workers' transfers.
    if (current()) failed.add(id);
    ctl.abort();
    return false;
  } finally {
    if (aborts.get(id) === ctl) {
      aborts.delete(id);
      live.delete(id);
      notify(id);
    }
  }
}

function writeText(file: File, text: string) {
  if (!file.exists) file.create({ intermediates: true, overwrite: true });
  file.write(text);
}

function sizeOf(file: File): number {
  try {
    return file.size ?? 0;
  } catch {
    return 0;
  }
}

function summaryOf(i: IslandSummary): IslandSummary {
  return {
    id: i.id,
    title: i.title,
    status: i.status,
    stage: i.stage,
    complexity: i.complexity,
    language: i.language,
    native: i.native,
    created_at: i.created_at,
    line_count: i.line_count,
  };
}

function wipe(id: string) {
  try {
    const dir = islandDir(id);
    if (dir.exists) dir.delete();
  } catch {
    // Already gone.
  }
}

/** Stops a running download and deletes what it fetched. */
export function cancelDownload(id: string) {
  aborts.get(id)?.abort();
  removeDownload(id);
}

/** Deletes the island's download. Never throws. */
export function removeDownload(id: string) {
  aborts.get(id)?.abort();
  const had = manifests.delete(id);
  const wasFailed = failed.delete(id);
  doneCache.delete(id);
  glossMemo.delete(id);
  wipe(id);
  if (had || wasFailed || live.has(id)) {
    live.delete(id);
    notify(id);
  }
}

export function removeAllDownloads() {
  for (const id of [...aborts.keys()]) aborts.get(id)?.abort();
  try {
    const root = ownerDir();
    if (root.exists) root.delete();
  } catch {
    // Already gone.
  }
  const ids = [...manifests.keys(), ...live.keys(), ...failed];
  manifests.clear();
  failed.clear();
  glossMemo.clear();
  doneCache.clear();
  live.clear();
  totalSnapshot = computeTotal();
  for (const id of ids) notify(id);
  notify('');
}

/** The downloaded islands for Home when the server cannot be reached,
 * newest first. */
export function offlineSummaries(): IslandSummary[] {
  return [...manifests.values()]
    .sort((a, b) => b.downloadedAt - a.downloadedAt)
    .map((m) => m.summary);
}

export async function readOfflineIsland(id: string): Promise<{ island: Island; text: string } | null> {
  try {
    if (!manifests.has(id)) return null;
    const file = new File(islandDir(id), 'island.json');
    if (!file.exists) return null;
    const text = await file.text();
    const island = JSON.parse(text) as Island;
    if (!island || island.id !== id || island.status !== 'ready' || !Array.isArray(island.lines)) {
      return null;
    }
    return { island, text };
  } catch {
    return null;
  }
}

/** Keeps the stored copy current after a rename or a late ruby fill. Never throws. */
export function refreshOfflineIsland(island: Island, text: string) {
  const m = manifests.get(island.id);
  if (!m || live.has(island.id)) return;
  try {
    const dir = islandDir(island.id);
    writeText(new File(dir, 'island.json'), text);
    const next = { ...m, summary: summaryOf(island) };
    manifests.set(island.id, next);
    writeText(new File(dir, 'manifest.json'), JSON.stringify(next));
  } catch {
    // The older copy still plays.
  }
}

/** The stored file uri for this line audio URL, or null when it is not part
 * of the download (a phrase, another speed, a changed line). */
export function offlineLineAudio(url: string, tag: string): string | null {
  const m = /\/islands\/([^/]+)\/lines\/(\d+)\/audio\?(.*)$/.exec(url);
  if (!m || manifests.size === 0) return null;
  const manifest = manifests.get(m[1]);
  if (!manifest) return null;
  const params = new URLSearchParams(m[3]);
  if (params.has('start')) return null;
  const speed = Number(params.get('speed') ?? '1');
  const pad = Number(params.get('pad') ?? '0');
  if (manifest.lines[m[2]] !== tag) return null;
  const file = new File(islandDir(manifest.islandId), 'audio', audioName(m[2], speed, pad));
  try {
    return file.exists ? file.uri : null;
  } catch {
    return null;
  }
}

export function offlineWordAudio(id: string, text: string, _speaker: number): string | null {
  const name = manifests.get(id)?.words[text];
  if (!name) return null;
  try {
    const file = new File(islandDir(id), 'words', name);
    return file.exists ? file.uri : null;
  } catch {
    return null;
  }
}

const glossMemo = new Map<string, Record<string, Gloss>>();

const glossLoading = new Set<string>();

/** Reads the island's stored meanings into memory off the tap path. Call it
 * when the island opens. Never throws. */
export async function preloadOfflineGlosses(id: string): Promise<void> {
  if (!manifests.has(id) || glossMemo.has(id) || glossLoading.has(id)) return;
  glossLoading.add(id);
  try {
    const file = new File(islandDir(id), 'glosses.json');
    if (!file.exists) return;
    const table = JSON.parse(await file.text()) as Record<string, Gloss>;
    if (manifests.has(id) && table && typeof table === 'object') glossMemo.set(id, table);
  } catch {
    // The word tap falls back to the server.
  } finally {
    glossLoading.delete(id);
  }
}

/** The stored meanings for a word, or null while they are not loaded yet. */
export function offlineGloss(id: string, word: string): Gloss | null {
  if (!manifests.has(id)) return null;
  try {
    const table = glossMemo.get(id);
    if (!table) {
      void preloadOfflineGlosses(id);
      return null;
    }
    return table[word] ?? table[word.replace(new RegExp(`^[${escapeClass(WORD_STRIP)}]+|[${escapeClass(WORD_STRIP)}]+$`, 'g'), '')] ?? null;
  } catch {
    return null;
  }
}

function escapeClass(s: string): string {
  return s.replace(/[\\\]^-]/g, '\\$&');
}

/** The nearest speed and pad that the download holds, for the offline player. */
export function snapOffline(id: string, speed: number, padMs: number): { speed: number; padMs: number } {
  const m = manifests.get(id);
  if (!m) return { speed, padMs };
  const near = (list: number[], v: number) =>
    list.reduce((best, x) => (Math.abs(x - v) < Math.abs(best - v) ? x : best), list[0] ?? v);
  return { speed: near(m.speeds, speed), padMs: near(m.pads, padMs) };
}

export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${mb.toFixed(1)} MB`;
}
