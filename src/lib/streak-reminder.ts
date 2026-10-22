/**
 * The evening "Your streak is at risk" local notification (BL-80 part 2).
 *
 * At most one is pending at any time: today's at the picked hour if today
 * has not counted yet and a streak is running, or tomorrow's once today has
 * counted. Every practice flush, foreground or background change and
 * settings write re-plans it, so the count in the body is exact and today's
 * is cancelled the moment the 10th pass or the finished ladder lands.
 *
 * `expo-notifications` is a native module Expo Go, the web and any dev client
 * built before it do not have, so it is never imported at module load: a
 * static import would throw at bundle time and blank the whole app. See
 * `notifications()`.
 */
import { isRunningInExpoGo } from 'expo';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { AppState, Platform } from 'react-native';

import { alertSheet, confirmSheet, currentConfirm } from '@/lib/confirm-sheet';
import { getGuideStep } from '@/lib/guide';
import { t } from '@/lib/i18n';
import { isCelebrationOpen, isStreakMomentOpen } from '@/lib/level-up-store';
import { dayKey, dayQualifies, getPracticeLog, type PracticeLog, streakDays, subscribePracticeLog } from '@/lib/practice';
import { getSettings, getSettingsSync, setStreakReminder, setStreakReminderAsked, subscribeSettings } from '@/lib/settings';

type Notifications = typeof import('expo-notifications');
type PermissionStatus = Awaited<ReturnType<Notifications['getPermissionsAsync']>>;
type ScheduleRequest = Parameters<Notifications['scheduleNotificationAsync']>[0];

/**
 * Local notifications need a native module: a dev or release build, never Expo Go or the web. A dev
 * client built before expo-notifications lacks it too, and importing the JS there throws a red box
 * even inside a caught import, so the native module is checked first.
 */
export const REMINDERS_AVAILABLE =
  Platform.OS !== 'web' && !isRunningInExpoGo() && requireOptionalNativeModule('ExpoPushTokenManager') != null;

export type EnableResult = 'on' | 'denied' | 'unavailable';
export type PlannedReminder = { id: string; at: Date; count: number };

const CHANNEL_ID = 'streak';
const TEST_ID = 'streak-test';
/** Lets the practice card's odometer settle before the offer sheet rises. */
const OFFER_DELAY_MS = 800;
const TEST_DELAY_MS = 10_000;

let modPromise: Promise<Notifications | null> | null = null;

/** The module, loaded once on first use, or null where it cannot load (a failed import counts as unavailable). */
function notifications(): Promise<Notifications | null> {
  if (!REMINDERS_AVAILABLE) return Promise.resolve(null);
  if (!modPromise) {
    modPromise = import('expo-notifications')
      .then((mod) => {
        // A banner is fine when the learner is in the app at the hour and still has not practised.
        mod.setNotificationHandler({
          handleNotification: async () => ({
            shouldShowBanner: true,
            shouldShowList: true,
            shouldPlaySound: false,
            shouldSetBadge: false,
          }),
        });
        return mod;
      })
      .catch((err: unknown) => {
        console.warn('expo-notifications unavailable', err);
        return null;
      });
  }
  return modPromise;
}

function isGranted(mod: Notifications, status: PermissionStatus): boolean {
  if (status.granted) return true;
  // iOS is more granular than the root flag: the docs say to read `ios.status`.
  const ios = status.ios?.status;
  return ios === mod.IosAuthorizationStatus.AUTHORIZED || ios === mod.IosAuthorizationStatus.PROVISIONAL;
}

async function permitted(mod: Notifications): Promise<boolean> {
  return isGranted(mod, await mod.getPermissionsAsync());
}

/** Android 13 shows no permission prompt until a channel exists; a no-op elsewhere. */
async function ensureChannel(mod: Notifications): Promise<void> {
  if (Platform.OS !== 'android') return;
  await mod.setNotificationChannelAsync(CHANNEL_ID, {
    name: t('settings.streak.channel'),
    importance: mod.AndroidImportance.DEFAULT,
  });
}

/** Asks once if the learner has not decided yet; false once they have said no. */
async function ensurePermission(mod: Notifications): Promise<boolean> {
  await ensureChannel(mod);
  let status = await mod.getPermissionsAsync();
  if (!isGranted(mod, status) && status.canAskAgain) {
    status = await mod.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true, allowBadge: false } });
  }
  return isGranted(mod, status);
}

function content(count: number): ScheduleRequest['content'] {
  return {
    title: t('streak.notifyTitle'),
    body: t('streak.notifyBody', { count }),
    sound: true,
    data: { kind: 'streak' },
  };
}

/** Local `hour:00` on the day `dayOffset` days from `now`, the same boundary `dayKey` uses. */
function localHour(now: Date, hour: number, dayOffset = 0): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, hour, 0, 0);
}

/**
 * The reminders that should be pending at `now`: today's at `hour` when
 * today has not counted yet, a streak is running and the hour is still
 * ahead (count = the run ending yesterday); tomorrow's once today has
 * counted (count = the run including today); otherwise none, so a learner
 * with no streak has nothing to protect and one who ignores two evenings is
 * not nagged forever (the next finished day re-arms it).
 */
export function planStreakReminders(log: PracticeLog, hour: number, now: Date): PlannedReminder[] {
  const streak = streakDays(log, now);
  if (dayQualifies(log, dayKey(now))) {
    const at = localHour(now, hour, 1);
    return [{ id: `streak-${dayKey(at)}`, at, count: streak }];
  }
  const at = localHour(now, hour);
  if (streak >= 1 && at.getTime() > now.getTime()) {
    return [{ id: `streak-${dayKey(now)}`, at, count: streak }];
  }
  return [];
}

// Flushes happen every ~15 s of playback: native calls only run when the
// plan actually changed since the last sync in this process.
let lastPlanKey = '';
// Syncs run one at a time, so a flush and a foreground change cannot
// interleave their cancel and schedule calls.
let chain: Promise<void> = Promise.resolve();

async function runSync(log: PracticeLog | undefined): Promise<void> {
  const mod = await notifications();
  if (!mod) return;
  const settings = getSettingsSync();
  const now = new Date();
  const current = log ?? (await getPracticeLog());
  const on = settings.streakReminder && (await permitted(mod));
  const plan = on ? planStreakReminders(current, settings.streakReminderHour, now) : [];
  const key = JSON.stringify([on, settings.streakReminderHour, plan.map((p) => [p.id, p.at.getTime(), p.count])]);
  if (key === lastPlanKey) return;
  // Yesterday's, today's and tomorrow's ids cover every entry an earlier
  // plan can have left; cancelling a missing id is a no-op.
  for (const offset of [-1, 0, 1]) {
    await mod.cancelScheduledNotificationAsync(`streak-${dayKey(localHour(now, 0, offset))}`);
  }
  if (plan.length > 0) await ensureChannel(mod);
  for (const entry of plan) {
    await mod.scheduleNotificationAsync({
      identifier: entry.id,
      content: content(entry.count),
      trigger: { type: mod.SchedulableTriggerInputTypes.DATE, date: entry.at, channelId: CHANNEL_ID },
    });
  }
  lastPlanKey = key;
}

/** Re-plans the pending reminder from the log (read if not given) and the settings. Idempotent, never rejects. */
export function syncStreakReminder(log?: PracticeLog): Promise<void> {
  chain = chain
    .then(() => runSync(log))
    .catch((err: unknown) => {
      console.warn('syncStreakReminder failed', err);
    });
  return chain;
}

let started = false;

/**
 * Called once at launch after the settings are read: syncs now, after every
 * practice flush, on every foreground (a day rollover while backgrounded)
 * and background (a session that ended in the player), and when the toggle
 * or the hour changes.
 */
export function startStreakReminderSync(): void {
  if (started || !REMINDERS_AVAILABLE) return;
  started = true;
  void syncStreakReminder();
  subscribePracticeLog((log) => void syncStreakReminder(log));
  AppState.addEventListener('change', (state) => {
    if (state === 'active' || state === 'background') void syncStreakReminder();
  });
  let lastSettingsKey = '';
  subscribeSettings(() => {
    const s = getSettingsSync();
    const key = `${s.streakReminder}:${s.streakReminderHour}`;
    if (key === lastSettingsKey) return;
    lastSettingsKey = key;
    void syncStreakReminder();
  });
}

/** Turns the reminder on, asking for permission in context first. The caller shows the alert for 'denied' and 'unavailable'. */
export async function enableStreakReminder(): Promise<EnableResult> {
  const mod = await notifications();
  if (!mod) return 'unavailable';
  try {
    if (!(await ensurePermission(mod))) return 'denied';
  } catch (err: unknown) {
    // A thrown native call means a binary without the module, most likely.
    console.warn('enableStreakReminder failed', err);
    return 'unavailable';
  }
  await setStreakReminder(true);
  await syncStreakReminder();
  return 'on';
}

/** Settings tab focus: a reminder left on after notifications were revoked in the phone's Settings is turned off, so the switch tells the truth. */
export async function reconcileStreakReminder(): Promise<void> {
  try {
    if (!(await getSettings()).streakReminder) return;
    const mod = await notifications();
    if (!mod) return;
    if (!(await permitted(mod))) await setStreakReminder(false);
  } catch (err: unknown) {
    console.warn('reconcileStreakReminder failed', err);
  }
}

let offerPending = false;

/**
 * Home's focus effect, with the log it just read: on the first day that
 * counts, once per install, offers the reminder in a confirm sheet after a
 * short delay. Waits for a later focus while the guide, a session
 * celebration, a streak moment or another sheet is up. Any answer, including a dismiss,
 * counts as asked; Settings remains the way back in.
 */
export function maybeOfferStreakReminder(log: PracticeLog): void {
  if (!REMINDERS_AVAILABLE || offerPending) return;
  const settings = getSettingsSync();
  if (settings.streakReminderAsked || settings.streakReminder) return;
  if (getGuideStep() !== 'done' || isCelebrationOpen() || isStreakMomentOpen() || currentConfirm() !== null) return;
  if (!dayQualifies(log, dayKey(new Date()))) return;
  offerPending = true;
  setTimeout(() => {
    void (async () => {
      try {
        // Re-checked after the wait: a celebration, a streak moment or another sheet may have opened meanwhile.
        if (getSettingsSync().streakReminderAsked || isCelebrationOpen() || isStreakMomentOpen() || currentConfirm() !== null) return;
        const pick = await confirmSheet({
          title: t('streak.offerTitle'),
          message: t('streak.offerBody', { hour: getSettingsSync().streakReminderHour }),
          actions: [
            { label: t('streak.offerNo'), verb: 'tools' },
            { label: t('streak.offerYes'), verb: 'listen' },
          ],
        });
        await setStreakReminderAsked(true);
        if (pick !== 1) return;
        const result = await enableStreakReminder();
        if (result === 'denied') void alertSheet(t('settings.streak.permissionOff'));
        else if (result === 'unavailable') void alertSheet(t('settings.streak.needsBuild'));
      } finally {
        offerPending = false;
      }
    })();
  }, OFFER_DELAY_MS);
}

/** Dev only: the real copy in 10 s, so the glyph, channel and count can be checked on a locked phone. */
export async function scheduleTestReminder(): Promise<EnableResult> {
  const mod = await notifications();
  if (!mod) return 'unavailable';
  try {
    if (!(await ensurePermission(mod))) return 'denied';
    const count = Math.max(streakDays(await getPracticeLog(), new Date()), 1);
    await mod.scheduleNotificationAsync({
      identifier: TEST_ID,
      content: content(count),
      trigger: { type: mod.SchedulableTriggerInputTypes.DATE, date: new Date(Date.now() + TEST_DELAY_MS), channelId: CHANNEL_ID },
    });
    return 'on';
  } catch (err: unknown) {
    console.warn('scheduleTestReminder failed', err);
    return 'unavailable';
  }
}
