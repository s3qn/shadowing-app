import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { CardMorphOverlay } from '@/components/card-morph-overlay';
import { tide } from '@/constants/theme';
import { getSettings } from '@/lib/settings';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
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
        <Stack.Screen
          name="island/[id]"
          options={{ title: '', animation: 'fade', animationDuration: 300 }}
        />
        <Stack.Screen name="settings/voice" options={{ title: 'Voice' }} />
        <Stack.Screen name="settings/playback" options={{ title: 'Playback' }} />
        <Stack.Screen name="settings/practice" options={{ title: 'Practice' }} />
        <Stack.Screen name="settings/data" options={{ title: 'Data' }} />
        <Stack.Screen name="settings/about" options={{ title: 'About' }} />
      </Stack>
      <CardMorphOverlay />
    </GestureHandlerRootView>
  );
}
