import { Tabs } from 'expo-router';

import { PillTabBar } from '@/components/pill-tab-bar';
import { tide } from '@/constants/theme';
import { useT } from '@/lib/i18n';

export default function TabsLayout() {
  const { t } = useT();
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: tide.sky[0] },
        headerTintColor: tide.text,
        headerTitleStyle: { fontWeight: '600' },
        sceneStyle: { backgroundColor: tide.sky[0] },
      }}
      tabBar={(props) => <PillTabBar {...props} />}>
      <Tabs.Screen name="index" options={{ title: t('tab.islands') }} />
      <Tabs.Screen name="podcast" options={{ title: t('tab.podcast') }} />
      <Tabs.Screen name="settings" options={{ title: t('tab.settings') }} />
    </Tabs>
  );
}
