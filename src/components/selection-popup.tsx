import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { PrismButton } from '@/components/prism';
import { GlassFill } from '@/components/tide/popover-bubble';
import { CheckIcon, CopyIcon, ExplainIcon, RepeatIcon } from '@/components/tide/toolbar-icons';
import { prism, Radius, tide, verb as verbTokens } from '@/constants/theme';
import { useT } from '@/lib/i18n';

const BUTTON_SIZE = 44;
const BUTTON_GAP = 10;
const POPUP_PADDING_H = 8;
const POPUP_PADDING_V = 6;

export const SELECTION_POPUP_WIDTH = 3 * BUTTON_SIZE + 2 * BUTTON_GAP + 2 * POPUP_PADDING_H;

type Props = {
  /** Absolute position inside the sentence block, computed by the screen. */
  left: number;
  top: number;
  /** Omit to hide the repeat button (a screen with no phrase audio). */
  onRepeat?: () => void;
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
  const { t } = useT();
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
    <View style={[styles.pop, { left, top }]}>
      <GlassFill radius={Radius.md} />
      {onRepeat ? (
        <PrismButton
          shape="round"
          size={BUTTON_SIZE}
          verb="speak"
          on
          onPress={onRepeat}
          accessibilityLabel={t('player.repeatSelection')}>
          <RepeatIcon color={verbTokens.speak.c1} size={22} />
        </PrismButton>
      ) : null}
      <PrismButton shape="round" size={BUTTON_SIZE} verb="listen" onPress={onExplain} accessibilityLabel={t('player.explainSelection')}>
        <ExplainIcon color={verbTokens.listen.c1} background={tide.water} size={22} />
      </PrismButton>
      <PrismButton
        shape="round"
        size={BUTTON_SIZE}
        verb="tools"
        onPress={handleCopy}
        accessibilityLabel={copied ? t('player.copied') : t('player.copySelection')}>
        {copied ? (
          <CheckIcon color={verbTokens.tools.c1} size={22} />
        ) : (
          <CopyIcon color={verbTokens.tools.c1} background={tide.water} size={15} />
        )}
      </PrismButton>
    </View>
  );
}

const styles = StyleSheet.create({
  pop: {
    position: 'absolute',
    width: SELECTION_POPUP_WIDTH,
    zIndex: 10,
    boxShadow: prism.shadow,
    borderRadius: Radius.md,
    paddingVertical: POPUP_PADDING_V,
    paddingHorizontal: POPUP_PADDING_H,
    flexDirection: 'row',
    gap: BUTTON_GAP,
  },
});
