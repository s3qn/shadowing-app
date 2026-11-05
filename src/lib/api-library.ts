// Api domain: library (phrase topics, grammar, video islands). Moved out of api.ts.
import { File } from 'expo-file-system';

import { BASE, expoFetch, fetch } from '@/lib/api-http';
import { headers, json } from '@/lib/api-core';
import { createIsland } from '@/lib/api-islands';
import type { Complexity, IslandSummary, Language, NativeLanguage, Register } from '@/lib/api-types';
import type { StarterLevel } from '@/lib/settings';
import type { VideoContext } from '@/lib/youtube-captions';

// --- phrase-islands ---
export type PhraseTopic = {
  id: string;
  title: string;
  count: number;
  sample: string;
  category?: string | null;
  titleHe?: string;
  samples?: string[];
  added?: boolean;
  matchedPhrase?: string | null;
};
export type PhraseCategory = { id: string; title: string; titleHe?: string; count: number };
export type PhraseCatalog = { topics: PhraseTopic[]; categories?: PhraseCategory[] };

/** The ready-made phrase topics for a learning language, titled in `ui`. */
export async function phraseCatalog(language: Language, ui: string): Promise<PhraseCatalog> {
  return json<PhraseCatalog>(
    await fetch(`${BASE}/phrases/catalog?language=${encodeURIComponent(language)}&ui=${encodeURIComponent(ui)}`, {
      headers: headers(),
    }),
  );
}

/** Add a phrase topic as an island. A repeat pick returns the existing island. Poll getIsland until ready. */
export async function importPhrases(
  topic: string,
  speaker: number,
  language: Language = 'ja',
  native: NativeLanguage = 'en',
): Promise<{ id: string; status?: string }> {
  const form = new FormData();
  form.append('topic', topic);
  form.append('speaker', String(speaker));
  form.append('language', language);
  form.append('native', native);

  return json<{ id: string; status?: string }>(
    await expoFetch(`${BASE}/phrases/import`, { method: 'POST', headers: headers(), body: form }),
  );
}

/** The first-run guide's pre-baked 3-line island. A repeat call returns the same one. */
export async function startStarter(
  language: Language,
  native: NativeLanguage,
  level: StarterLevel = 'new',
): Promise<{ id: string; status?: string }> {
  const form = new FormData();
  form.append('language', language);
  form.append('native', native);
  form.append('level', level);
  return json<{ id: string; status?: string }>(
    await expoFetch(`${BASE}/starter`, { method: 'POST', headers: headers(), body: form }),
  );
}

// --- grammar-islands ---
export type GrammarPoint = {
  id: string;
  pattern: string;
  reading: string;
  level: string;
  level_guess: number;
  meaning_short: string;
  added?: boolean;
};

/** Levels the backend has grammar for. Empty (or a failure) when it has no grammar.db. */
export async function grammarLevels(): Promise<{ level: string; count: number }[]> {
  const res = await json<{ levels: { level: string; count: number }[] }>(
    await fetch(`${BASE}/grammar/levels`, { headers: headers() }),
  );
  return res.levels;
}

export async function grammarPoints(level: string, q = ''): Promise<GrammarPoint[]> {
  const res = await json<{ points: GrammarPoint[] }>(
    await fetch(`${BASE}/grammar/points?level=${encodeURIComponent(level)}&q=${encodeURIComponent(q)}`, {
      headers: headers(),
    }),
  );
  return res.points;
}

/** One grammar point by id, or null when the backend has no such point. */
export async function grammarPoint(id: string): Promise<GrammarPoint | null> {
  const res = await json<{ points: GrammarPoint[] }>(
    await fetch(`${BASE}/grammar/points?point=${encodeURIComponent(id)}`, { headers: headers() }),
  );
  return res.points[0] ?? null;
}

/** Add a grammar point as a build-up island. A repeat pick returns the existing island. Poll getIsland until ready. */
export async function importGrammar(
  point: string,
  speaker: number,
  native: NativeLanguage = 'en',
  register: Register = 'polite',
): Promise<{ id: string }> {
  const form = new FormData();
  form.append('point', point);
  form.append('speaker', String(speaker));
  form.append('register', register);
  form.append('native', native);
  return json<{ id: string }>(
    await expoFetch(`${BASE}/grammar/import`, { method: 'POST', headers: headers(), body: form }),
  );
}

/** Build a phrase island from a recorded topic ("phrases for the gym"). Poll getIsland after this. */
export async function createTopicIsland(
  uri: string,
  speaker: number,
  language: Language,
  native: NativeLanguage,
  complexity: Complexity = 'simple',
  register?: Register,
  count = 10,
): Promise<{ id: string }> {
  return createIsland(uri, complexity, speaker, register, count, language, native, true);
}

// --- import-file ---
/**
 * Import an audio file (and an optional .srt) as an island that plays the
 * original audio, sliced per line. Returns as soon as the file is accepted;
 * poll getIsland after this, same as createIsland. An empty title makes the
 * backend use the file name.
 */
export async function importIslandRaw(
  audioUri: string,
  srtUri: string | null,
  title: string,
  speaker: number,
  language: Language = 'ja',
  native: NativeLanguage = 'en',
  startMin = 0,
): Promise<{ id: string }> {
  const form = new FormData();
  form.append('audio', new File(audioUri), audioUri.split('/').pop() || 'audio');
  if (srtUri) form.append('subtitles', new File(srtUri), srtUri.split('/').pop() || 'subtitles.srt');
  form.append('title', title);
  form.append('speaker', String(speaker));
  form.append('language', language);
  form.append('native', native);
  form.append('start_min', String(startMin));

  return json<{ id: string }>(
    await expoFetch(`${BASE}/islands/import`, { method: 'POST', headers: headers(), body: form }),
  );
}

// --- youtube-shadowing ---

export type YouTubeInfo = { video_id: string; url: string; title: string; author: string; thumbnail: string };
export type IslandVideo = {
  island_id: string;
  video_id: string;
  start_s: number;
  duration: number;
  title: string;
  author: string;
  /** True when the island has no audio, only captions. */
  captions_only?: boolean;
  /** Caption timing job (ASR word onsets onto the manual text): '' | queued |
   * running | done | failed | closed (no attempts left). */
  align?: string;
  /** How the job ended: asr (lines moved), asr_none (no automatic track),
   * asr_low_match (under 20% of lines anchored), asr_error. */
  align_error?: string;
  /** Caption repair job (the AI fixes automatic captions against the video's
   * context): '' | queued | running | done | failed | closed. */ // youtube-asr-context-repair
  repair?: string;
  /** How the job ended: manual (creator track or not ja, no LLM), off
   * (kill switch), or the error of a failed run. */
  repair_error?: string;
};
export type VideoListItem = {
  island_id: string;
  video_id: string;
  title: string;
  status: IslandSummary['status'];
  stage: string;
  error_code: string;
  line_count: number;
  created_at: string;
};

/** Title, channel and thumbnail for a pasted YouTube link. */
export async function youtubeInfo(url: string): Promise<YouTubeInfo> {
  return json<YouTubeInfo>(await fetch(`${BASE}/youtube/info?url=${encodeURIComponent(url)}`, { headers: headers() }));
}

/** The largest caption import body, in characters, that still carries the automatic track. */
const MAX_ASR_BODY = 4_000_000;

/** Send the caption events the phone fetched and build an island from them.
 * `asrEvents` is the automatic track (token onsets) when the picked track is
 * manual; left out of the body when empty. `context` is the watch page's
 * video details for the repair pass, left out when YouTube gave none. Poll
 * getIsland until ready. */
export async function importYouTubeCaptionsRaw(
  url: string,
  title: string,
  speaker: number,
  language: Language,
  native: NativeLanguage,
  events: unknown[],
  asrEvents: unknown[] = [],
  context: VideoContext | null = null,
): Promise<{ id: string }> {
  const base: Record<string, unknown> = { url, title, speaker, language, native, events };
  if (context) base.context = context;
  const post = (body: string) =>
    fetch(`${BASE}/youtube/captions`, {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body,
    });
  // The automatic track only refines timing: one too big to send, or one the
  // server refuses, is dropped so the import still goes through without it.
  const withAsr = asrEvents.length > 0 ? JSON.stringify({ ...base, asr_events: asrEvents }) : '';
  if (withAsr && withAsr.length <= MAX_ASR_BODY) {
    const res = await post(withAsr);
    if (res.status !== 400 && res.status !== 413 && res.status !== 422) return json<{ id: string }>(res);
  }
  return json<{ id: string }>(await post(JSON.stringify(base)));
}

/** The YouTube link behind a video island. */
export async function getIslandVideo(id: string): Promise<IslandVideo> {
  return json<IslandVideo>(await fetch(`${BASE}/islands/${id}/video`, { headers: headers() }));
}

/** The automatic caption track of an existing video island, for the server to
 * retime its lines onto the token onsets. `{ align: 'queued' }` on success;
 * 409 `align_busy` while a job runs, 409 `align_closed` once it is done or
 * out of attempts. An empty list closes the job as `asr_none`. */
export async function postCaptionTiming(islandId: string, asrEvents: unknown[]): Promise<{ align: string }> {
  return json<{ align: string }>(
    await fetch(`${BASE}/islands/${islandId}/captions-timing`, {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ asr_events: asrEvents }),
    }),
  );
}

/** The video's context for an existing island, so the server can run (or
 * re-run at a new version) the caption repair pass. `{ repair: 'queued' |
 * 'running' | 'done' }`; 400 `not_video`, 409 `not_ready` while the island
 * builds, 409 `repair_closed` once the attempts are spent. */ // youtube-asr-context-repair
export async function postVideoRepair(islandId: string, context: VideoContext): Promise<{ repair: string }> {
  return json<{ repair: string }>(
    await fetch(`${BASE}/islands/${islandId}/repair`, {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ context }),
    }),
  );
}

/** Every video island on this device, newest first. */
export async function listVideos(): Promise<VideoListItem[]> {
  return json<VideoListItem[]>(await fetch(`${BASE}/videos`, { headers: headers() }));
}

