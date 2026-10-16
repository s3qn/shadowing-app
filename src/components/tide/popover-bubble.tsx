import { type ReactNode } from 'react';
import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import Animated, { type EntryAnimationsValues, FadeOut, withSpring, withTiming } from 'react-native-reanimated';

import { BlurView } from 'expo-blur';

import { prism, tide, withAlpha } from '@/constants/theme';
import { useT } from '@/lib/i18n';

/**
 * The frosted-glass pane every popover body sits on: blur, a faint fill and
 * the prism rim. Fills its parent and clips to `radius`; the parent keeps the
 * shadow, so the pane never clips it.
 */
export function GlassFill({ radius }: { radius: number }) {
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: radius, overflow: 'hidden' }]}>
      <BlurView style={StyleSheet.absoluteFill} intensity={prism.blur.intensity} tint={prism.blur.tint} />
      <View style={[StyleSheet.absoluteFill, { backgroundColor: withAlpha(tide.water, 0.55) }]} />
      <View style={[StyleSheet.absoluteFill, { borderRadius: radius, borderWidth: 1, borderColor: prism.panel.rim }]} />
    </View>
  );
}

/** Shared look of the tray column and every dock popover (design T-A). */
export const POP = {
  surface: '#0B1322',
  border: 'rgba(255,255,255,0.07)',
  shadow: '0 12 30 rgba(0,0,0,0.6)',
  radius: 20,
  goldInk: '#FFE2A0',
  offInk: '#B7B1C6',
  ink: '#ECE8F4',
  goldFill: 'rgba(255,200,87,0.12)',
  goldSelFill: 'rgba(255,200,87,0.10)',
  goldSelRing: 'rgba(255,200,87,0.8)',
  goldRing: 'rgba(255,200,87,0.4)',
  divider: 'rgba(255,255,255,0.07)',
  tickMajor: 'rgba(236,232,244,0.65)',
  tickMinor: 'rgba(236,232,244,0.3)',
} as const;
/** Width of every pill in the tray column, and the pill height. */
export const DOCK_PILL_W = 148;
export const DOCK_PILL_H = 44;

const ARROW = 14;
/** How far the turned square's tip reaches past its centre (rounded tip). */
const TIP = 9;
const EDGE = 8;

/** The bubble rises from its tail. */
const POP_SPRING = { damping: 22, stiffness: 260, mass: 1 } as const;
/** The side bubble fades and scales from its tail. */
const SIDE_SPRING = { damping: 20, stiffness: 240, mass: 1 } as const;

function popIn(_values: EntryAnimationsValues) {
  'worklet';
  return {
    initialValues: { opacity: 0, transform: [{ translateY: 10 }, { scale: 0.92 }] },
    animations: {
      opacity: withTiming(1, { duration: 120 }),
      transform: [{ translateY: withSpring(0, POP_SPRING) }, { scale: withSpring(1, POP_SPRING) }],
    },
  };
}

function sideIn(_values: EntryAnimationsValues) {
  'worklet';
  return {
    initialValues: { opacity: 0, transform: [{ scale: 0.85 }] },
    animations: {
      opacity: withTiming(1, { duration: 120 }),
      transform: [{ scale: withSpring(1, SIDE_SPRING) }],
    },
  };
}

const POP_OUT = FadeOut.duration(120);

type Props = {
  /** The tile's horizontal centre and top edge, in the parent's coordinates. */
  anchorX: number;
  anchorTop: number;
  /** The parent's width, to keep the bubble on screen. */
  parentWidth: number;
  /** The body's size, without the arrow. */
  width: number;
  height: number;
  radius: number;
  bodyStyle?: ViewStyle;
  /**
   * 'top' (default): the bubble sits over the tile, tail pointing down.
   * 'left': the bubble sits left of a tray pill (DOCK_PILL_W wide, DOCK_PILL_H
   * high), tail pointing right at its left edge.
   */
  side?: 'top' | 'left';
  /** Space between the tail's tip and the tile: 0 on a tray pill, 4 on the chip. */
  gap?: number;
  onClose: () => void;
  children: ReactNode;
};

/**
 * A toolbar tile's popover: a solid bubble over the tile with a tail pointing
 * at it, rising from the tail. A tap anywhere outside closes it.
 * Mount it only while open, over the whole player.
 */
export function PopoverBubble({
  anchorX,
  anchorTop,
  parentWidth,
  width,
  height,
  radius,
  bodyStyle,
  side = 'top',
  gap = 0,
  onClose,
  children,
}: Props) {
  const { t } = useT();
  const left = side === 'left' ? anchorX - DOCK_PILL_W / 2 - gap - TIP - width : Math.max(EDGE, Math.min(parentWidth - width - EDGE, anchorX - width / 2));
  const top = side === 'left' ? anchorTop + DOCK_PILL_H / 2 - height / 2 : anchorTop - gap - TIP - height;
  // Kept on the body's straight run, clear of its rounded corners.
  const arrowLeft = Math.max(radius, Math.min(width - radius, anchorX - left));
  const isLeft = side === 'left';
  const originX = isLeft ? width + TIP : arrowLeft;
  const originY = isLeft ? height / 2 : height + TIP;

  return (
    <View style={styles.cover} pointerEvents="box-none">
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel={t('player.close')} accessible={false} />
      <Animated.View
        entering={isLeft ? sideIn : popIn}
        exiting={POP_OUT}
        style={[
          styles.bubble,
          {
            left,
            top,
            width: isLeft ? width + TIP : width,
            height: isLeft ? height : height + TIP,
            transformOrigin: [originX, originY, 0],
          },
        ]}>
        {/* Under the body: only the half past the body's edge shows. */}
        <View
          pointerEvents="none"
          style={[
            styles.arrow,
            isLeft
              ? { left: width - ARROW / 2, top: height / 2 - ARROW / 2, borderRightWidth: 1, borderBottomWidth: 1, transform: [{ rotate: '-45deg' }] }
              : { left: arrowLeft - ARROW / 2, top: height - ARROW / 2, borderRightWidth: 1, borderBottomWidth: 1, transform: [{ rotate: '45deg' }] },
          ]}
        />
        <View style={[styles.body, { height, width, borderRadius: radius }, bodyStyle]}>{children}</View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  cover: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: 20 },
  bubble: { position: 'absolute' },
  body: {
    backgroundColor: POP.surface,
    borderWidth: 1,
    borderColor: POP.border,
    boxShadow: POP.shadow,
  },
  arrow: {
    position: 'absolute',
    width: ARROW,
    height: ARROW,
    backgroundColor: POP.surface,
    borderColor: POP.border,
    borderBottomRightRadius: 4,
  },
});
