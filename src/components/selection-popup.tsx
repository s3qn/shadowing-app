import { StyleSheet, Text, View } from 'react-native';

import { PressScale } from '@/components/press-scale';
import { Radius, Spacing, tide } from '@/constants/theme';

export const SELECTION_POPUP_WIDTH = 208;

type Props = {
  /** Absolute position inside the sentence block, computed by the screen. */
  left: number;
  top: number;
  onRepeat: () => void;
  onExplain: () => void;
};

/**
 * The popup shown once a drag selects a run of words: Repeat and Explain,
 * positioned the same way `WordPanel` is (absolute, clamped into the block by
 * the screen). It follows the selection handles as they move the span and
 * hides while either handle is being dragged, reappearing at the new span on
 * release. Everything either button starts (loading the phrase's audio,
 * dropping a take, playing, opening the Explain sheet) is the screen's job.
 */
export function SelectionPopup({ left, top, onRepeat, onExplain }: Props) {
  return (
    <View
      style={[
        styles.pop,
        { left, top, backgroundColor: tide.water, borderColor: tide.waterline, shadowColor: '#000' },
      ]}>
      <PressScale onPress={onRepeat} style={[styles.repeat, { backgroundColor: tide.lang.ja }]}>
        <Text style={[styles.repeatText, { color: tide.sky[0] }]}>Repeat</Text>
      </PressScale>
      <PressScale
        onPress={onExplain}
        style={[styles.repeat, { backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: tide.lang.ja }]}>
        <Text style={[styles.repeatText, { color: tide.lang.ja }]}>Explain</Text>
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
    padding: Spacing.sm,
    flexDirection: 'row',
    gap: Spacing.sm,
  },
  repeat: { flex: 1, paddingVertical: Spacing.sm, borderRadius: Radius.pill, alignItems: 'center' },
  repeatText: { fontSize: 14, fontWeight: '700' },
});
