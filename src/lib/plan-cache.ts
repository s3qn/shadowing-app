/**
 * The newest default session plan, fetched when Home gains focus so the review
 * screen opens on it instead of its loader. Read without being consumed and
 * short lived: review.tsx still revalidates on every focus, so a stale plan
 * shows for one fetch at most. Memory only, like the island memory copy.
 */
import * as api from '@/lib/api';
import { getSessionPrefs } from '@/lib/auto-practice';
import { getSettingsSync, sessionLanguage } from '@/lib/settings';

const TTL_MS = 60 * 1000;
let held: { size: number; language: string | undefined; at: number; plan: api.SessionPlan } | null = null;

/** The cached default plan for this size and language, or null when none is fresh. */
export function peekSessionPlan(size: number): api.SessionPlan | null {
  if (!held || held.size !== size || held.language !== sessionLanguage() || Date.now() - held.at > TTL_MS) return null;
  return held.plan;
}

/** Fetches the plan review.tsx will ask for (saved size, saved project order) and keeps it. Never throws. */
export async function prefetchSessionPlan() {
  try {
    const size = getSettingsSync().sessionSize;
    const language = sessionLanguage();
    const { order } = await getSessionPrefs();
    const plan = await api.getSessionPlan(size, { order, language, catalogue: true });
    held = { size, language, at: Date.now(), plan };
  } catch {
    // Review loads its own plan, with its error page.
  }
}
