/**
 * Reads a YouTube caption track on the phone. The server IP is blocked by
 * YouTube, the phone's is not, so the app fetches the raw json3 events and
 * posts them to the backend, which parses and validates them. All page
 * parsing lives in this one file so a YouTube change is a local fix.
 *
 * Two tracks matter: the picked one (manual in the language when it exists)
 * is the text, and the automatic one (`kind: "asr"`) carries a `tOffsetMs`
 * per token, the word onsets the backend transfers onto the manual text.
 */

export type Json3Event = {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: { utf8?: string; tOffsetMs?: number }[];
};

export type CaptionsErrorCode = 'no_captions' | 'captions_blocked' | 'captions_failed';

export class CaptionsError extends Error {
  code: CaptionsErrorCode;
  constructor(code: CaptionsErrorCode) {
    super(code);
    this.code = code;
  }
}

type Track = { baseUrl: string; languageCode: string; kind?: string };

/** What the watch page knows about the video, sent along with an import so
 * the backend's repair pass can fix the automatic captions against names,
 * places and products the creator wrote down. */ // youtube-asr-context-repair
export type VideoContext = {
  title: string;
  author: string;
  description: string;
  keywords: string[];
  chapters: { start_s: number; title: string }[];
};

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

function langMatch(t: Track, lang: string): boolean {
  return t.languageCode === lang || t.languageCode.startsWith(`${lang}-`);
}

/** Manual track in the language, else automatic in the language, else the first. */
export function pickTrack(tracks: Track[], lang: string): Track {
  return (
    tracks.find((t) => t.kind !== 'asr' && langMatch(t, lang)) ??
    tracks.find((t) => t.kind === 'asr' && langMatch(t, lang)) ??
    tracks[0]
  );
}

/** The automatic track in the language, or null when YouTube made none. */
export function asrTrack(tracks: Track[], lang: string): Track | null {
  return tracks.find((t) => t.kind === 'asr' && langMatch(t, lang)) ?? null;
}

function tracksOf(pr: any): Track[] {
  const list = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  return Array.isArray(list) ? list.filter((t) => t && typeof t.baseUrl === 'string') : [];
}

/** A description line of the form `[h:]m:ss title`, one chapter each. */
const CHAPTER_LINE = /^\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\s+(\S.*)$/;

export function chaptersFromDescription(description: string): VideoContext['chapters'] {
  const out: VideoContext['chapters'] = [];
  for (const line of description.split('\n')) {
    const m = CHAPTER_LINE.exec(line);
    if (!m) continue;
    const start_s = Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    out.push({ start_s, title: m[4].trim() });
  }
  return out;
}

/** The player response's `videoDetails` as a VideoContext, null when it has none. */
function contextOf(pr: any): VideoContext | null {
  const d = pr?.videoDetails;
  if (!d || typeof d !== 'object') return null;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const description = str(d.shortDescription);
  return {
    title: str(d.title),
    author: str(d.author),
    description,
    keywords: Array.isArray(d.keywords) ? d.keywords.filter((k: unknown) => typeof k === 'string') : [],
    chapters: chaptersFromDescription(description),
  };
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

/** The track's json3 events, or null when the body is empty or malformed. */
async function fetchJson3(track: Track, label: string): Promise<Json3Event[] | null> {
  try {
    const res = await fetch(`${track.baseUrl}&fmt=json3`, { headers: { 'User-Agent': DESKTOP_UA } });
    const body = await res.text();
    if (__DEV__) console.log(`[captions] ${label}`, res.status, 'len', body.length);
    if (!body.trim()) return null;
    const events = JSON.parse(body)?.events;
    return Array.isArray(events) && events.length > 0 ? events : null;
  } catch (e) {
    if (__DEV__) console.log(`[captions] ${label} threw`, String(e));
    return null;
  }
}

async function fetchEvents(track: Track): Promise<Json3Event[] | null> {
  if (__DEV__ && track.baseUrl.includes('exp=xpe')) console.log('[captions] baseUrl has exp=xpe (pot wall)');
  // 1) json3 (preferred: already segmented the way the backend wants).
  const events = await fetchJson3(track, 'json3');
  if (events) return events;
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

/** The automatic track's events that carry a per-token `tOffsetMs`. json3
 * only: the XML form has no token times, so there is no fallback. Null when
 * the body is empty or malformed, so the caller can tell "no onsets" from
 * "YouTube did not answer". */
async function fetchAsrEvents(track: Track): Promise<Json3Event[] | null> {
  const events = await fetchJson3(track, 'asr json3');
  if (!events) return null;
  return events.filter(
    (e) => e && Array.isArray(e.segs) && e.segs.some((s) => typeof s?.tOffsetMs === 'number'),
  );
}

/** The raw innertube player response for one client, or null. */
async function clientPlayer(
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

/** Walks the caption track lists in turn, the watch page then each player
 * client, until `tryList` answers true for one. The WEB URLs often return an
 * empty body (they need a proof-of-origin token); the player client URLs do
 * not. Reports the watch page's playability status, whether any list had a
 * track at all, for the error code, and the first player response's context. */
async function trackLists(
  videoId: string,
  tryList: (tracks: Track[]) => Promise<boolean>,
): Promise<{ status?: string; anyTracks: boolean; context: VideoContext | null }> {
  let pr = await loadWatchPage(videoId, false);
  if (!pr) pr = await loadWatchPage(videoId, true);
  const status = pr?.playabilityStatus?.status;
  const webTracks = pr ? tracksOf(pr) : [];
  let context = contextOf(pr);
  if (__DEV__) console.log('[captions] watch pr', !!pr, 'status', status, 'tracks', webTracks.length);
  let anyTracks = webTracks.length > 0;
  if (anyTracks && (await tryList(webTracks))) return { status, anyTracks, context };
  for (const cfg of PLAYER_CLIENTS) {
    const cpr = await clientPlayer(videoId, cfg);
    const tracks = cpr ? tracksOf(cpr) : [];
    if (!context) context = contextOf(cpr);
    if (__DEV__) console.log('[captions]', cfg.client.clientName, 'tracks', tracks.length);
    if (tracks.length === 0) continue;
    anyTracks = true;
    if (await tryList(tracks)) break;
  }
  return { status, anyTracks, context };
}

/** The picked track's events plus, when that track is manual, the automatic
 * track's events with token onsets (`asrEvents`, empty when YouTube has no
 * automatic track in the language or it did not answer), and the video's
 * context (null when no player response carried it). */
export async function fetchCaptions(
  videoId: string,
  lang: string,
): Promise<{
  events: Json3Event[];
  trackLang: string;
  auto: boolean;
  asrEvents: Json3Event[];
  context: VideoContext | null;
}> {
  try {
    // A holder, not a `let`: TS keeps a closure-assigned local narrowed to null.
    const got: { result: { events: Json3Event[]; track: Track; asrEvents: Json3Event[] } | null } = { result: null };
    const { status, anyTracks, context } = await trackLists(videoId, async (tracks) => {
      const track = pickTrack(tracks, lang);
      if (__DEV__) console.log('[captions] picked', track.languageCode, track.kind || 'manual');
      const events = await fetchEvents(track);
      if (!events) return false;
      let asrEvents: Json3Event[] = [];
      if (track.kind !== 'asr') {
        const asr = asrTrack(tracks, lang);
        asrEvents = (asr && (await fetchAsrEvents(asr))) || [];
      }
      got.result = { events, track, asrEvents };
      return true;
    });

    if (!got.result) {
      if (!anyTracks) {
        throw new CaptionsError(
          status === 'LOGIN_REQUIRED' || status === 'UNPLAYABLE' ? 'captions_blocked' : 'no_captions',
        );
      }
      throw new CaptionsError('captions_failed');
    }
    const { events, track, asrEvents } = got.result;
    if (__DEV__) console.log('[captions] events', events.length, 'asr events', asrEvents.length);
    return {
      events: events.filter((e) => e && e.segs),
      trackLang: track.languageCode,
      auto: track.kind === 'asr',
      asrEvents,
      context,
    };
  } catch (e) {
    if (__DEV__) console.log('[captions] fail', String(e));
    if (e instanceof CaptionsError) throw e;
    throw new CaptionsError('captions_failed');
  }
}

/** The automatic track's events with token onsets, for an island built before
 * the timing sync existed. `[]` when YouTube lists tracks but no automatic one
 * in the language (the server then closes the job as `asr_none`), null when
 * nothing answered (offline, blocked, CORS on web): the next open retries. */
export async function fetchAsrCaptions(videoId: string, lang: string): Promise<Json3Event[] | null> {
  try {
    const got: { found: Json3Event[] | null; sawTrack: boolean } = { found: null, sawTrack: false };
    const { anyTracks } = await trackLists(videoId, async (tracks) => {
      const asr = asrTrack(tracks, lang);
      if (!asr) return false;
      got.sawTrack = true;
      got.found = await fetchAsrEvents(asr);
      return got.found !== null;
    });
    if (__DEV__) console.log('[captions] asr events', got.found === null ? 'none' : got.found.length);
    if (got.found !== null) return got.found;
    return anyTracks && !got.sawTrack ? [] : null;
  } catch (e) {
    if (__DEV__) console.log('[captions] asr fail', String(e));
    return null;
  }
}

/** The video's context for an island built before the repair pass existed:
 * the watch page, then the player clients. Null when nothing answered
 * (offline, blocked, CORS on web): the next open retries. */
export async function fetchVideoContext(videoId: string): Promise<VideoContext | null> {
  try {
    const { context } = await trackLists(videoId, async () => true);
    if (__DEV__) console.log('[captions] context', context ? `title "${context.title}"` : 'none');
    return context;
  } catch (e) {
    if (__DEV__) console.log('[captions] context fail', String(e));
    return null;
  }
}
