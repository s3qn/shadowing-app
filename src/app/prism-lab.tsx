import { type ReactNode, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { useSharedValue } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { GlassPanel, PrismButton, PrismFace, verb as verbTokens, type Verb } from '@/components/prism';
import { BlindIcon, ReadingIcon, RepeatIcon, SearchIcon, SpeedIcon } from '@/components/tide/toolbar-icons';
import { fonts } from '@/constants/fonts';
import { Radius, Spacing, tide } from '@/constants/theme';
import { useSkyStyle } from '@/lib/sky';

const VERBS: Verb[] = ['listen', 'speak', 'read', 'tools'];
const TILE_ICONS = [SpeedIcon, RepeatIcon, ReadingIcon, BlindIcon, SearchIcon];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.row}>{children}</View>
    </View>
  );
}

/**
 * Dev-only preview of the prism kit: every shape, both blur tint options and
 * the on/disabled states, so the look can be checked on a real screen
 * without wiring it into a real toolbar first. Reachable from Settings,
 * About, only in `__DEV__`.
 */
export default function PrismLabScreen() {
  const sky = useSkyStyle();
  const discT = useSharedValue(0);
  const [on, setOn] = useState<Record<string, boolean>>({});
  const toggle = (key: string) => setOn((prev) => ({ ...prev, [key]: !prev[key] }));

  return (
    <SafeAreaView edges={['bottom']} style={StyleSheet.flatten([styles.fill, { backgroundColor: sky.top }])}>
      <View style={[StyleSheet.absoluteFill, sky.from]} />
      <Animated.View style={[StyleSheet.absoluteFill, sky.to, sky.fadeStyle]} />
      <ScrollView contentContainerStyle={styles.content}>
        <Section title="Round, 36 and 44">
          {VERBS.map((v) => (
            <View key={v} style={styles.pair}>
              <PrismButton shape="round" size={36} verb={v} on={!!on[`r36-${v}`]} onPress={() => toggle(`r36-${v}`)}>
                <SpeedIcon color={verbTokens[v].c1} size={16} verb={v} />
              </PrismButton>
              <PrismButton shape="round" size={44} verb={v} on={!!on[`r44-${v}`]} onPress={() => toggle(`r44-${v}`)}>
                <SpeedIcon color={verbTokens[v].c1} size={18} verb={v} />
              </PrismButton>
            </View>
          ))}
        </Section>

        <Section title="Big round, 56 and 64">
          {VERBS.map((v) => (
            <View key={v} style={styles.pair}>
              <PrismButton shape="round" size={56} verb={v} on={!!on[`r56-${v}`]} onPress={() => toggle(`r56-${v}`)}>
                <SpeedIcon color={verbTokens[v].c1} size={26} verb={v} />
              </PrismButton>
              <PrismButton shape="round" size={64} verb={v} on={!!on[`r64-${v}`]} onPress={() => toggle(`r64-${v}`)}>
                <SpeedIcon color={verbTokens[v].c1} size={26} verb={v} />
              </PrismButton>
            </View>
          ))}
        </Section>

        <Section title="Tile row, one GlassPanel blur">
          <GlassPanel style={styles.tilePanel}>
            {TILE_ICONS.map((Icon, i) => {
              const v = VERBS[i % VERBS.length];
              const key = `tile-${i}`;
              return (
                <PrismButton
                  key={key}
                  shape="tile"
                  verb={v}
                  flat
                  label={`Tile ${i + 1}`}
                  value={`${i + 1}x`}
                  on={!!on[key]}
                  onPress={() => toggle(key)}>
                  <Icon color={verbTokens[v].c1} size={20} verb={v} />
                </PrismButton>
              );
            })}
          </GlassPanel>
        </Section>

        <Section title="Pills, one GlassPanel blur">
          <GlassPanel radius={Radius.pill} style={styles.pillPanel}>
            {VERBS.slice(0, 3).map((v, i) => {
              const key = `pill-${i}`;
              return (
                <PrismButton key={key} shape="pill" verb={v} flat label={v} on={!!on[key]} onPress={() => toggle(key)}>
                  <SpeedIcon color={verbTokens[v].c1} size={17} verb={v} />
                </PrismButton>
              );
            })}
          </GlassPanel>
        </Section>

        <Section title="Sheet disc, 30 (no press)">
          {VERBS.map((v) => (
            <PrismFace key={v} shape="round" size={30} verb={v} onT={discT}>
              <SpeedIcon color={verbTokens[v].c1} size={15} verb={v} />
            </PrismFace>
          ))}
        </Section>

        <Section title="On and disabled">
          <PrismButton shape="round" size={44} verb="listen" on onPress={() => {}}>
            <SpeedIcon color={verbTokens.listen.c1} size={18} verb="listen" />
          </PrismButton>
          <PrismButton shape="round" size={44} verb="speak" on disabled onPress={() => {}}>
            <SpeedIcon color={verbTokens.speak.c1} size={18} verb="speak" />
          </PrismButton>
        </Section>

        <Section title="Press: tide (default on big round, 56+) vs light (everything else)">
          <View style={styles.pair}>
            <PrismButton shape="round" size={44} verb="listen" onPress={() => {}}>
              <SpeedIcon color={verbTokens.listen.c1} size={18} verb="listen" />
            </PrismButton>
            <PrismButton shape="round" size={56} verb="listen" onPress={() => {}}>
              <SpeedIcon color={verbTokens.listen.c1} size={24} verb="listen" />
            </PrismButton>
          </View>
          <View style={styles.pair}>
            <PrismButton shape="round" size={56} verb="speak" press="light" onPress={() => {}}>
              <SpeedIcon color={verbTokens.speak.c1} size={24} verb="speak" />
            </PrismButton>
            <PrismButton shape="round" size={44} verb="speak" press="tide" onPress={() => {}}>
              <SpeedIcon color={verbTokens.speak.c1} size={18} verb="speak" />
            </PrismButton>
          </View>
        </Section>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { padding: Spacing.lg, paddingBottom: 170, gap: Spacing.xl },
  section: { gap: Spacing.sm },
  sectionTitle: { fontFamily: fonts.uiMedium, fontWeight: '500', fontSize: 13, color: tide.textDim },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.md, alignItems: 'center' },
  pair: { flexDirection: 'row', gap: Spacing.sm },
  tilePanel: { flexDirection: 'row', padding: 4, gap: 4 },
  pillPanel: { flexDirection: 'row', padding: 4, gap: 4 },
});
