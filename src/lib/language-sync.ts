/**
 * Keeping the two languages together, or letting them part on purpose.
 *
 * The app has an interface language and an understood language, and most
 * people mean them as one choice. Changing either one writes straight to
 * settings, as it always did; this module adds the one question worth asking:
 * when the two currently match and the change would split them, it offers to
 * move the other one along. If they already differ, that was deliberate and
 * nothing is asked.
 *
 * The understood language only reaches new islands. Every island stores the
 * language it was built with and keeps its own translations, so the prompt
 * says so rather than implying anything is retranslated.
 */

import { confirmSheet } from '@/lib/confirm-sheet';
import { LOCALES, type Lang, resolveAppLanguage, t } from '@/lib/i18n';
import { getLanguage } from '@/lib/languages';
import {
  type AppLanguage,
  getSettingsSync,
  type Settings,
  setAppLanguage,
  setUnderstoodLanguage,
  type UnderstoodLanguage,
} from '@/lib/settings';
import { type Key } from '@/locales/en';

/** Whether the interface exists in this language at all. The catalogue has
 * fifteen understandable languages to the interface's two, so an understood
 * pick the interface has no catalogue for leaves nothing to ask about. */
function hasInterface(id: string): id is Lang {
  return id in LOCALES;
}

/** The two languages read as one pick right now. Every prompt here fires
 * only at the moment that stops being true. */
function paired(before: Settings): boolean {
  return resolveAppLanguage(before) === before.understoodLanguage;
}

function languageName(id: string): string {
  return t(`language.${id}` as Key);
}

/**
 * Writes the interface language, then asks whether translations should
 * follow. The question is asked after the write, so it is phrased in the
 * language just picked, which is what the whole screen is showing by then.
 */
export async function applyAppLanguage(next: AppLanguage): Promise<void> {
  const before = getSettingsSync();
  await setAppLanguage(next);
  // 'auto' follows the understood language, so it closes the gap instead of
  // opening one.
  if (!hasInterface(next)) return;
  if (!paired(before) || next === before.understoodLanguage) return;
  if (!getLanguage(next)?.understandable) return;
  // Settings > Language never lets one language be both learned and
  // understood, so do not offer a move its own pair rule would undo.
  if (next === before.learningLanguage) return;
  const pick = await confirmSheet({
    title: t('settings.langPair.translationsTitle'),
    message: t('settings.langPair.translationsBody', { lang: languageName(next), other: languageName(before.understoodLanguage) }),
    actions: [
      { label: t('common.cancel'), verb: 'tools' },
      { label: t('common.ok'), verb: 'tools' },
    ],
  });
  if (pick === 1) await setUnderstoodLanguage(next);
}

/**
 * Writes the understood language, then asks whether the interface should
 * follow. Nothing is asked while the interface is on 'auto': it already
 * followed along.
 */
export async function applyUnderstoodLanguage(next: UnderstoodLanguage): Promise<void> {
  const before = getSettingsSync();
  await setUnderstoodLanguage(next);
  // `setUnderstoodLanguage` drops a pick the app cannot explain in, and then
  // nothing changed, so there is nothing to ask about either.
  if (!getLanguage(next)?.understandable) return;
  if (!hasInterface(next)) {
    // The interface has no catalogue in this language, so there is nothing to
    // offer. Keep it on what it is showing: left on 'auto' it would follow the
    // new pick, find nothing, and fall back to English underneath the person.
    if (before.appLanguage === 'auto') await setAppLanguage(resolveAppLanguage(before));
    return;
  }
  if (!paired(before)) return;
  const stays = resolveAppLanguage({ ...before, understoodLanguage: next });
  if (stays === next) return;
  const pick = await confirmSheet({
    title: t('settings.langPair.appTitle'),
    message: t('settings.langPair.appBody', { lang: languageName(next), other: languageName(stays) }),
    actions: [
      { label: t('common.cancel'), verb: 'tools' },
      { label: t('common.ok'), verb: 'tools' },
    ],
  });
  if (pick === 1) await setAppLanguage(next);
}
