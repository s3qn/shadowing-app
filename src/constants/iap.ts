/**
 * support-packs: the three consumable ⚡ packs. The same table lives in
 * `backend/iap.py PACKS`; a change here is a change there too.
 */
export type Pack = { id: string; amount: number; usd_cents: number };

export const PACKS: readonly Pack[] = [
  { id: 'build.sean.echotail.energy300', amount: 300, usd_cents: 199 },
  { id: 'build.sean.echotail.energy1000', amount: 1000, usd_cents: 499 },
  { id: 'build.sean.echotail.energy2500', amount: 2500, usd_cents: 999 },
];

/** "$1.99": shown while the store has not answered with Apple's localized price. */
export function fallbackPrice(pack: Pack): string {
  return `$${(pack.usd_cents / 100).toFixed(2)}`;
}
