/**
 * Streak freezes: what the Streak sheet and the broken-streak moment need
 * to show the held count and sell one more. A freeze is bought here and
 * consumed by the server on its own when a day is missed (practice.ts
 * `streakDays` reads the result back from the progress snapshot).
 */

import { randomUUID } from 'expo-crypto';
import * as Haptics from 'expo-haptics';

import { buyStreakFreeze, type Progress } from '@/lib/api';
import { alertSheet, confirmSheet } from '@/lib/confirm-sheet';
import { hapticNotify } from '@/lib/haptics';
import { t } from '@/lib/i18n';
import { applyProgress, progressNow } from '@/lib/progression';

export type FreezeInfo = {
  held: number;
  cap: number;
  price: number;
  canBuy: boolean;
  /** Why the buy row is disabled, or null when it is enabled. */
  reason: 'cap' | 'coins' | null;
};

// Only for painting the rows before the first snapshot (or on an old server
// that sends no freeze fields): a snapshot's own price and cap always win,
// and nothing can be bought until one has loaded.
const FALLBACK_PRICE = 150;
const FALLBACK_CAP = 2;

export function freezeInfo(progress: Progress | null | undefined): FreezeInfo {
  const held = progress?.freezes_held ?? 0;
  const cap = progress?.freeze_cap ?? FALLBACK_CAP;
  const price = progress?.freeze_price ?? FALLBACK_PRICE;
  if (!progress) return { held, cap, price, canBuy: false, reason: 'coins' };
  const reason = held >= cap ? 'cap' : progress.coins < price ? 'coins' : null;
  return { held, cap, price, canBuy: reason === null, reason };
}

/**
 * Confirms, then buys one freeze. Resolves true when the server took the
 * coins (the progress cache already holds the new snapshot), false on
 * cancel or on an error (shown in its own sheet). Each tap sends a fresh
 * purchase id: the id only stops a resent request from charging twice, so
 * a second tap after a dropped reply buys a second freeze.
 */
export async function buyFreezeFlow(): Promise<boolean> {
  const progress = progressNow();
  const { price } = freezeInfo(progress);
  const choice = await confirmSheet({
    title: t('streak.buyTitle'),
    message: t('streak.buyBody', { price, coins: progress?.coins ?? 0 }),
    actions: [
      { label: t('streak.buyFor', { n: price }), verb: 'read' },
      { label: t('common.cancel'), verb: 'tools' },
    ],
  });
  if (choice !== 0) return false;
  try {
    const next = await buyStreakFreeze(randomUUID());
    applyProgress(next);
    void hapticNotify(Haptics.NotificationFeedbackType.Success);
    return true;
  } catch (e) {
    await alertSheet(t('streak.buyFailed'), e instanceof Error ? e.message : undefined);
    return false;
  }
}
