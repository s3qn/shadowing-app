/**
 * One place every haptic feedback call goes through, so the Haptics setting
 * turns all of them off at once instead of each call site checking it.
 */

import * as Haptics from 'expo-haptics';

import { getSettingsSync } from '@/lib/settings';

/**
 * Fires an impact haptic, unless the Haptics setting is off. Reads the
 * settings cache synchronously (kept current from app start, see
 * settings.ts) so a press-in handler can fire this without awaiting it.
 */
export async function hapticImpact(
  style: Haptics.ImpactFeedbackStyle = Haptics.ImpactFeedbackStyle.Light,
): Promise<void> {
  if (!getSettingsSync().hapticsEnabled) return;
  await Haptics.impactAsync(style);
}

/**
 * Fires the light selection tick used for a press-in, unless the Haptics
 * setting is off. Same synchronous settings read as hapticImpact.
 */
export async function hapticSelection(): Promise<void> {
  if (!getSettingsSync().hapticsEnabled) return;
  await Haptics.selectionAsync();
}
