import { type ReactNode, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { Canvas, LinearGradient, RoundedRect, vec } from '@shopify/react-native-skia';
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';

import { PILL_H } from '@/components/prism/pill-tray';
import { SLOTS, type Slot } from '@/constants/cosmetics';
import { fonts } from '@/constants/fonts';
import { Radius, prism } from '@/constants/theme';
import { useDir, useT } from '@/lib/i18n';

const INACTIVE = '#B9B4CC';
const ACTIVE_INK = '#0B0D16';
const LIGHT_FILL = '#F4F2FA';
const TRAY_BLUR = 24;
const TRAY_INSET = 4;
const LABEL_SIZE = 14;

/** A light pill with a pink-to-blue prism fringe, faded in and out by `lit`. */
function SlotPill({ on, label, onPress }: { on: boolean; label: string; onPress: () => void }) {
  const lit = useSharedValue(on ? 1 : 0);
  const scale = useSharedValue(1);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    lit.value = withTiming(on ? 1 : 0, { duration: 200 });
  }, [on, lit]);
  const scaleStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const litStyle = useAnimatedStyle(() => ({ opacity: lit.value }));
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
      <Animated.View style={[styles.pill, scaleStyle]} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
        <Animated.View style={[StyleSheet.absoluteFill, litStyle]} pointerEvents="none">
          {width > 0 ? (
            <Canvas style={StyleSheet.absoluteFill}>
              <RoundedRect x={0} y={0} width={width} height={PILL_H} r={PILL_H / 2} color={LIGHT_FILL} />
              <RoundedRect x={0} y={0} width={width} height={PILL_H} r={PILL_H / 2}>
                <LinearGradient
                  start={vec(0, 0)}
                  end={vec(width, 0)}
                  colors={[prism.fringe.leftOn, LIGHT_FILL, LIGHT_FILL, prism.fringe.rightOn]}
                  positions={[0, 0.2, 0.8, 1]}
                />
              </RoundedRect>
            </Canvas>
          ) : null}
        </Animated.View>
        <Text style={[styles.text, { color: on ? ACTIVE_INK : INACTIVE, fontWeight: on ? '600' : '500' }]}>{label}</Text>
      </Animated.View>
    </Pressable>
  );
}

export type SlotTabsProps = { slot: Slot; onChange: (slot: Slot) => void };

/** The four slot tabs on a local blur-24 glass tray. */
export function SlotTabs({ slot, onChange }: SlotTabsProps) {
  const { t } = useT();
  const dir = useDir();
  return (
    <GlassTray>
      <View style={[styles.row, dir.row]}>
        {SLOTS.map((s) => (
          <SlotPill key={s} on={slot === s} label={t(`wardrobe.slot.${s}` as const)} onPress={() => onChange(s)} />
        ))}
      </View>
    </GlassTray>
  );
}

function GlassTray({ children }: { children: ReactNode }) {
  return (
    <View style={styles.tray}>
      <BlurView intensity={TRAY_BLUR} tint={prism.blur.tint} style={StyleSheet.absoluteFill} />
      <View style={styles.trayHighlight} />
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  tray: {
    position: 'relative',
    alignSelf: 'stretch',
    borderRadius: Radius.pill,
    overflow: 'hidden',
    padding: TRAY_INSET,
    borderWidth: 1,
    borderColor: prism.tray.rim,
  },
  trayHighlight: { position: 'absolute', top: 0, left: 0, right: 0, height: 1, backgroundColor: 'rgba(255,255,255,0.16)' },
  slot: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  pill: {
    alignItems: 'center',
    justifyContent: 'center',
    height: PILL_H,
    borderRadius: PILL_H / 2,
    overflow: 'hidden',
  },
  text: { fontSize: LABEL_SIZE, fontFamily: fonts.ui },
});
