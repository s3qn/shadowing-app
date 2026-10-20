import { Tabs } from 'expo-router';

import { PillTabBar } from '@/components/pill-tab-bar';
import { tide } from '@/constants/theme';
import { useDir, useT } from '@/lib/i18n';

export default function TabsLayout() {
  const { t } = useT();
  const dir = useDir();
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: tide.sky[0] },
        headerTintColor: tide.text,
        headerTitleStyle: { fontWeight: '600' },
        // Hebrew: the title sits at the right, next to Home's mirrored search button.
        ...dir.headerSides,
        sceneStyle: { backgroundColor: tide.sky[0] },
      }}
      tabBar={(props) => <PillTabBar {...props} />}>
      <Tabs.Screen name="index" options={{ title: t('tab.islands') }} />
      <Tabs.Screen name="podcast" options={{ title: t('tab.podcast') }} />
      <Tabs.Screen name="settings" options={{ title: t('tab.settings') }} />
    </Tabs>
  );
}
