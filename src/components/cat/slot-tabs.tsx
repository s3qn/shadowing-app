import { useEffect } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';

import { LitPillCover, LitPillRim, PILL_H, PILL_ICON_OFF, PILL_LABEL_SIZE, PILL_PAD_X, PillTrayShell } from '@/components/prism/pill-tray';
import { SLOTS, type Slot } from '@/constants/cosmetics';
import { fonts } from '@/constants/fonts';
import { prism } from '@/constants/theme';
import { useDir, useT } from '@/lib/i18n';

const BORDER = 1;
const INNER_H = PILL_H - 2 * BORDER;

function SlotPill({ on, label, onPress }: { on: boolean; label: string; onPress: () => void }) {
  const lit = useSharedValue(on ? 1 : 0);
  const scale = useSharedValue(1);
  useEffect(() => {
    lit.value = withTiming(on ? 1 : 0, { duration: 200 });
  }, [on, lit]);
  const scaleStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return (
    <Pressable
      hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
      style={styles.slot}
      onPress={onPress}
      onPressIn={() => {
        scale.value = withTiming(0.96, { duration: 80 });
      }}
      onPressOut={() => {
        scale.value = withSpring(1, prism.press.spring);
      }}>
      <Animated.View style={[styles.pill, scaleStyle]}>
        <LitPillCover height={INNER_H} opacity={lit} />
        <LitPillRim radius={INNER_H / 2} opacity={lit} />
        <Text style={[styles.text, { color: on ? prism.tray.lit.label : PILL_ICON_OFF }]}>{label}</Text>
      </Animated.View>
    </Pressable>
  );
}

export type SlotTabsProps = { slot: Slot; onChange: (slot: Slot) => void };

/** The four slot tabs, a pill tray mirroring Home's sort row. */
export function SlotTabs({ slot, onChange }: SlotTabsProps) {
  const { t } = useT();
  const dir = useDir();
  return (
    <PillTrayShell wrapStyle={styles.wrap} style={[styles.row, dir.row]}>
      {SLOTS.map((s) => (
        <SlotPill key={s} on={slot === s} label={t(`wardrobe.slot.${s}` as const)} onPress={() => onChange(s)} />
      ))}
    </PillTrayShell>
  );
}

const styles = StyleSheet.create({
  wrap: { alignSelf: 'stretch' },
  slot: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  pill: {
    alignItems: 'center',
    justifyContent: 'center',
    height: PILL_H,
    borderRadius: PILL_H / 2,
    overflow: 'hidden',
    borderWidth: BORDER,
    borderColor: 'rgba(255,255,255,0.05)',
    backgroundColor: prism.tray.pillFill,
    paddingHorizontal: PILL_PAD_X,
  },
  text: { fontSize: PILL_LABEL_SIZE, fontWeight: '600', fontFamily: fonts.ui },
});
