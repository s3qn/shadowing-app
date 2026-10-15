import { Stack, useRouter, useSegments } from 'expo-router';
import * as ScreenOrientation from 'expo-screen-orientation';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useReducedMotion } from 'react-native-reanimated';

import { CardMorphOverlay } from '@/components/card-morph-overlay';
import { LevelUpModal } from '@/components/level-up-modal';
import { LoadingOverlay } from '@/components/loading-overlay';
import { tide } from '@/constants/theme';
import { getUsername } from '@/lib/api';
import { loadSession, onSessionLost } from '@/lib/auth';
import { loadDeviceId } from '@/lib/device';
import { loadOfflineIndex } from '@/lib/offline-islands'; // offline-islands
import { useT } from '@/lib/i18n';
import { usePendingLevelUp } from '@/lib/level-up-store';
import { getSettings } from '@/lib/settings';

SplashScreen.preventAutoHideAsync();

// Routes that are a practice session: a level-up waits until none is focused.
const PRACTICE_ROUTES = new Set(['island/[id]', 'record', 'drive', 'video', 'podcast']);

/** Shows the queued level-up once the user has left every practice screen. */
function LevelUpHost() {
  const pending = usePendingLevelUp();
  const segments = useSegments() as string[];
  if (!pending) return null;
  const first = segments[0] ?? '';
  // island/[id] is one route name across two segments.
  const route = first === 'island' ? 'island/[id]' : first;
  if (PRACTICE_ROUTES.has(route)) return null;
  return <LevelUpModal levelUp={pending} />;
}

export default function RootLayout() {
  const { t } = useT();
  const reducedMotion = useReducedMotion();
  const [ready, setReady] = useState(false);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const [hasSession, setHasSession] = useState(true);
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
      await loadOfflineIndex(); // offline-islands
      // getSettings falls back to defaults on its own; a throw here still
      // opens the app, without sending anyone into onboarding.
      let onboarded = true;
      try {
        onboarded = (await getSettings()).onboarded;
      } catch (err: unknown) {
        console.warn('getSettings failed', err);
      }
      // A throw counts as no session, so the sign-in screen opens.
      let signedIn = false;
      try {
        signedIn = await loadSession();
      } catch (err: unknown) {
        console.warn('loadSession failed', err);
      }
      setHasSession(signedIn);
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
    else if (!hasSession) router.push({ pathname: '/sign-in', params: { first: '1' } });
    else {
      // Hard gate: a signed-in account with no handle must pick one. A failed
      // request opens the app anyway and the check runs again next launch.
      void getUsername()
        .then((name) => {
          if (name === null) router.push({ pathname: '/username', params: { first: '1' } });
        })
        .catch(() => undefined);
    }
    requestAnimationFrame(() => {
      void SplashScreen.hideAsync();
    });
  }, [ready, needsOnboarding, hasSession, router]);

  // A session that ends on its own (a revoked or expired refresh token)
  // sends the user back to sign-in rather than on to the device path.
  // navigate, not push: if Settings already opened sign-in, it is reused.
  useEffect(() => {
    if (!ready) return;
    return onSessionLost(() => router.navigate('/sign-in'));
  }, [ready, router]);

  // app.json allows every orientation so the video screen can go landscape;
  // everything else stays portrait.
  useEffect(() => {
    void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => undefined);
  }, []);

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
          name="sign-in"
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
          name="username"
          options={({ route }) => {
            const params = route.params as { first?: string } | undefined;
            const required = params?.first === '1';
            return {
              headerShown: false,
              presentation: 'fullScreenModal',
              gestureEnabled: !required,
            };
          }}
        />
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
        <Stack.Screen
          name="import"
          options={{ title: t('title.newIsland'), presentation: 'modal' }}
        />
        {/* youtube-shadowing */}
        <Stack.Screen name="video/add" options={{ title: t('video.title'), presentation: 'modal' }} />
        <Stack.Screen name="video/build" options={{ title: t('video.title'), presentation: 'modal' }} />
        <Stack.Screen
          name="video/[id]"
          options={{
            title: '',
            headerStyle: { backgroundColor: tide.sky[0] },
            headerTintColor: tide.text,
            headerShadowVisible: false,
          }}
        />
        <Stack.Screen
          name="podcast/[id]"
          options={{
            title: '',
            headerStyle: { backgroundColor: tide.sky[0] },
            headerTintColor: tide.text,
            headerShadowVisible: false,
          }}
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
        <Stack.Screen name="before-after" options={{ title: t('beforeAfter.title') }} />
        <Stack.Screen name="review" options={{ title: t('review.title') }} />
        <Stack.Screen name="leaderboard" options={{ title: t('leaderboard.title'), headerStyle: { backgroundColor: '#080b1c' } }} />
        <Stack.Screen name="drive" options={{ headerShown: false, animation: 'fade' }} />
        <Stack.Screen name="wardrobe" options={{ title: t('wardrobe.title'), headerStyle: { backgroundColor: '#080b1c' } }} />
        <Stack.Screen name="profile/[username]" options={{ headerStyle: { backgroundColor: '#080b1c' } }} />
        {/* Dev-only screen, excluded from the app-language inventory. */}
        <Stack.Screen name="prism-lab" options={{ title: 'Prism lab' }} />
        <Stack.Screen name="cat-lab" options={{ title: 'Cat lab' }} />
      </Stack>
      <CardMorphOverlay />
      <LevelUpHost />
      <LoadingOverlay />
    </GestureHandlerRootView>
  );
}
