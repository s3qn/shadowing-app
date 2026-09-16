import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { PressScale } from '@/components/press-scale';
import { CheckIcon, CopyIcon, ExplainIcon, RepeatIcon } from '@/components/tide/toolbar-icons';
import { Radius, tide } from '@/constants/theme';

const BUTTON_SIZE = 44;
const BUTTON_GAP = 10;
const POPUP_PADDING_H = 8;
const POPUP_PADDING_V = 6;

export const SELECTION_POPUP_WIDTH = 3 * BUTTON_SIZE + 2 * BUTTON_GAP + 2 * POPUP_PADDING_H;

type Props = {
  /** Absolute position inside the sentence block, computed by the screen. */
  left: number;
  top: number;
  onRepeat: () => void;
  onExplain: () => void;
  onCopy: () => void;
};

const COPIED_LABEL_MS = 1200;

/**
 * The popup shown once a drag selects a run of words: Repeat, Explain and
 * Copy, positioned the same way `WordPanel` is (absolute, clamped into the
 * block by the screen). It follows the selection handles as they move the
 * span and hides while either handle is being dragged, reappearing at the
 * new span on release. Everything Repeat and Explain start (loading the
 * phrase's audio, dropping a take, playing, opening the Explain sheet) is the
 * screen's job; Copy writes the clipboard itself, here, since nothing beyond
 * this popup depends on the result.
 */
export function SelectionPopup({ left, top, onRepeat, onExplain, onCopy }: Props) {
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  function handleCopy() {
    onCopy();
    setCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), COPIED_LABEL_MS);
  }

  return (
    <View
      style={[
        styles.pop,
        { left, top, backgroundColor: tide.water, borderColor: tide.waterline, shadowColor: '#000' },
      ]}>
      <PressScale
        onPress={onRepeat}
        style={[styles.button, { backgroundColor: tide.lang.ja }]}
        accessibilityRole="button"
        accessibilityLabel="Repeat selection">
        <RepeatIcon color={tide.sky[0]} size={22} />
      </PressScale>
      <PressScale
        onPress={onExplain}
        style={[styles.button, styles.outline, { borderColor: tide.lang.ja }]}
        accessibilityRole="button"
        accessibilityLabel="Explain selection">
        <ExplainIcon color={tide.lang.ja} background={tide.water} size={22} />
      </PressScale>
      <PressScale
        onPress={handleCopy}
        style={[styles.button, styles.outline, { borderColor: tide.lang.ja }]}
        accessibilityRole="button"
        accessibilityLabel={copied ? 'Copied' : 'Copy selection'}>
        {copied ? (
          <CheckIcon color={tide.lang.ja} size={22} />
        ) : (
          <CopyIcon color={tide.lang.ja} background={tide.water} size={15} />
        )}
      </PressScale>
    </View>
  );
}

const styles = StyleSheet.create({
  pop: {
    position: 'absolute',
    width: SELECTION_POPUP_WIDTH,
    zIndex: 10,
    elevation: 8,
    shadowOpacity: 0.25,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    borderWidth: 1,
    borderRadius: Radius.md,
    paddingVertical: POPUP_PADDING_V,
    paddingHorizontal: POPUP_PADDING_H,
    flexDirection: 'row',
    gap: BUTTON_GAP,
  },
  button: {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    borderRadius: BUTTON_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  outline: { backgroundColor: 'transparent', borderWidth: 1.5 },
});
