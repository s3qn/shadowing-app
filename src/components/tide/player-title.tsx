import { StyleSheet, Text, View } from 'react-native';

import { fonts } from '@/constants/fonts';
import { tide } from '@/constants/theme';

type Props = {
  title: string;
  lineIndex: number;
  lineCount: number;
};

/** The player's header title: the island name over "Line X of Y". */
export function PlayerTitle({ title, lineIndex, lineCount }: Props) {
  return (
    <View style={styles.wrap}>
      <Text style={styles.title} numberOfLines={1}>
        {title}
      </Text>
      <Text style={styles.line}>
        LINE {lineIndex + 1} OF {lineCount}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center' },
  title: { fontFamily: fonts.uiMedium, fontWeight: '500', fontSize: 14, color: tide.text },
  line: { fontFamily: fonts.ui, fontSize: 10, letterSpacing: 1.2, textTransform: 'uppercase', color: tide.textDim },
});
