import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { useTheme } from '@/hooks/use-theme';

export default function RootLayout() {
  const { palette, scheme } = useTheme();
  return (
    <>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: palette.bg },
          headerTintColor: palette.ink,
          headerTitleStyle: { fontWeight: '600' },
          contentStyle: { backgroundColor: palette.bg },
        }}>
        <Stack.Screen name="index" options={{ title: 'Islands' }} />
        <Stack.Screen
          name="record"
          options={{ title: 'New island', presentation: 'modal' }}
        />
        <Stack.Screen name="island/[id]" options={{ title: '' }} />
      </Stack>
    </>
  );
}
