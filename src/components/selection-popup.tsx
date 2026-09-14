import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

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
 * the screen). Everything either button starts (loading the phrase's audio,
 * dropping a take, playing, opening the Explain sheet) is the screen's job.
 */
export function SelectionPopup({ left, top, onRepeat, onExplain }: Props) {
  const { palette } = useTheme();
  return (
    <View
      style={[
        styles.pop,
        { left, top, backgroundColor: palette.surface, borderColor: palette.line, shadowColor: '#000' },
      ]}>
      <Pressable onPress={onRepeat} style={[styles.repeat, { backgroundColor: palette.accent }]}>
        <Text style={[styles.repeatText, { color: palette.accentInk }]}>Repeat</Text>
      </Pressable>
      <Pressable onPress={onExplain} style={[styles.repeat, { backgroundColor: palette.surfaceAlt, borderWidth: 1, borderColor: palette.accent }]}>
        <Text style={[styles.repeatText, { color: palette.accent }]}>Explain</Text>
      </Pressable>
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
