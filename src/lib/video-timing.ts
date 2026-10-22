import * as api from '@/lib/api';
import { fetchAsrCaptions, fetchVideoContext } from '@/lib/youtube-captions';

/** One running job per key: a second caller gets the running promise. */
const inflight = new Map<string, Promise<unknown>>();

function singleFlight<T>(key: string, run: () => Promise<T>): Promise<T> {
  const running = inflight.get(key) as Promise<T> | undefined;
  if (running) return running;
  const job = run().finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

/** Fetch the video's automatic caption track on the phone (the server IP is
 * blocked by YouTube) and hand it to the backend, which moves the lines onto
 * the ASR word onsets. Single flight per island. True once the server queued
 * the job. False when YouTube did not answer (the next open retries) or the
 * server declined (busy, closed, not deployed yet). Every failure is
 * swallowed: the island plays with its current timing. */
export function syncVideoTiming(islandId: string, videoId: string, lang: string): Promise<boolean> {
  return singleFlight(`align:${islandId}`, () => runSync(islandId, videoId, lang));
}

async function runSync(islandId: string, videoId: string, lang: string): Promise<boolean> {
  const events = await fetchAsrCaptions(videoId, lang);
  if (events === null) return false;
  // An empty list is posted too: the server closes the job as `asr_none`
  // instead of the app fetching the track lists again on every open.
  try {
    const r = await api.postCaptionTiming(islandId, events);
    if (__DEV__) console.log('[video-timing] align: ' + r.align);
    return r.align === 'queued';
  } catch (e) {
    if (__DEV__) console.log('[video-timing] post failed', String(e));
    return false;
  }
}

/** Fetch the video's context (title, author, description, keywords,
 * chapters) on the phone and hand it to the backend, which repairs the
 * automatic captions against it. Single flight per island. The server's
 * answer (`queued`, `running` or `done`), or null when YouTube did not
 * answer or the server declined: the island plays with its current text and
 * the next open retries. */ // youtube-asr-context-repair
export function syncVideoRepair(islandId: string, videoId: string): Promise<string | null> {
  return singleFlight(`repair:${islandId}`, () => runRepair(islandId, videoId));
}

async function runRepair(islandId: string, videoId: string): Promise<string | null> {
  const context = await fetchVideoContext(videoId);
  if (context === null) return null;
  try {
    const r = await api.postVideoRepair(islandId, context);
    if (__DEV__) console.log('[video-timing] repair: ' + r.repair);
    return r.repair;
  } catch (e) {
    if (__DEV__) console.log('[video-timing] repair post failed', String(e));
    return null;
  }
}
