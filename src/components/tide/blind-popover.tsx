import { type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { PressScale } from '@/components/press-scale';
import { PopoverBubble } from '@/components/tide/popover-bubble';
import { BlindIcon } from '@/components/tide/toolbar-icons';
import { fonts } from '@/constants/fonts';
import { tide } from '@/constants/theme';

const BUTTON = 44;
const BODY_PAD = 8;
const GAP = 10;
/** The bubble's width, and its body's height without the arrow. */
const BLIND_POP_W = 2 * BUTTON + GAP + 2 * BODY_PAD;
const BODY_H = BUTTON + 2 * BODY_PAD;

type Props = {
  /** The Blind tile's horizontal centre and top edge, in the parent's coordinates. */
  anchorX: number;
  anchorTop: number;
  /** The parent's width, to keep the bubble on screen. */
  width: number;
  jaHidden: boolean;
  enHidden: boolean;
  onToggleJa: () => void;
  onToggleEn: () => void;
  onClose: () => void;
};

/**
 * The Blind tile's popover: a small bubble over the tile with two round
 * toggles, the translate glyph for the English and the eye for the Japanese.
 * Each lights in the accent while its text is hidden. A tap anywhere outside
 * closes it. Mount it only while open, over the whole player.
 */
export function BlindPopover({ anchorX, anchorTop, width, jaHidden, enHidden, onToggleJa, onToggleEn, onClose }: Props) {
  return (
    <PopoverBubble
      anchorX={anchorX}
      anchorTop={anchorTop}
      parentWidth={width}
      width={BLIND_POP_W}
      height={BODY_H}
      radius={BODY_H / 2}
      bodyStyle={styles.body}
      onClose={onClose}>
      <Toggle on={enHidden} onPress={onToggleEn} label="Hide the translation">
        <TranslateGlyph color={enHidden ? tide.lang.ja : tide.text} />
      </Toggle>
      <Toggle on={jaHidden} onPress={onToggleJa} label="Hide the sentence">
        <BlindIcon color={jaHidden ? tide.lang.ja : tide.text} size={22} />
      </Toggle>
    </PopoverBubble>
  );
}

function Toggle({ on, onPress, label, children }: { on: boolean; onPress: () => void; label: string; children: ReactNode }) {
  return (
    <PressScale
      onPress={onPress}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: on }}
      style={[styles.button, on && styles.buttonOn]}>
      {children}
    </PressScale>
  );
}

/** The A and 文 translate mark, struck through like the eye beside it so it
 * reads as "hide the translation". Built from characters and a bar, not a drawing. */
function TranslateGlyph({ color }: { color: string }) {
  return (
    <View style={styles.glyph}>
      <Text style={[styles.glyphA, { color }]}>A</Text>
      <Text style={[styles.glyphJa, { color }]}>文</Text>
      <View style={[styles.strike, { backgroundColor: color }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  body: { flexDirection: 'row', gap: GAP, padding: BODY_PAD },
  button: {
    width: BUTTON,
    height: BUTTON,
    borderRadius: BUTTON / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  buttonOn: { backgroundColor: 'rgba(255,158,128,0.16)', borderColor: tide.lang.ja },
  glyph: { width: 24, height: 24 },
  // A slash from top-left to bottom-right, edged in the button colour so it
  // cuts cleanly through the two characters.
  strike: {
    position: 'absolute',
    left: 11,
    top: -3,
    width: 2,
    height: 30,
    borderRadius: 1,
    borderWidth: 0.5,
    borderColor: tide.water,
    transform: [{ rotate: '-45deg' }],
  },
  glyphA: {
    position: 'absolute',
    left: 1,
    top: -1,
    fontFamily: fonts.uiMedium,
    fontWeight: '600',
    fontSize: 13,
    lineHeight: 16,
  },
  glyphJa: {
    position: 'absolute',
    right: 0,
    bottom: -1,
    fontFamily: fonts.serifJp,
    fontSize: 13,
    lineHeight: 16,
  },
});
