import { memo, type ReactNode, useEffect, useRef, useState } from 'react';
import { type LayoutChangeEvent, StyleSheet, Text, View } from 'react-native';
import Animated, {
  type EntryAnimationsValues,
  type ExitAnimationsValues,
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { GlassPanel } from '@/components/prism/glass-panel';
import { PrismButton } from '@/components/prism/prism-button';
import { fonts } from '@/constants/fonts';
import { tide, verb, withAlpha } from '@/constants/theme';

/** The label and value glow, off and on. Every tile is the "listen" verb, so
 * one pair of colours covers the whole row. */
const GLOW_OFF = withAlpha(verb.listen.c1, 0.55);
const GLOW_ON = withAlpha(verb.listen.c1, 0.85);
const GLOW_RADIUS_OFF = 6;
const GLOW_RADIUS_ON = 8;

export type ToolbarItem = {
  key: string;
  icon: ReactNode;
  label: string;
  value?: string;
  active?: boolean;
  onPress: () => void;
  /** The tile's box in the row, for a popover anchored to it. */
  onLayout?: (e: LayoutChangeEvent) => void;
};

/** How long the old value takes to clip away and the new one to roll in. */
const VALUE_ROLL_MS = 200;
/** How far the value text travels while rolling, in px. */
const VALUE_ROLL_DIST = 14;
/** The nudge and settle for a tile icon's one-shot reaction to a value
 * change: quick out, spring back. */
const ICON_SPRING = { damping: 14, stiffness: 260, mass: 0.6 } as const;
/** How far the speed gauge's needle nudges toward the new value, and how
 * long the repeat arrows take for their one full spin. */
const SPEED_NUDGE_DEG = 16;
const REPEAT_SPIN_MS = 380;

/** The new value rolls up from just below its place. */
function valueRollIn(_values: EntryAnimationsValues) {
  'worklet';
  return {
    initialValues: { transform: [{ translateY: VALUE_ROLL_DIST }] },
    animations: { transform: [{ translateY: withTiming(0, { duration: VALUE_ROLL_MS }) }] },
  };
}

/** The old value clips away upward. */
function valueRollOut(_values: ExitAnimationsValues) {
  'worklet';
  return {
    initialValues: { transform: [{ translateY: 0 }] },
    animations: { transform: [{ translateY: withTiming(-VALUE_ROLL_DIST, { duration: VALUE_ROLL_MS }) }] },
  };
}

/** The tile's value line: a fixed-height, clipped window that the old text
 * rolls out of and the new text rolls into. Reduced motion crossfades
 * instead of rolling. */
function ValueRoll({ value, active, reducedMotion }: { value: string; active: boolean; reducedMotion: boolean }) {
  // The first value is simply there: rolling it in on mount would play under
  // the card morph's cover, or during the player's content reveal.
  const [first] = useState(value);
  const [changed, setChanged] = useState(false);
  if (!changed && value !== first) setChanged(true);
  return (
    <View style={styles.valueClip}>
      <Animated.Text
        key={value}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.8}
        style={[styles.value, styles.valueLayer, active && styles.glowOn]}
        entering={!changed ? undefined : reducedMotion ? FadeIn.duration(150) : valueRollIn}
        exiting={reducedMotion ? FadeOut.duration(150) : valueRollOut}
      >
        {value}
      </Animated.Text>
    </View>
  );
}

/**
 * One toolbar tile. Watches its own value for changes: a real change (not
 * the first render) gives the icon its one-shot reaction, kind by kind.
 * Reduced motion skips the icon reaction entirely; the value line still
 * updates, just by crossfade instead of rolling (handled in ValueRoll).
 */
function Tile({ item, reducedMotion }: { item: ToolbarItem; reducedMotion: boolean }) {
  const rotate = useSharedValue(0);
  const scaleY = useSharedValue(1);
  const prevValue = useRef(item.value);
  // The tile's face needs a pixel width up front (its Skia sheen canvas
  // cannot take a percentage), so it is measured off the flex:1 wrapper
  // once laid out, the same way PrismButton already measures a pill.
  const [tileWidth, setTileWidth] = useState<number | undefined>(undefined);

  useEffect(() => {
    const prev = prevValue.current;
    prevValue.current = item.value;
    if (reducedMotion || prev === undefined || prev === item.value) return;
    if (item.key === 'speed') {
      const from = Number.parseFloat(prev);
      const to = Number.parseFloat(item.value ?? '');
      const dir = Number.isFinite(from) && Number.isFinite(to) && to !== from ? Math.sign(to - from) : 1;
      rotate.value = withSequence(
        withTiming(dir * SPEED_NUDGE_DEG, { duration: 140 }),
        withSpring(0, ICON_SPRING),
      );
    } else if (item.key === 'blind') {
      scaleY.value = withSequence(withTiming(0.1, { duration: 90 }), withSpring(1, ICON_SPRING));
    } else if (item.key === 'repeat') {
      // Always land on a whole turn, never on whatever angle a drag caught
      // the icon at. If it's already mid-spin toward the next turn, this
      // lands on that same target, so rapid changes stay one smooth spin.
      const target = (Math.floor(rotate.value / 360) + 1) * 360;
      rotate.value = withTiming(target, { duration: REPEAT_SPIN_MS }, (finished) => {
        if (finished && Number.isFinite(rotate.value)) {
          rotate.value = 0;
        }
      });
    }
  }, [item.key, item.value, reducedMotion, rotate, scaleY]);

  const iconStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotate.value}deg` }, { scaleY: scaleY.value }],
  }));

  const handleLayout = (e: LayoutChangeEvent) => {
    setTileWidth(e.nativeEvent.layout.width);
    item.onLayout?.(e);
  };

  return (
    <View style={styles.item} onLayout={handleLayout}>
      <PrismButton
        shape="tile"
        verb="listen"
        flat
        width={tileWidth}
        on={item.active}
        onPress={item.onPress}
        accessibilityLabel={item.value ? `${item.label}, ${item.value}` : item.label}>
        <Animated.View style={iconStyle}>{item.icon}</Animated.View>
        <Text
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.8}
          style={[styles.label, item.active && styles.active, item.active && styles.glowOn]}>
          {item.label}
        </Text>
        {item.value ? <ValueRoll value={item.value} active={!!item.active} reducedMotion={reducedMotion} /> : null}
      </PrismButton>
    </View>
  );
}

/**
 * The row of icon-plus-label buttons above the dock: Speed, Repeat, Reading,
 * Blind. Each button opens the sheet or popover for its setting; the
 * label under the icon stays put and the value line rolls to whatever was
 * last set.
 */
export const Toolbar = memo(function Toolbar({ items }: { items: ToolbarItem[] }) {
  const reducedMotion = useReducedMotion();
  return (
    <GlassPanel style={styles.row}>
      {items.map((item) => (
        <Tile key={item.key} item={item} reducedMotion={reducedMotion} />
      ))}
    </GlassPanel>
  );
});

const styles = StyleSheet.create({
  row: { flexDirection: 'row', padding: 6, gap: 6 },
  // No lip on a tile (light press), so the wrapper reserves nothing beyond
  // the tile's own 64px height: it just hands its measured width down.
  item: { flex: 1 },
  label: {
    fontFamily: fonts.uiMedium,
    fontWeight: '500',
    fontSize: 11,
    color: tide.textDim,
    textShadowColor: GLOW_OFF,
    textShadowRadius: GLOW_RADIUS_OFF,
    textShadowOffset: { width: 0, height: 0 },
  },
  value: {
    fontFamily: fonts.ui,
    fontSize: 11,
    color: tide.text,
    fontVariant: ['tabular-nums'],
    textShadowColor: GLOW_OFF,
    textShadowRadius: GLOW_RADIUS_OFF,
    textShadowOffset: { width: 0, height: 0 },
  },
  valueClip: { height: 14, width: '100%', overflow: 'hidden', alignItems: 'center' },
  valueLayer: { position: 'absolute', left: 0, right: 0, textAlign: 'center' },
  active: { color: verb.listen.c1 },
  glowOn: { textShadowColor: GLOW_ON, textShadowRadius: GLOW_RADIUS_ON },
});
