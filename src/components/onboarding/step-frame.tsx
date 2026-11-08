import { type ReactNode, useEffect } from 'react';
import { type LayoutChangeEvent, type StyleProp, StyleSheet, Text, View, type ViewStyle, useWindowDimensions } from 'react-native';
import Animated, { type SharedValue, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { type HeroClock } from '@/components/onboarding/hero-clock';
import { PrismButton, type Verb } from '@/components/prism';
import { OUT, clamp } from '@/components/tide/ladder/clock-curves';
import { fin } from '@/components/tide/ladder/stage-hint';
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

export type EnterProps = {
  /** The welcome clock. Without it the part is static at rest and no animated style is created. */
  clock?: HeroClock;
  /** Reduced motion: the part fades in over h 100 to 300 with no rise. */
  reduced?: boolean;
  /** The h (ms after Get started) the part starts entering at, and how long it takes. */
  at: number;
  dur: number;
  /** The rise in pt: translateY from `rise` to 0 as it fades in. */
  rise?: number;
  /** A straight fade (clamp) instead of OUT: the first Account pill. */
  linear?: boolean;
  style?: StyleProp<ViewStyle>;
  onLayout?: (e: LayoutChangeEvent) => void;
  children: ReactNode;
};

/**
 * One Account part entering on the hand-off: hidden until Get started is
 * pressed, then opacity and a rise driven by the shared clock (the board's
 * `render()`: kicker 300/260, title 360/280, body 420/280, first pill
 * 260/160 linear, second pill 300/320 with a 24pt rise, caption 380/260).
 */
export function Enter({ clock, ...rest }: EnterProps) {
  if (!clock) {
    return (
      <View style={rest.style} onLayout={rest.onLayout}>
        {rest.children}
      </View>
    );
  }
  return <EnterLive clock={clock} {...rest} />;
}

function EnterLive({ clock, reduced, at, dur, rise = 0, linear, style, onLayout, children }: EnterProps & { clock: HeroClock }) {
  const tk = clock.tk;
  const tapT = clock.tapT;
  const rm = reduced === true;
  const lin = linear === true;
  const animated = useAnimatedStyle(() => {
    const gate = tapT.value;
    const h = gate === Infinity ? -1 : tk.value - gate;
    if (h < 0) return { opacity: 0, transform: [{ translateY: rm ? 0 : rise }] };
    if (rm) return { opacity: fin(clamp((h - 100) / 200)), transform: [{ translateY: 0 }] };
    const u = (h - at) / dur;
    const k = lin ? clamp(u) : OUT(u);
    return { opacity: fin(k), transform: [{ translateY: fin(rise * (1 - k)) }] };
  });
  return (
    <Animated.View style={[style, animated]} onLayout={onLayout}>
      {children}
    </Animated.View>
  );
}

/**
 * The copy block: a coloured uppercase kicker, a heavy headline that may
 * wrap to two lines, then the grey line under it. Left-aligned, and right
 * aligned in Hebrew; `centered` is for the steps whose art is centred too.
 * With `enter`, each line rises in 10pt on the welcome hand-off (kicker,
 * title, body at h 300, 360, 420).
 */
export function StepCopy({
  kicker,
  kickerColour,
  title,
  body,
  centered,
  titleSize,
  kickerSize,
  enter,
  reduced,
}: {
  kicker?: string;
  kickerColour?: string;
  title: string;
  body?: string;
  centered?: boolean;
  titleSize?: number;
  /** A bigger kicker keeps its tracking at 0.2 em. */
  kickerSize?: number;
  /** The welcome clock: the lines enter on the hand-off. Without it the copy is static. */
  enter?: HeroClock;
  /** Reduced motion for `enter`: fades only. */
  reduced?: boolean;
}) {
  const dir = useDir();
  // Centred copy still needs the writing direction: without it a headline
  // that opens with Latin ("Echo Tail מקשיב לך") takes its base direction
  // from that first word and puts the name at the wrong end of the line.
  const align = centered ? [styles.centered, dir.writing] : dir.text;
  const rise = (node: ReactNode, at: number, dur: number) =>
    enter ? (
      <Enter clock={enter} reduced={reduced} at={at} dur={dur} rise={10}>
        {node}
      </Enter>
    ) : (
      node
    );
  return (
    <View style={styles.copy}>
      {kicker
        ? rise(
            <Text
              style={[
                styles.kicker,
                kickerColour ? { color: kickerColour } : null,
                kickerSize ? { fontSize: kickerSize, letterSpacing: kickerSize * 0.2 } : null,
                align,
              ]}>
              {kicker}
            </Text>,
            300,
            260,
          )
        : null}
      {rise(
        <Text style={[styles.title, titleSize ? { fontSize: titleSize, lineHeight: Math.round(titleSize * 1.18) } : null, align]}>{title}</Text>,
        360,
        280,
      )}
      {body ? rise(<Text style={[styles.body, align]}>{body}</Text>, 420, 280) : null}
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
  labelOpacity,
}: {
  label: string;
  verb: Verb;
  onPress: () => void;
  on?: boolean;
  accessibilityLabel?: string;
  /** Fades the label alone, the face stays (the welcome pill's hand-off). */
  labelOpacity?: SharedValue<number>;
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
      labelOpacity={labelOpacity}
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
