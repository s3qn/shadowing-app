// The dock capsule that holds the 90+ Easy offer's two choices while it is up.
// Owner: I1e. The route decides when it shows and what each choice does.
import { StyleSheet, Text, View } from 'react-native';

import { Leaf } from '@/components/island/player-header';
import { PressScale } from '@/components/press-scale';
import { GlassPanel } from '@/components/prism/glass-panel';
import { fonts } from '@/constants/fonts';
import { Radius, tide } from '@/constants/theme';
import { useT } from '@/lib/i18n';

export function EasyOffer({ onYes, onNo }: { onYes: () => void; onNo: () => void }) {
  const { t } = useT();
  return (
    // bl58-easy-for-me: E4 c, the capsule holds the offer's two choices while it is up.
    <View style={styles.offerRoot} pointerEvents="box-none">
      <GlassPanel radius={Radius.pill} style={styles.offerCapsule}>
        <View style={styles.offerRow}>
          <PressScale
            onPress={onYes}
            accessibilityRole="button"
            accessibilityLabel={t('ladder.easyOffer.yes')}
            style={[styles.offerBtn, styles.offerBtnOn]}>
            <Leaf size={14} />
            <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.85} style={[styles.offerText, styles.offerTextOn]}>{t('ladder.easyOffer.yes')}</Text>
          </PressScale>
          <PressScale
            onPress={onNo}
            accessibilityRole="button"
            accessibilityLabel={t('ladder.easyOffer.no')}
            style={styles.offerBtn}>
            <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.85} style={styles.offerText}>{t('ladder.easyOffer.no')}</Text>
          </PressScale>
        </View>
      </GlassPanel>
    </View>
  );
}

const styles = StyleSheet.create({
  offerRoot: { alignItems: 'center', paddingTop: 8, paddingBottom: 8 },
  offerCapsule: { height: 56 },
  offerRow: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 10 },
  offerBtn: {
    flex: 1,
    height: 40,
    paddingHorizontal: 10,
    borderRadius: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
  },
  offerBtnOn: { backgroundColor: 'rgba(61,220,151,0.16)', borderColor: 'rgba(61,220,151,0.6)' },
  offerText: { fontFamily: fonts.uiMedium, fontSize: 13, fontWeight: '600', color: tide.text },
  offerTextOn: { color: '#C9F7E0' },
});
