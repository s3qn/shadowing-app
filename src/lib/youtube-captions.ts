/**
 * Reads a YouTube caption track on the phone. The server IP is blocked by
 * YouTube, the phone's is not, so the app fetches the raw json3 events and
 * posts them to the backend, which parses and validates them. All page
 * parsing lives in this one file so a YouTube change is a local fix.
 */

export type Json3Event = { tStartMs?: number; dDurationMs?: number; segs?: { utf8?: string }[] };

export type CaptionsErrorCode = 'no_captions' | 'captions_blocked' | 'captions_failed';

export class CaptionsError extends Error {
  code: CaptionsErrorCode;
  constructor(code: CaptionsErrorCode) {
    super(code);
    this.code = code;
  }
}

type Track = { baseUrl: string; languageCode: string; kind?: string };

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const ANDROID_UA = 'com.google.android.youtube/20.10.38 (Linux; U; Android 14)';
const IOS_UA = 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_0 like Mac OS X)';
const MARKER = 'ytInitialPlayerResponse = ';

/** Player clients whose timedtext URLs return content without a proof-of-origin
 * token, unlike the WEB client. Tried in order when the WEB URL comes back empty. */
const PLAYER_CLIENTS = [
  {
    ua: IOS_UA,
    client: {
      clientName: 'IOS',
      clientVersion: '20.10.4',
      deviceMake: 'Apple',
      deviceModel: 'iPhone16,2',
      osName: 'iPhone',
      osVersion: '18.3.2.22D82',
      hl: 'en',
      gl: 'US',
    },
  },
  {
    ua: ANDROID_UA,
    client: {
      clientName: 'ANDROID',
      clientVersion: '20.10.38',
      androidSdkVersion: 34,
      osName: 'Android',
      osVersion: '14',
      hl: 'en',
      gl: 'US',
    },
  },
] as const;

// --- bl36-align ---
const ANDROID_VR_UA =
  'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip';

/** Stream clients for the audio download, best first. android_vr serves plain
 * urls without a PO token; ios and android are cheap fallbacks. */
export const AUDIO_CLIENTS = [
  {
    name: 'android_vr',
    ua: ANDROID_VR_UA,
    client: {
      clientName: 'ANDROID_VR',
      clientVersion: '1.65.10',
      deviceMake: 'Oculus',
      deviceModel: 'Quest 3',
      androidSdkVersion: 32,
      osName: 'Android',
      osVersion: '12L',
      hl: 'en',
      gl: 'US',
    },
  },
  { name: 'ios', ua: PLAYER_CLIENTS[0].ua, client: PLAYER_CLIENTS[0].client },
  { name: 'android', ua: PLAYER_CLIENTS[1].ua, client: PLAYER_CLIENTS[1].client },
] as const;
// --- /bl36-align ---

/** The ytInitialPlayerResponse object out of a watch page, or null. Braces
 * inside JSON strings do not count toward the match. */
export function extractPlayerResponse(html: string): any | null {
  const at = html.indexOf(MARKER);
  if (at < 0) return null;
  const first = html.indexOf('{', at);
  if (first < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = first; i < html.length; i++) {
    const c = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(first, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Manual track in the language, else automatic in the language, else the first. */
export function pickTrack(tracks: Track[], lang: string): Track {
  const match = (t: Track) => t.languageCode === lang || t.languageCode.startsWith(`${lang}-`);
  return (
    tracks.find((t) => t.kind !== 'asr' && match(t)) ??
    tracks.find((t) => t.kind === 'asr' && match(t)) ??
    tracks[0]
  );
}

function tracksOf(pr: any): Track[] {
  const list = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  return Array.isArray(list) ? list.filter((t) => t && typeof t.baseUrl === 'string') : [];
}

async function loadWatchPage(videoId: string, withConsent: boolean): Promise<any | null> {
  const headers: Record<string, string> = { 'User-Agent': DESKTOP_UA, 'Accept-Language': 'en-US,en;q=0.9' };
  if (withConsent) headers.Cookie = 'CONSENT=YES+1; SOCS=CAI';
  const res = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en&gl=US`, { headers });
  const html = await res.text();
  if (res.url.includes('consent.youtube.com')) return null;
  return extractPlayerResponse(html);
}

/** Decode the handful of XML entities that appear in caption text. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/** YouTube's default (no-fmt) timedtext is XML: <text start="s" dur="s">line</text>.
 * Map it to the same json3 event shape the backend expects (ms + segs). */
function xmlToEvents(xml: string): Json3Event[] | null {
  const out: Json3Event[] = [];
  const re = /<text([^>]*)>([\s\S]*?)<\/text>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const attrs = m[1];
    const start = /start="([\d.]+)"/.exec(attrs);
    const dur = /dur="([\d.]+)"/.exec(attrs);
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, '')).trim();
    if (!text) continue;
    out.push({
      tStartMs: start ? Math.round(parseFloat(start[1]) * 1000) : 0,
      dDurationMs: dur ? Math.round(parseFloat(dur[1]) * 1000) : 0,
      segs: [{ utf8: text }],
    });
  }
  return out.length > 0 ? out : null;
}

async function fetchEvents(track: Track): Promise<Json3Event[] | null> {
  if (__DEV__ && track.baseUrl.includes('exp=xpe')) console.log('[captions] baseUrl has exp=xpe (pot wall)');
  // 1) json3 (preferred: already segmented the way the backend wants).
  try {
    const res = await fetch(`${track.baseUrl}&fmt=json3`, { headers: { 'User-Agent': DESKTOP_UA } });
    const body = await res.text();
    if (__DEV__) console.log('[captions] json3', res.status, 'len', body.length);
    if (body.trim()) {
      const events = JSON.parse(body)?.events;
      if (Array.isArray(events) && events.length > 0) return events;
    }
  } catch (e) {
    if (__DEV__) console.log('[captions] json3 threw', String(e));
  }
  // 2) Fallback: plain XML. YouTube often returns an empty json3 body without a
  // token, but the default timedtext XML still comes back. Same shape out.
  try {
    const res = await fetch(track.baseUrl, { headers: { 'User-Agent': DESKTOP_UA } });
    const body = await res.text();
    if (__DEV__) console.log('[captions] xml', res.status, 'len', body.length);
    if (body.trim()) return xmlToEvents(body);
  } catch (e) {
    if (__DEV__) console.log('[captions] xml threw', String(e));
  }
  return null;
}

/** The raw innertube player response for one client, or null. Serves captions
 * (clientTracks) and the audio stream list (video-audio.ts). */
export async function clientPlayer(
  videoId: string,
  cfg: { ua: string; client: Record<string, unknown> },
): Promise<any | null> {
  try {
    const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      headers: { 'User-Agent': cfg.ua, 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: { client: cfg.client }, videoId, contentCheckOk: true, racyCheckOk: true }),
    });
    return await res.json();
  } catch {
    return null;
  }
}

async function clientTracks(
  videoId: string,
  cfg: { ua: string; client: Record<string, unknown> },
): Promise<Track[]> {
  const pr = await clientPlayer(videoId, cfg);
  return pr ? tracksOf(pr) : [];
}

export async function fetchCaptions(
  videoId: string,
  lang: string,
): Promise<{ events: Json3Event[]; trackLang: string; auto: boolean }> {
  try {
    let pr = await loadWatchPage(videoId, false);
    if (!pr) pr = await loadWatchPage(videoId, true);
    const status = pr?.playabilityStatus?.status;
    const webTracks = pr ? tracksOf(pr) : [];
    if (__DEV__) console.log('[captions] watch pr', !!pr, 'status', status, 'tracks', webTracks.length);

    // Try each caption source in turn. The WEB URL often returns an empty body
    // (needs a proof-of-origin token); the ANDROID/IOS player client URLs do not.
    let anyTracks = false;
    const tryTracks = async (tracks: Track[]): Promise<{ events: Json3Event[]; track: Track } | null> => {
      if (tracks.length === 0) return null;
      anyTracks = true;
      const track = pickTrack(tracks, lang);
      if (__DEV__) console.log('[captions] picked', track.languageCode, track.kind || 'manual');
      const events = await fetchEvents(track);
      return events ? { events, track } : null;
    };

    let result = await tryTracks(webTracks);
    for (const cfg of PLAYER_CLIENTS) {
      if (result) break;
      const tracks = await clientTracks(videoId, cfg);
      if (__DEV__) console.log('[captions]', cfg.client.clientName, 'tracks', tracks.length);
      result = await tryTracks(tracks);
    }

    if (!result) {
      if (!anyTracks) {
        throw new CaptionsError(
          status === 'LOGIN_REQUIRED' || status === 'UNPLAYABLE' ? 'captions_blocked' : 'no_captions',
        );
      }
      throw new CaptionsError('captions_failed');
    }
    if (__DEV__) console.log('[captions] events', result.events.length);
    const { events, track } = result;
    return { events: events.filter((e) => e && e.segs), trackLang: track.languageCode, auto: track.kind === 'asr' };
  } catch (e) {
    if (__DEV__) console.log('[captions] fail', String(e));
    if (e instanceof CaptionsError) throw e;
    throw new CaptionsError('captions_failed');
  }
}
