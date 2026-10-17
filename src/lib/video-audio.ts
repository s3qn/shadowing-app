// --- bl36-align ---
import { File, Paths, Directory } from 'expo-file-system';
import * as api from '@/lib/api';
import { AUDIO_CLIENTS, clientPlayer } from '@/lib/youtube-captions';
import { pickAudioFormat } from '@/lib/youtube-audio';

const inflight = new Map<string, Promise<boolean>>();
const TIMEOUT_MS = 10 * 60 * 1000;

/** Fetch the video's audio on the phone (the server IP is blocked by YouTube)
 * and hand it to the backend for forced alignment. Single flight per island: a
 * second caller gets the running promise. True once the server queued the job.
 * Every failure is swallowed: the island works without it. */
export function syncVideoAudio(islandId: string, videoId: string): Promise<boolean> {
  const running = inflight.get(islandId);
  if (running) return running;
  const job = runSync(islandId, videoId).finally(() => inflight.delete(islandId));
  inflight.set(islandId, job);
  return job;
}

async function runSync(islandId: string, videoId: string): Promise<boolean> {
  let file: File | null = null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    for (const cfg of AUDIO_CLIENTS) {
      const t0 = Date.now();
      const fmt = pickAudioFormat(await clientPlayer(videoId, cfg));
      if (!fmt) {
        if (__DEV__) console.log('[video-audio] client=' + cfg.name + ' no format');
        continue;
      }
      try {
        const dir = new Directory(Paths.cache, 'video-audio');
        if (!dir.exists) dir.create();
        file = new File(dir, `${videoId}.${fmt.mimeType.startsWith('audio/mp4') ? 'm4a' : 'webm'}`);
        if (file.exists) file.delete();
        await File.downloadFileAsync(fmt.url, file, { headers: { 'User-Agent': cfg.ua }, signal: ctl.signal, idempotent: true });
        if (__DEV__) console.log(`[video-audio] client=${cfg.name} bytes=${file.size} ms=${Date.now() - t0}`);
      } catch (e) {
        if (__DEV__) console.log('[video-audio] client=' + cfg.name + ' failed', String(e));
        if (ctl.signal.aborted) return false;
        continue;
      }
      // The download worked, so another client would fetch the same audio. An
      // upload error (align_busy, align_closed, network) ends the sync here.
      try {
        const r = await api.uploadVideoAudio(islandId, file.uri);
        if (__DEV__) console.log('[video-audio] align: ' + r.align);
        return true;
      } catch (e) {
        if (__DEV__) console.log('[video-audio] upload failed', String(e));
        return false;
      }
    }
    return false;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    try {
      if (file?.exists) file.delete();
    } catch {}
  }
}
