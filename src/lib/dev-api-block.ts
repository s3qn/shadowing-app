// --- ai-guardrails ---
// Dev only: makes the next build or import request answer like a real budget
// or kill-switch block, without touching the network. Cleared by resetSimulation().
export type DevApiBlock = 'daily_budget' | 'ai_paused';

let block: DevApiBlock | null = null;

export function setDevApiBlock(next: DevApiBlock | null): void {
  if (__DEV__) block = next;
}

export function devApiBlock(): DevApiBlock | null {
  return __DEV__ ? block : null;
}

const BUILD_PATH = /\/(islands|islands\/import|islands\/[^/?]+\/regenerate|youtube\/captions|podcasts\/import|phrases\/import|grammar\/import)(\?|$)/;

/** A synthetic error response for a POST build or import while a block is simulated, else null. */
export function devBlockedResponse(input: unknown, init?: { method?: string }): Response | null {
  const code = devApiBlock();
  if (!code || init?.method !== 'POST') return null;
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : ((input as { url?: string })?.url ?? '');
  if (!BUILD_PATH.test(url)) return null;
  return new Response(JSON.stringify({ detail: { code } }), { status: code === 'ai_paused' ? 503 : 429 });
}
