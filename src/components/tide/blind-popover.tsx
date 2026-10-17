import { StyleSheet, Text } from 'react-native';

import { PressScale } from '@/components/press-scale';
import { POP, PopoverBubble } from '@/components/tide/popover-bubble';
import { fonts } from '@/constants/fonts';
import { type TFn, useDir, useT } from '@/lib/i18n';
import { type Key } from '@/locales/en';

const LANG_CODE: Record<string, Key> = { ja: 'player.langCode.ja', es: 'player.langCode.es', en: 'player.langCode.en', he: 'player.langCode.he' };

/** A language's short tag for the Blind pill and its toggles ("JP", or the
 * name in a script with no short codes). Unknown ids fall back to the id. */
function langCode(t: TFn, id: string): string {
  const key = LANG_CODE[id];
  return key ? t(key) : id.toUpperCase();
}

/** The Blind pill's value: Both, the hidden language's code, or Off. */
export function blindValueLabel(t: TFn, blind: boolean, englishShown: boolean, lang: string, native: string): string {
  if (blind && !englishShown) return t('player.blindBoth');
  if (blind) return langCode(t, lang);
  if (!englishShown) return langCode(t, native);
  return t('player.blindOff');
}

const BODY_PAD_X = 8;
const BODY_PAD_Y = 7;
const GAP = 6;
const BODY_H = 60;
const PILL_H = BODY_H - 2 * BODY_PAD_Y;
/** Two pills of half the column width each, plus padding and gap. */
const BLIND_POP_W = 2 * 86 + GAP + 2 * BODY_PAD_X;

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
  /** The learned and the translation language ids, for the toggles' tags. */
  lang: string;
  native: string;
};

/**
 * The Blind pill's popover: a bar left of the pill with two toggles, one for
 * the translation and one for the sentence, tagged by language. Each shows gold while its text is
 * hidden. A tap anywhere outside closes it. Mount it only while open, over
 * the whole player.
 */
export function BlindPopover({ anchorX, anchorTop, width, jaHidden, enHidden, onToggleJa, onToggleEn, onClose, lang, native }: Props) {
  const { t } = useT();
  const dir = useDir();
  return (
    <PopoverBubble
      anchorX={anchorX}
      anchorTop={anchorTop}
      parentWidth={width}
      width={BLIND_POP_W}
      height={BODY_H}
      radius={POP.radius}
      side="left"
      bodyStyle={{ ...styles.body, ...dir.row }}
      onClose={onClose}>
      <Toggle on={jaHidden} onPress={onToggleJa} label={t('player.hideSentence')} text={langCode(t, lang)} />
      <Toggle on={enHidden} onPress={onToggleEn} label={t('player.hideTranslation')} text={langCode(t, native)} />
    </PopoverBubble>
  );
}

function Toggle({ on, onPress, label, text }: { on: boolean; onPress: () => void; label: string; text: string }) {
  return (
    <PressScale
      onPress={onPress}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: on }}
      style={styles.button}>
      <Text style={[styles.text, { color: on ? POP.goldInk : POP.offInk }]}>{text}</Text>
    </PressScale>
  );
}

const styles = StyleSheet.create({
  body: { flexDirection: 'row', gap: GAP, paddingHorizontal: BODY_PAD_X, paddingVertical: BODY_PAD_Y },
  button: { flex: 1, height: PILL_H, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  text: { fontFamily: fonts.uiMedium, fontWeight: '600', fontSize: 13 },
});
