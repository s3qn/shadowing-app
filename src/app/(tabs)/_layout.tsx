import { Tabs } from 'expo-router';

import { PillTabBar } from '@/components/pill-tab-bar';
import { tide } from '@/constants/theme';
import { useBetaFeatures } from '@/lib/beta';
import { useDir, useT } from '@/lib/i18n';

export default function TabsLayout() {
  const { t } = useT();
  const dir = useDir();
  const { podcast } = useBetaFeatures();
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: tide.sky[0] },
        headerShadowVisible: false,
        headerTintColor: tide.text,
        headerTitleStyle: { fontWeight: '600' },
        // Hebrew: the title sits at the right, next to Home's mirrored search button.
        ...dir.headerSides,
        sceneStyle: { backgroundColor: tide.sky[0] },
      }}
      tabBar={(props) => <PillTabBar {...props} />}>
      <Tabs.Screen name="index" options={{ title: t('tab.islands') }} />
      {/* beta-gate: without the switch the podcast tab is not a route at all, so a deep link cannot open it. */}
      <Tabs.Protected guard={podcast}>
        <Tabs.Screen name="podcast" options={{ title: t('tab.podcast') }} />
      </Tabs.Protected>
      <Tabs.Screen name="settings" options={{ title: t('tab.settings') }} />
    </Tabs>
  );
}
