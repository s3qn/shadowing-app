import { Tabs } from 'expo-router';

import { PillTabBar } from '@/components/pill-tab-bar';
import { useTheme } from '@/hooks/use-theme';

export default function TabsLayout() {
  const { palette } = useTheme();

  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: palette.bg },
        headerTintColor: palette.ink,
        headerTitleStyle: { fontWeight: '600' },
        sceneStyle: { backgroundColor: palette.bg },
      }}
      tabBar={(props) => <PillTabBar {...props} />}>
      <Tabs.Screen name="index" options={{ title: 'Islands' }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings' }} />
    </Tabs>
  );
}
