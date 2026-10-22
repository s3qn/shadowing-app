import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withDelay, withSequence, withTiming } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PILL_TAB_BAR_REACH } from '@/components/pill-tab-bar';
import { Segmented } from '@/components/segmented';
import { SettingsRow, SettingsSection } from '@/components/tide/settings-row';
import { Spacing, prism, tide } from '@/constants/theme';
import { alertSheet, confirmSheet } from '@/lib/confirm-sheet';
import * as api from '@/lib/api';
import { provider, signOut, signOutLocal, usingDevBypass } from '@/lib/auth';
import { getGuideStep } from '@/lib/guide';
import { LOCALES, type Lang, useT } from '@/lib/i18n';
import { voiceRowLabel } from '@/lib/voice-label';
import {
  type AppLanguage,
  getSettings,
  getSettingsSync,
  getVoice,
  setHaptics,
  setShowAllLanguages,
  setSkyAlwaysNight,
  setStreakReminder,
  setStreakReminderHour,
  STREAK_REMINDER_HOURS,
  toIslandLanguage,
} from '@/lib/settings';
import { type EnableResult, enableStreakReminder, reconcileStreakReminder, scheduleTestReminder } from '@/lib/streak-reminder';

export default function SettingsScreen() {
  const router = useRouter();
  const { t } = useT();
  const [voiceName, setVoiceName] = useState('');
  const [isJapanese, setIsJapanese] = useState(true);
  const [haptics, setHapticsState] = useState(true);
  const [skyAlwaysNight, setSkyAlwaysNightState] = useState(false);
  // languages: Home's show-all toggle, default off.
  const [showAllLanguages, setShowAllLanguagesState] = useState(false);
  const [appLanguage, setAppLanguageState] = useState<AppLanguage>('auto');
  const [username, setUsernameState] = useState<string | null | undefined>(undefined);
  // Streak reminder: the switch only turns on once permission is granted.
  const [streakOn, setStreakOnState] = useState(false);
  const [streakHour, setStreakHourState] = useState(20);
  const streakBusy = useRef(false);

  async function confirmSignOut() {
    try {
      await signOut();
      router.push('/sign-in');
    } catch (err: unknown) {
      void alertSheet(t('settings.account.failed'), err instanceof Error ? err.message : '');
    }
  }

  async function confirmDeleteAccount() {
    const pick = await confirmSheet({
      title: t('settings.account.deleteTitle'),
      message: t('settings.account.deleteBody'),
      actions: [
        { label: t('common.cancel'), verb: 'tools' },
        { label: t('settings.account.deleteConfirm'), verb: 'speak', destructive: true },
      ],
    });
    if (pick !== 1) return;
    try {
      await api.deleteAccount();
      await signOutLocal();
      router.push('/sign-in');
    } catch (err: unknown) {
      void alertSheet(err instanceof Error ? err.message : t('settings.account.failed'));
    }
  }

  // 'denied' and 'unavailable' explain themselves in an alert; the switch stays off.
  function explainReminder(result: EnableResult) {
    if (result === 'denied') void alertSheet(t('settings.streak.permissionOff'));
    else if (result === 'unavailable') void alertSheet(t('settings.streak.needsBuild'));
  }

  async function toggleStreakReminder(next: boolean) {
    if (!next) {
      setStreakOnState(false);
      await setStreakReminder(false);
      return;
    }
    // A second tap while the system prompt is up must not ask twice.
    if (streakBusy.current) return;
    streakBusy.current = true;
    try {
      const result = await enableStreakReminder();
      setStreakOnState(result === 'on');
      explainReminder(result);
    } finally {
      streakBusy.current = false;
    }
  }

  const hourChoices = STREAK_REMINDER_HOURS.map((h) => ({ value: String(h), label: `${h}:00` }));

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      // Permission revoked in the phone's Settings turns the reminder off, so the switch tells the truth.
      void reconcileStreakReminder().then(() => {
        if (alive) setStreakOnState(getSettingsSync().streakReminder);
      });
      (async () => {
        // Read independently of the speaker list: that call needs the
        // backend and can fail or hang offline, and coupling it to
        // Promise.all used to leave the switches showing defaults (so a tap
        // saved the wrong flip) whenever it did.
        const settings = await getSettings();
        if (!alive) return;
        setHapticsState(settings.hapticsEnabled);
        setSkyAlwaysNightState(settings.skyAlwaysNight);
        setShowAllLanguagesState(settings.showAllLanguages);
        setAppLanguageState(settings.appLanguage);
        setStreakOnState(settings.streakReminder);
        setStreakHourState(settings.streakReminderHour);
        setIsJapanese(toIslandLanguage(settings.learningLanguage) === 'ja');

        try {
          const name = await api.getUsername();
          if (alive) setUsernameState(name);
        } catch {
          // Offline or a device-only session: the row stays without a value.
        }

        try {
          const [speakers, voiceId] = await Promise.all([
            api.listSpeakers(toIslandLanguage(settings.learningLanguage)),
            getVoice(settings.learningLanguage),
          ]);
          if (!alive) return;
          const speaker = speakers.find((sp) => sp.styles.some((st) => st.id === voiceId));
          const style = speaker?.styles.find((st) => st.id === voiceId);
          setVoiceName(speaker && style ? voiceRowLabel(t, speaker.name, style.name) : '');
        } catch {
          // Voice list needs the backend; the row still works without a name shown.
        }
      })();
      return () => {
        alive = false;
      };
    }, [t]),
  );

  const scrollRef = useRef<ScrollView>(null);
  const feedbackY = useRef<number | null>(null);
  const pendingFocus = useRef(false);
  const glow = useSharedValue(0);
  const glowStyle = useAnimatedStyle(() => ({ backgroundColor: `rgba(124,200,255,${glow.value * 0.25})` }));
  // The guide's beta step ends on this tab: scroll the bug and idea row into view once, then glow it for 900ms once the scroll has landed.
  function revealFeedback() {
    if (feedbackY.current === null) return;
    pendingFocus.current = false;
    scrollRef.current?.scrollTo({ y: Math.max(0, feedbackY.current - Spacing.xl), animated: true });
    // The animated scrollTo lands at about 400ms; the glow waits for it, rises, holds, then fades.
    glow.value = withDelay(GLOW_AFTER_SCROLL_MS, withSequence(withTiming(1, { duration: 200 }), withDelay(400, withTiming(0, { duration: 300 }))));
  }
  useFocusEffect(
    useCallback(() => {
      if (getGuideStep() !== 'beta') return;
      pendingFocus.current = true;
      revealFeedback();
    }, []),
  );

  return (
    <SafeAreaView edges={['bottom']} style={StyleSheet.flatten([styles.fill, { backgroundColor: tide.sky[0] }])}>
      <ScrollView ref={scrollRef} contentContainerStyle={styles.list}>
        <SettingsSection title={t('settings.section.practice')}>
          <SettingsRow
            label={t(isJapanese ? 'settings.row.practice' : 'settings.row.practiceOther')}
            last
            icon={{ ios: 'book.closed', android: 'menu_book' }}
            onPress={() => router.push('/settings/practice')}
          />
        </SettingsSection>

        <SettingsSection title={t('settings.section.streak')} footnote={t('settings.streak.reminderFootnote')}>
          <SettingsRow
            label={t('settings.streak.reminder')}
            icon={{ ios: 'bell', android: 'notifications' }}
            switchValue={streakOn}
            onSwitchChange={(next) => void toggleStreakReminder(next)}
          />
          <View style={styles.segBox}>
            <Segmented
              options={hourChoices}
              value={String(streakHour)}
              onChange={(next) => {
                setStreakHourState(Number(next));
                void setStreakReminderHour(Number(next));
              }}
            />
          </View>
          {/* Dev-only: the real notification in 10 s, to check the glyph, channel and count on a locked phone. */}
          {__DEV__ ? (
            <SettingsRow
              label={t('settings.streak.testRow')}
              last
              icon={{ ios: 'bell.badge', android: 'notifications_active' }}
              onPress={() => void scheduleTestReminder().then(explainReminder)}
            />
          ) : null}
        </SettingsSection>

        <SettingsSection title={t('settings.section.playback')}>
          <SettingsRow
            label={t('settings.row.playback')}
            last
            icon={{ ios: 'gauge', android: 'speed' }}
            onPress={() => router.push('/settings/playback')}
          />
        </SettingsSection>

        <SettingsSection title={t('settings.section.voice')}>
          <SettingsRow
            label={t('settings.row.voice')}
            value={voiceName}
            last
            icon={{ ios: 'person.wave.2', android: 'record_voice_over' }}
            onPress={() => router.push('/settings/voice')}
          />
        </SettingsSection>

        <SettingsSection title={t('settings.section.language')}>
          <SettingsRow
            label={t('settings.row.languages')}
            icon={{ ios: 'globe', android: 'language' }}
            onPress={() => router.push('/settings/languages')}
          />
          {/* languages: Home shows every language's islands when on. */}
          <SettingsRow
            label={t('settings.row.showAllLanguages')}
            icon={{ ios: 'globe', android: 'language' }}
            switchValue={showAllLanguages}
            onSwitchChange={(next) => {
              setShowAllLanguagesState(next);
              void setShowAllLanguages(next);
            }}
          />
          <SettingsRow
            label={t('settings.appLanguage')}
            value={appLanguage === 'auto' ? t('settings.appLanguageAuto') : (LOCALES[appLanguage as Lang]?.native ?? t('settings.appLanguageAuto'))}
            last
            icon={{ ios: 'textformat', android: 'translate' }}
            onPress={() => router.push('/settings/app-language')}
          />
        </SettingsSection>

        <SettingsSection title={t('settings.section.appearance')}>
          <SettingsRow
            label={t('settings.row.haptics')}
            icon={{ ios: 'iphone.radiowaves.left.and.right', android: 'vibration' }}
            switchValue={haptics}
            onSwitchChange={(next) => {
              setHapticsState(next);
              void setHaptics(next);
            }}
          />
          <SettingsRow
            label={t('settings.row.alwaysNightSky')}
            last
            icon={{ ios: 'moon.stars', android: 'nightlight' }}
            switchValue={skyAlwaysNight}
            onSwitchChange={(next) => {
              setSkyAlwaysNightState(next);
              void setSkyAlwaysNight(next);
            }}
          />
        </SettingsSection>

        <SettingsSection title={t('settings.section.data')}>
          <SettingsRow
            label={t('settings.row.data')}
            last
            icon={{ ios: 'internaldrive', android: 'storage' }}
            onPress={() => router.push('/settings/data')}
          />
        </SettingsSection>

        <SettingsSection title={t('settings.section.about')}>
          <SettingsRow
            label={t('settings.row.about')}
            icon={{ ios: 'info.circle', android: 'info' }}
            onPress={() => router.push('/settings/about')}
          />
          <SettingsRow
            label={t('settings.row.replayOnboarding')}
            last={!__DEV__}
            icon={{ ios: 'arrow.counterclockwise', android: 'replay' }}
            onPress={() => router.push('/onboarding')}
          />
          {/* Dev-only row, excluded from the app-language inventory. */}
          {__DEV__ ? (
            <SettingsRow
              label={t('title.prismLab')}
              icon={{ ios: 'sparkles', android: 'auto_awesome' }}
              onPress={() => router.push('/prism-lab')}
            />
          ) : null}
          {__DEV__ ? (
            <SettingsRow
              label={t('title.catLab')}
              last
              icon={{ ios: 'pawprint', android: 'pets' }}
              onPress={() => router.push('/cat-lab')}
            />
          ) : null}
        </SettingsSection>

        <Animated.View
          style={[styles.glowWrap, glowStyle]}
          onLayout={(e) => {
            feedbackY.current = e.nativeEvent.layout.y;
            if (pendingFocus.current) revealFeedback();
          }}>
          <SettingsSection title={t('settings.section.feedback')}>
            <SettingsRow
              label={t('settings.row.feedback')}
              last
              icon={{ ios: 'ladybug', android: 'bug_report' }}
              onPress={() => router.push('/settings/feedback')}
            />
          </SettingsSection>
        </Animated.View>

        <SettingsSection
          title={t('settings.section.account')}
          footnote={
            usingDevBypass() || !provider() ? undefined : t('settings.account.signedInWith', { provider: provider() === 'apple' ? 'Apple' : 'Google' })
          }>
          {usingDevBypass() ? null : (
            <>
              <SettingsRow
                label={t('username.settingsRow')}
                value={username === undefined ? undefined : username === null ? t('username.notSet') : `@${username}`}
                icon={{ ios: 'at', android: 'alternate_email' }}
                onPress={() => router.push('/username')}
              />
              <SettingsRow
                label={t('settings.row.signOut')}
                icon={{ ios: 'rectangle.portrait.and.arrow.right', android: 'logout' }}
                onPress={() => void confirmSignOut()}
              />
              <SettingsRow
                label={t('settings.row.deleteAccount')}
                destructive
                last
                icon={{ ios: 'trash', android: 'delete' }}
                onPress={confirmDeleteAccount}
              />
            </>
          )}
        </SettingsSection>
      </ScrollView>
    </SafeAreaView>
  );
}

/** The guide's animated scrollTo to the bug and idea row lands at about this; the glow starts then. */
const GLOW_AFTER_SCROLL_MS = 400;

const styles = StyleSheet.create({
  glowWrap: { borderRadius: 16 },
  segBox: { padding: Spacing.md },
  fill: { flex: 1 },
  // paddingBottom leaves room for the floating pill tab bar and the offset
  // pane that peeks out past its bottom edge, so the last row never hides
  // under it.
  list: { padding: Spacing.lg, gap: Spacing.lg, paddingBottom: Spacing.lg + PILL_TAB_BAR_REACH + prism.tray.pane.dy },
});
