import { t } from '@/lib/i18n';

/** Under this many seconds the line counts seconds in 10 s steps. */
const SECONDS_BELOW = 90;

/** The line under the build loader. Null when the server sent no estimate
 * (old backend, or a kind with no media length): the caller keeps its old hint. */
export function etaText(etaS: number | null | undefined): string | null {
  if (typeof etaS !== 'number') return null;
  if (etaS <= 0) return t('eta.overrun');
  if (etaS < SECONDS_BELOW) return t('eta.seconds', { count: Math.max(10, Math.round(etaS / 10) * 10) });
  return t('eta.minutes', { count: Math.round(etaS / 60) });
}

/** Short form for the Home card, e.g. "~7 min". Null without an estimate. */
export function etaShort(etaS: number | null | undefined): string | null {
  if (typeof etaS !== 'number' || etaS <= 0) return null;
  return t('eta.short', { count: Math.max(1, Math.round(etaS / 60)) });
}
