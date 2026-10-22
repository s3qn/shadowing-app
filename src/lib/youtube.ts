/** Pulls the 11 character video id out of a pasted YouTube link. Returns null
 * for anything that is not a youtube.com or youtu.be video link. */
const ID_RE = /^[A-Za-z0-9_-]{11}$/;
const HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);
const PATHS = ['shorts', 'live', 'embed', 'v'];

export function parseYouTubeId(text: string): string | null {
  const raw = text.trim();
  if (!raw || /\s/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);
  let id: string | undefined;
  if (host === 'youtu.be') id = parts[0];
  else if (HOSTS.has(host)) {
    if (parts[0] === 'watch') id = url.searchParams.get('v') ?? undefined;
    else if (parts[0] && PATHS.includes(parts[0])) id = parts[1];
  }
  return id && ID_RE.test(id) ? id : null;
}

export function watchUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${id}`;
}

export function thumbUrl(id: string): string {
  return `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
}

const BACK_CHANNEL_MAX_S = 1.2;
const BACK_CHANNEL_RE = /^[ぁ-ゖー]{1,3}$/;
const BACK_CHANNEL_STRIP_RE = /[、。！？!?…\s]/g;

/** A listener's back-channel (うん, そう, わあ, はい): at most 1.2 s and one to
 * three hiragana once punctuation is stripped. なるほど (four), 2時 (a digit)
 * and 大阪を (kanji) stay. The video screen hides these lines so the speaker's
 * card holds instead of blinking for half a second. */
export function isBackChannel(line: { ja: string; duration: number }): boolean {
  return line.duration <= BACK_CHANNEL_MAX_S && BACK_CHANNEL_RE.test(line.ja.replace(BACK_CHANNEL_STRIP_RE, ''));
}

/**
 * Injected into the embed page to switch YouTube's own captions off, since the
 * route draws the active line itself. `cc_load_policy=0` only means "do not
 * force on"; the viewer's stored preference or an uploader default still wins.
 * The player object exists before `onReady`, so it retries every 250ms until
 * it finds the player, then keeps unloading once a second for the life of the
 * page: YouTube loads the caption module again when playback starts or the
 * viewer seeks, which a 3s window missed.
 */
export const CC_OFF_SCRIPT = `
(function () {
  var timer = setInterval(function () {
    var p = window.player;
    if (!p || typeof p.unloadModule !== 'function') return;
    try { p.unloadModule('captions'); } catch (e) {}
    try { p.unloadModule('cc'); } catch (e) {}
    try { p.setOption('captions', 'track', {}); } catch (e) {}
    clearInterval(timer);
    timer = setInterval(function () {
      try { p.unloadModule('captions'); } catch (e) {}
      try { p.unloadModule('cc'); } catch (e) {}
    }, 1000);
  }, 250);
})();
true;
`;

/**
 * Injected into the embed page so the `play`, `mute` and `playbackRate` props
 * reach the player. react-native-youtube-iframe 2.4.1 posts
 * `{"eventName":"playVideo","meta":{}}` as JSON, but the hosted page it loads
 * (lonelycpp.github.io/.../iframe_v2.html) switches on the raw string
 * ("playVideo"), so none of those messages ever matched and `play={true}`
 * did nothing. Raw strings fail to parse here and stay with the page's own
 * handler, so nothing runs twice.
 */
export const PLAYER_BRIDGE_SCRIPT = `
(function () {
  window.addEventListener('message', function (event) {
    var msg;
    try { msg = JSON.parse(event.data); } catch (e) { return; }
    var p = window.player;
    if (!msg || typeof msg.eventName !== 'string' || !p) return;
    var meta = msg.meta || {};
    try {
      switch (msg.eventName) {
        case 'playVideo': p.playVideo(); break;
        case 'pauseVideo': p.pauseVideo(); break;
        case 'muteVideo': p.mute(); break;
        case 'unMuteVideo': p.unMute(); break;
        case 'setVolume': if (typeof meta.volume === 'number') p.setVolume(meta.volume); break;
        case 'setPlaybackRate': if (typeof meta.playbackRate === 'number') p.setPlaybackRate(meta.playbackRate); break;
      }
    } catch (e) {}
  });
})();
true;
`;

/** Landscape player size: full window height, width capped at 62% of the
 * window so the scene and dock keep a column on the right. */
export function fullscreenPlayerSize(win: { width: number; height: number }): { width: number; height: number } {
  return { width: Math.min((win.height * 16) / 9, win.width * 0.62), height: win.height };
}
