import { Tabs } from 'expo-router';

import { PillTabBar } from '@/components/pill-tab-bar';
import { tide } from '@/constants/theme';

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: tide.sky[0] },
        headerTintColor: tide.text,
        headerTitleStyle: { fontWeight: '600' },
        sceneStyle: { backgroundColor: tide.sky[0] },
      }}
      tabBar={(props) => <PillTabBar {...props} />}>
      <Tabs.Screen name="index" options={{ title: 'Islands' }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings' }} />
    </Tabs>
  );
}
