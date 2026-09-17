import { Stack, useRouter } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useReducedMotion } from 'react-native-reanimated';

import { CardMorphOverlay } from '@/components/card-morph-overlay';
import { LoadingOverlay } from '@/components/loading-overlay';
import { tide } from '@/constants/theme';
import { loadDeviceId } from '@/lib/device';
import { useT } from '@/lib/i18n';
import { getSettings } from '@/lib/settings';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const { t } = useT();
  const reducedMotion = useReducedMotion();
  const [ready, setReady] = useState(false);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const launched = useRef(false);
  const router = useRouter();
  // No bundled fonts to load anymore (the app uses the platform's system
  // fonts), so the app waits only on two small file reads: the device id,
  // so every request has the header, then the settings, so the first render
  // (Home's language filter, haptics, the sky) sees the saved values instead
  // of the defaults.
  useEffect(() => {
    void (async () => {
      // A failed read or write still opens the app: requests then go out
      // without the header and get a 401, which is better than a stuck splash.
      try {
        await loadDeviceId();
      } catch (err: unknown) {
        console.warn('loadDeviceId failed', err);
      }
      // getSettings falls back to defaults on its own; a throw here still
      // opens the app, without sending anyone into onboarding.
      let onboarded = true;
      try {
        onboarded = (await getSettings()).onboarded;
      } catch (err: unknown) {
        console.warn('getSettings failed', err);
      }
      setNeedsOnboarding(!onboarded);
      setReady(true);
    })();
  }, []);

  // First run opens onboarding over Home once the Stack is mounted
  // (navigating before the root layout renders throws). The splash hides a
  // frame later, so a fresh install never shows Home first.
  useEffect(() => {
    if (!ready || launched.current) return;
    launched.current = true;
    if (needsOnboarding) router.push({ pathname: '/onboarding', params: { first: '1' } });
    requestAnimationFrame(() => {
      void SplashScreen.hideAsync();
    });
  }, [ready, needsOnboarding, router]);

  if (!ready) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: tide.sky[0] },
          headerTintColor: tide.text,
          headerTitleStyle: { fontWeight: '600' },
          contentStyle: { backgroundColor: tide.sky[0] },
        }}>
        {/* title names the back button the next screen shows, even though
            this screen's own header is hidden: without it iOS falls back to
            the route segment, "(tabs)". */}
        <Stack.Screen name="(tabs)" options={{ headerShown: false, title: t('tab.islands') }} />
        {/* Full screen, no header, and no swipe to dismiss: it closes only
            through its own buttons. On first launch (`first` param) it is
            already in place when the splash hides, so it does not animate. */}
        <Stack.Screen
          name="onboarding/index"
          options={({ route }) => {
            const params = route.params as { first?: string } | undefined;
            return {
              headerShown: false,
              presentation: 'fullScreenModal',
              gestureEnabled: false,
              animation: params?.first === '1' ? 'none' : 'default',
            };
          }}
        />
        <Stack.Screen
          name="record"
          options={{ title: t('title.newIsland'), presentation: 'modal' }}
        />
        {/* The player draws its own header. Opened from a Home card (the
            `morph` param), the card morph overlay is the whole transition
            both ways, so the route itself does not animate; anywhere else,
            and under reduced motion, the route fades. */}
        <Stack.Screen
          name="island/[id]"
          options={({ route }) => {
            const params = route.params as { morph?: string } | undefined;
            const morph = params?.morph === '1' && !reducedMotion;
            return {
              title: '',
              headerShown: false,
              animation: morph ? 'none' : 'fade',
              animationDuration: 300,
            };
          }}
        />
        <Stack.Screen name="settings/voice" options={{ title: t('title.voice') }} />
        <Stack.Screen name="settings/playback" options={{ title: t('title.playback') }} />
        <Stack.Screen name="settings/practice" options={{ title: t('title.practice') }} />
        <Stack.Screen name="settings/data" options={{ title: t('title.data') }} />
        <Stack.Screen name="settings/about" options={{ title: t('title.about') }} />
        <Stack.Screen name="settings/languages" options={{ title: t('title.language') }} />
        <Stack.Screen name="settings/app-language" options={{ title: t('settings.appLanguage') }} />
        {/* Dev-only screen, excluded from the app-language inventory. */}
        <Stack.Screen name="prism-lab" options={{ title: 'Prism lab' }} />
      </Stack>
      <CardMorphOverlay />
      <LoadingOverlay />
    </GestureHandlerRootView>
  );
}
