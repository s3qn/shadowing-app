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

/**
 * Injected into the embed page to switch YouTube's own captions off, since the
 * route draws the active line itself. `cc_load_policy=0` only means "do not
 * force on"; the viewer's stored preference or an uploader default still wins.
 * The player object exists before `onReady`, so it retries every 250ms for up
 * to 30s and keeps unloading for 3s after the first success, then stops.
 */
export const CC_OFF_SCRIPT = `
(function () {
  var tries = 0;
  var stopAt = 0;
  var timer = setInterval(function () {
    tries += 1;
    var p = window.player;
    if (p && typeof p.unloadModule === 'function') {
      try { p.unloadModule('captions'); } catch (e) {}
      try { p.unloadModule('cc'); } catch (e) {}
      if (!stopAt) stopAt = Date.now() + 3000;
    }
    if ((stopAt && Date.now() > stopAt) || tries > 120) clearInterval(timer);
  }, 250);
})();
true;
`;
