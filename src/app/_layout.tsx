import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useReducedMotion } from 'react-native-reanimated';

import { CardMorphOverlay } from '@/components/card-morph-overlay';
import { LoadingOverlay } from '@/components/loading-overlay';
import { tide } from '@/constants/theme';
import { getSettings } from '@/lib/settings';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const reducedMotion = useReducedMotion();
  // No bundled fonts to load anymore (the app uses the platform's system
  // fonts), so the splash screen just hides right away.
  useEffect(() => {
    void SplashScreen.hideAsync();
    // Fills the settings sync cache before anything needs it, so the first
    // press anywhere (haptics) and the first sky paint already see the
    // saved settings instead of the defaults.
    void getSettings();
  }, []);

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
        <Stack.Screen name="(tabs)" options={{ headerShown: false, title: 'Islands' }} />
        <Stack.Screen
          name="record"
          options={{ title: 'New island', presentation: 'modal' }}
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
        <Stack.Screen name="settings/voice" options={{ title: 'Voice' }} />
        <Stack.Screen name="settings/playback" options={{ title: 'Playback' }} />
        <Stack.Screen name="settings/practice" options={{ title: 'Practice' }} />
        <Stack.Screen name="settings/data" options={{ title: 'Data' }} />
        <Stack.Screen name="settings/about" options={{ title: 'About' }} />
      </Stack>
      <CardMorphOverlay />
      <LoadingOverlay />
    </GestureHandlerRootView>
  );
}
