// Api domain: podcasts.
import { BASE, ORIGIN, TOKEN, expoFetch, fetch } from '@/lib/api-http';
import { headers, json, userParam } from '@/lib/api-core';
import type { Language, NativeLanguage } from '@/lib/api-types';
import { withEnergy } from '@/lib/energy';
import { deviceIdSync } from '@/lib/device';

/** One item in a podcast feed, matching `podcast.py`'s `parse_feed()`. */
export type PodcastEpisode = {
  title: string;
  published: string | null;
  duration_s: number | null;
  audio_url: string;
  bytes: number | null;
};

/** Fetch and parse a podcast RSS feed so an episode can be picked to import. */
export async function podcastEpisodes(url: string): Promise<{ title: string; episodes: PodcastEpisode[] }> {
  return json<{ title: string; episodes: PodcastEpisode[] }>(
    await fetch(`${BASE}/podcasts/episodes?url=${encodeURIComponent(url)}`, { headers: headers() }),
  );
}

/** One show in the hand-picked podcast catalog, or one search result normalised to the same shape. */
export type PodcastShow = {
  collectionId: number | null;
  title: string;
  feedUrl: string;
  artworkUrl: string | null;
  level: 'beginner' | 'intermediate' | 'advanced' | null;
  tagline: string | null;
};

export type PodcastSection = { id: string; title: string; subtitle: string; shows: PodcastShow[] };
export type PodcastCatalog = { sections: PodcastSection[] };

/** The hand-picked catalog of browsable shows for a learning language. Its
 * section copy and show taglines are editorial text that lives on the
 * server, so the interface language travels with the request as `ui` and the
 * server writes them in it: someone learning Japanese while reading Hebrew
 * gets Hebrew section copy over Japanese shows. */
export async function podcastCatalog(language: Language, ui: string): Promise<PodcastCatalog> {
  return json<PodcastCatalog>(
    await fetch(`${BASE}/podcasts/catalog?language=${encodeURIComponent(language)}&ui=${encodeURIComponent(ui)}`, {
      headers: headers(),
    }),
  );
}

/** Resolve a typed query, an Apple Podcasts link, or a raw feed URL to a list of shows. */
export async function podcastSearch(q: string, language: Language): Promise<PodcastShow[]> {
  const out = await json<{ results: PodcastShow[] }>(
    await fetch(`${BASE}/podcasts/search?q=${encodeURIComponent(q)}&language=${encodeURIComponent(language)}`, {
      headers: headers(),
    }),
  );
  return out.results;
}

/** Download a podcast episode by URL and build an island from it. Poll getIsland until ready. */
async function importPodcastEpisodeRaw(
  audioUrl: string,
  title: string,
  speaker: number,
  language: Language = 'ja',
  native: NativeLanguage = 'en',
  startMin = 0,
): Promise<{ id: string }> {
  const form = new FormData();
  form.append('audio_url', audioUrl);
  form.append('title', title);
  form.append('speaker', String(speaker));
  form.append('language', language);
  form.append('native', native);
  form.append('start_min', String(startMin));

  return json<{ id: string }>(
    await expoFetch(`${BASE}/podcasts/import`, { method: 'POST', headers: headers(), body: form }),
  );
}

/** Absolute URL for a style icon path returned by listSpeakers. */
export function iconUrl(path: string): string {
  return `${ORIGIN}${path}?token=${encodeURIComponent(TOKEN)}&device=${encodeURIComponent(deviceIdSync())}${userParam()}`;
}

/** The fixed preview sentence rendered in one voice. */
export function voicePreviewUrl(styleId: number): string {
  return `${BASE}/voices/${styleId}/preview?token=${encodeURIComponent(TOKEN)}&device=${encodeURIComponent(deviceIdSync())}${userParam()}`;
}

/** Spends import energy on the tap and refreshes the meter afterwards. */
export const importPodcastEpisode = (...args: Parameters<typeof importPodcastEpisodeRaw>): ReturnType<typeof importPodcastEpisodeRaw> => withEnergy('import', () => importPodcastEpisodeRaw(...args));
