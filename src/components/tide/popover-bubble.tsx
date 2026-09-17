import { type ReactNode } from 'react';
import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import Animated, { type EntryAnimationsValues, FadeOut, withSpring, withTiming } from 'react-native-reanimated';

import { tide } from '@/constants/theme';
import { t } from '@/lib/i18n';

const ARROW = 12;
/** Space between the arrow's tip and the tile under it. */
const ANCHOR_GAP = 4;
const EDGE = 8;

/** Heavily damped: the bubble pops up without wobbling. */
const POP_SPRING = { damping: 26, stiffness: 380, mass: 0.8 } as const;

function popIn(_values: EntryAnimationsValues) {
  'worklet';
  return {
    initialValues: { opacity: 0, transform: [{ translateY: 8 }, { scale: 0.7 }] },
    animations: {
      opacity: withTiming(1, { duration: 120 }),
      transform: [{ translateY: withSpring(0, POP_SPRING) }, { scale: withSpring(1, POP_SPRING) }],
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
  onClose: () => void;
  children: ReactNode;
};

/**
 * A toolbar tile's popover: a bubble over the tile with an arrow pointing
 * down at it, popping in from the arrow. A tap anywhere outside closes it.
 * Mount it only while open, over the whole player.
 */
export function PopoverBubble({ anchorX, anchorTop, parentWidth, width, height, radius, bodyStyle, onClose, children }: Props) {
  const left = Math.max(EDGE, Math.min(parentWidth - width - EDGE, anchorX - width / 2));
  const top = anchorTop - ANCHOR_GAP - ARROW / 2 - height;
  // Kept on the body's straight run, clear of its rounded corners.
  const arrowLeft = Math.max(radius, Math.min(width - radius, anchorX - left)) - ARROW / 2;
  const originX = arrowLeft + ARROW / 2;

  return (
    <View style={styles.cover} pointerEvents="box-none">
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel={t('player.close')} accessible={false} />
      <Animated.View
        entering={popIn}
        exiting={POP_OUT}
        style={[styles.bubble, { left, top, width, height: height + ARROW / 2, transformOrigin: [originX, height + ARROW / 2, 0] }]}>
        <View style={[styles.arrow, { left: arrowLeft, top: height - ARROW / 2 - 1 }]} />
        <View style={[styles.body, { height, borderRadius: radius }, bodyStyle]}>{children}</View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  cover: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: 20 },
  bubble: { position: 'absolute' },
  body: {
    backgroundColor: tide.water,
    borderWidth: 1,
    borderColor: tide.waterline,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  // A turned square under the body, drawn first so the body covers its top
  // half; only its two lower borders show.
  arrow: {
    position: 'absolute',
    width: ARROW,
    height: ARROW,
    backgroundColor: tide.water,
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderColor: tide.waterline,
    transform: [{ rotate: '45deg' }],
    elevation: 8,
  },
});
