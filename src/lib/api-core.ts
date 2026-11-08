// Request plumbing shared by every api domain file: auth params, headers,
// the error-aware json helper, and the config and health checks.
// Moved out of api.ts as a pure move.

import { loadAdminKey, proofFor } from '@/lib/admin-device';
import { accessTokenSync } from '@/lib/auth';
import { BASE, TOKEN, fetch } from '@/lib/api-http';
import { deviceIdSync } from '@/lib/device';
import { t } from '@/lib/i18n';
import { codeKey } from '@/lib/api-types';

/** The signed-in access token for URLs that cannot carry headers (the player,
 * Image), the same split the device id uses. Empty when signed out. */
export function userParam(): string {
  const user = accessTokenSync();
  return user ? `&user=${encodeURIComponent(user)}` : '';
}

/** Adds the current access token to a URL built by lineAudioUrl, at the
 * moment it is handed to the player or a download. The logical URL stays
 * token-free, so a token refresh does not look like a new source. */
export function withUser(url: string): string {
  return `${url}${userParam()}`;
}

export function headers(): Record<string, string> {
  const h: Record<string, string> = { Authorization: `Bearer ${TOKEN}`, 'X-Shadow-Device': deviceIdSync() };
  const user = accessTokenSync();
  if (user) h['X-Shadow-User'] = user;
  return h;
}

/** admin-device-bound: the headers plus this phone's signed proof, the one
 * place the proof is attached. `path` is the route without `/shadow`
 * (`/admin/beta`); `body` is the exact string the request sends ('' for
 * none). Without a key (web before first load, or a build without the
 * keychain module) the request goes out unsigned and the server answers
 * 403 `admin_device`. */
export async function adminHeaders(method: string, path: string, body = ''): Promise<Record<string, string>> {
  await loadAdminKey();
  const h = headers();
  const proof = proofFor(method, path, body);
  if (proof) h['X-Shadow-Proof'] = proof;
  return h;
}

/** A failed response: the readable message plus the HTTP status and the
 * server's `detail.code` when it sent one, for callers that branch on them. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/** Turns any failed response into a short, readable message. Gateway errors
 * (the tunnel could not reach the server) come back as full HTML pages, which
 * are useless on a phone screen. */
export async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // FastAPI sends `detail` as a plain string for developer errors, and as an
    // object carrying a code plus its values for anything a person reads. A
    // gateway error is neither: it arrives as a full HTML page.
    const detail = parseDetail(body);
    const code = detail && typeof detail === 'object' ? detail.code : null;
    if (detail && typeof detail === 'object') {
      const key = codeKey('api', detail.code);
      if (key) throw new ApiError(t(key, scalarsOf(detail)), res.status, code);
    }
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      throw new ApiError(t('api.unreachable'), res.status, code);
    }
    if (res.status === 429) {
      throw new ApiError(t('api.daily_limit_any'), res.status, code);
    }
    // A plain-string detail is English developer text: never shown, only the status.
    throw new ApiError(t('api.requestFailed', { status: res.status }), res.status, code);
  }
  return (await res.json()) as T;
}

/** The values a message can interpolate: `{limit}` and its like, never a
 * nested object. */
export function scalarsOf(detail: Record<string, unknown>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(detail)) {
    if (typeof value === 'string' || typeof value === 'number') out[name] = value;
  }
  return out;
}

/** The `detail` of a FastAPI error, when the body is JSON at all. */
export function parseDetail(body: string): string | ({ code: string } & Record<string, unknown>) | null {
  try {
    const parsed = JSON.parse(body) as { detail?: unknown };
    const detail = parsed.detail;
    if (typeof detail === 'string') return detail;
    if (detail && typeof detail === 'object' && typeof (detail as { code?: unknown }).code === 'string') {
      return detail as { code: string } & Record<string, unknown>;
    }
  } catch {
    // Not JSON: an HTML gateway page, or an empty body.
  }
  return null;
}

export function configured(): boolean {
  return BASE.length > 0 && TOKEN.length > 0;
}

export async function health(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/health`, { headers: headers() });
    return res.ok;
  } catch {
    return false;
  }
}
