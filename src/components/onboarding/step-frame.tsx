import { type ReactNode, useEffect } from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PrismButton, type Verb } from '@/components/prism';
import { fonts } from '@/constants/fonts';
import { Spacing, prism, tide } from '@/constants/theme';
import { useDir } from '@/lib/i18n';

/** The row under the status bar that holds Skip (right) and, on the pass
 * steps, the progress dots (centre). Every step reserves it, so the copy
 * under it starts at the same place on every screen. */
const TOP_ROW_H = prism.sizes.pill.h;

const DOT_OFF = 6;
const DOT_ON = 18;

/** A finite number or the fallback, for values reaching a Reanimated style
 * on the UI thread, where a NaN throws and exits Expo Go with no red box. */
function finiteOr(x: number, fallback: number) {
  'worklet';
  return Number.isFinite(x) ? x : fallback;
}

/** One progress dot: widens from 6 to a short lit pill over 200ms when it
 * becomes the active step. */
function Dot({ active, colour }: { active: boolean; colour: string }) {
  const width = useSharedValue(active ? DOT_ON : DOT_OFF);
  useEffect(() => {
    width.value = withTiming(active ? DOT_ON : DOT_OFF, { duration: 200 });
  }, [active, width]);
  const style = useAnimatedStyle(() => ({
    width: finiteOr(width.value, active ? DOT_ON : DOT_OFF),
    backgroundColor: active ? colour : 'rgba(236,232,244,0.2)',
  }));
  return <Animated.View style={[styles.dot, style]} />;
}

export type StepDotsProps = { count: number; active: number; colour: string };

/** The progress dots, centred at the top of the step. */
export function StepDots({ count, active, colour }: StepDotsProps) {
  const dir = useDir();
  return (
    <View style={[styles.dots, dir.row]}>
      {Array.from({ length: count }, (_, i) => (
        <Dot key={i} active={i === active} colour={colour} />
      ))}
    </View>
  );
}

/**
 * The copy block: a coloured uppercase kicker, a heavy headline that may
 * wrap to two lines, then the grey line under it. Left-aligned, and right
 * aligned in Hebrew; `centered` is for the steps whose art is centred too.
 */
export function StepCopy({
  kicker,
  kickerColour,
  title,
  body,
  centered,
}: {
  kicker?: string;
  kickerColour?: string;
  title: string;
  body?: string;
  centered?: boolean;
}) {
  const dir = useDir();
  const align = centered ? styles.centered : dir.text;
  return (
    <View style={styles.copy}>
      {kicker ? <Text style={[styles.kicker, kickerColour ? { color: kickerColour } : null, align]}>{kicker}</Text> : null}
      <Text style={[styles.title, align]}>{title}</Text>
      {body ? <Text style={[styles.body, align]}>{body}</Text> : null}
    </View>
  );
}

/**
 * The step's main control: a full-width button on the bottom row, lit by
 * default. `on={false}` is the plain glass version, for a second full-width
 * choice under the lit one.
 */
export function StepAction({
  label,
  verb,
  onPress,
  on = true,
  accessibilityLabel,
}: {
  label: string;
  verb: Verb;
  onPress: () => void;
  on?: boolean;
  accessibilityLabel?: string;
}) {
  const { width } = useWindowDimensions();
  return (
    <PrismButton
      shape="pill"
      verb={verb}
      on={on}
      width={Math.max(0, width - 2 * Spacing.xl)}
      height={52}
      label={label}
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
    />
  );
}

/**
 * The shell every onboarding step sits in: the top row (dots, and the room
 * Skip needs), the step's own content, and a footer pinned above the
 * safe-area inset. Every step uses it, so the button stays at one height
 * from the welcome screen to the last one.
 *
 * `fill` is for a step whose content already takes the free space (the
 * language pickers' list): it drops the spacer that would otherwise split
 * the screen with it.
 */
export function StepFrame({
  dots,
  fill,
  children,
  footer,
}: {
  dots?: StepDotsProps;
  fill?: boolean;
  children: ReactNode;
  footer: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.frame, { paddingTop: insets.top + Spacing.sm }]}>
      <View style={styles.topRow}>{dots ? <StepDots {...dots} /> : null}</View>
      <View style={[styles.content, fill ? styles.contentFill : null]}>{children}</View>
      {fill ? null : <View style={styles.spacer} />}
      <View style={styles.footer}>{footer}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { flex: 1, paddingHorizontal: Spacing.xl },
  topRow: { height: TOP_ROW_H, alignItems: 'center', justifyContent: 'center', marginBottom: Spacing.sm },
  content: { gap: Spacing.md },
  contentFill: { flex: 1 },
  spacer: { flex: 1 },
  footer: { alignItems: 'center', gap: Spacing.sm, paddingBottom: Spacing.lg },
  dots: { flexDirection: 'row', gap: 6, alignItems: 'center' },
  dot: { width: DOT_OFF, height: DOT_OFF, borderRadius: DOT_OFF / 2, backgroundColor: 'rgba(236,232,244,0.2)' },
  copy: { gap: Spacing.sm },
  kicker: {
    fontFamily: fonts.uiMedium,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    color: tide.textDim,
  },
  title: { fontFamily: fonts.uiMedium, fontSize: 27, fontWeight: '700', letterSpacing: -0.3, lineHeight: 32, color: tide.text },
  body: { fontFamily: fonts.ui, fontSize: 16, lineHeight: 23, color: tide.textDim },
  centered: { textAlign: 'center' },
});
