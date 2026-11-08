import { useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { GlassCard } from '@/components/glass-card';
import { BottomSheet } from '@/components/sheet/bottom-sheet';
import { type SheetIcon } from '@/components/sheet/sheet-rows';
import { skipGuide } from '@/components/onboarding/guide-host';
import { GuideLayer, guideBubbleHeight } from '@/components/onboarding/guide-layer';
import { getGuideStep, setGuideStep, useGuideAnchor, useGuideAnchors, useGuideStep } from '@/lib/guide';
import { tide, verb } from '@/constants/theme';
import { fonts } from '@/constants/fonts';
import { useBetaFeatures } from '@/lib/beta';
import { useDir, useT } from '@/lib/i18n';

type Row = {
  key: string;
  label: string;
  icon: SheetIcon;
  /** Route the row opens. */
  href: '/record' | '/phrases' | '/import' | '/video/add';
};

/** launch-basics: the two square tiles. Side padding of the sheet, gap between tiles, largest tile edge. */
const SHEET_SIDE = 20;
const TILE_GAP = 12;
const TILE_MAX = 168;
/** Space the sheet needs besides the tiles: the status bar gap and the bottom inset. */
const SHEET_FOOT = 148;
/** From the sheet's top edge to the tile row's top: the grab bar and the title. */
const SHEET_HEAD = 44;

/**
 * The sheet behind Home's plus button: one row per way to add an island.
 * Each row is one control that closes the sheet and opens its screen.
 */
export function AddIslandSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useT();
  const dir = useDir();
  const beta = useBetaFeatures();
  const { width, height } = useWindowDimensions();
  const tile = Math.min(TILE_MAX, Math.floor((width - SHEET_SIDE * 2 - TILE_GAP) / 2));
  const router = useRouter();
  const guide = useGuideStep() === 'add' && open;
  const phrases = useGuideAnchor('addPhrases', guide);
  const box = useGuideAnchors().addPhrases;

  const tiles: Row[] = [
    { key: 'record', label: t('home.add.record'), icon: { ios: 'mic.fill', android: 'mic' }, href: '/record' },
    { key: 'phrases', label: t('home.add.phrases'), icon: { ios: 'text.bubble', android: 'chat' }, href: '/phrases' },
  ];
  // Hidden from everyone the admin has not switched on.
  if (beta.import) tiles.push({ key: 'import', label: t('home.add.import'), icon: { ios: 'square.and.arrow.down', android: 'upload' }, href: '/import' });
  if (beta.youtube) tiles.push({ key: 'video', label: t('home.add.video'), icon: { ios: 'play.rectangle', android: 'smart_display' }, href: '/video/add' }); // youtube-shadowing
  // On a short screen the tiles get shorter (never under 120) so the sheet title stays on screen.
  const rows = Math.ceil(tiles.length / 2);
  const room = (height - SHEET_HEAD - SHEET_FOOT - TILE_GAP * (rows - 1)) / rows;
  const tileH = Math.max(120, Math.min(tile, Math.floor(Number.isFinite(room) ? room : tile)));
  const open_ = (row: Row) => {
    if (guide && row.key === 'phrases') {
      setGuideStep('listen');
      onClose();
      router.push({ pathname: '/phrases/build', params: { starter: '1', guide: 'listen' } });
      return;
    }
    if (guide) setGuideStep('home');
    onClose();
    router.push(row.href);
  };

  const close = () => {
    // While the add moment is up the sheet stays open (State table: back is blocked); a tap outside is a miss.
    // Before the Phrases row is measured there is no overlay, so a close then hands the guide back to Home's +.
    if (guide && box) return;
    if (guide) setGuideStep('home');
    onClose();
  };

  return (
    <BottomSheet
      open={open}
      onClose={close}
      onOpened={phrases.onLayout}
      title={t('home.addTitle')}
      overlay={
        guide && box ? (
          <GuideLayer
            holes={[{ ...box, radius: 20 }]}
            // The ring sits on the tile's centre.
            hint={{ x: box.x + box.width / 2, y: box.y + box.height / 2 }}
            // The cat ends on the sheet's top edge and the chip sits above it, so neither covers the sheet title or the tiles (375x667 included).
            bubble={{ kind: 'record', text: [t(beta.beta ? 'guide.add' : 'guide.add.plain'), t('guide.add.b2')], top: box.y - SHEET_HEAD - guideBubbleHeight('record', width) - 4 }}
            chip={{ text: t('guide.chip.island'), place: 'above' }}
            // A confirmed skip lands on Home, so the sheet closes with it.
            onSkip={() => void skipGuide().then(() => getGuideStep() === 'done' && onClose())}
          />
        ) : null
      }>
      <View style={[styles.tiles, dir.row]}>
        {tiles.map((row) => (
          <GlassCard key={row.key} onPress={() => open_(row)} accessibilityLabel={row.label} style={{ width: tile, height: tileH }}>
            <View
              ref={row.key === 'phrases' ? phrases.ref : undefined}
              onLayout={row.key === 'phrases' ? phrases.onLayout : undefined}
              style={styles.tileFace}>
              <SymbolView name={row.icon} size={44} weight="regular" tintColor={verb.speak.c1} />
              <Text style={styles.tileLabel}>{row.label}</Text>
            </View>
          </GlassCard>
        ))}
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  tiles: { flexDirection: 'row', justifyContent: 'center', flexWrap: 'wrap', gap: TILE_GAP, paddingBottom: 8 },
  tileFace: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  tileLabel: { color: tide.text, fontSize: 17, fontFamily: fonts.ui, fontWeight: '600', textAlign: 'center' },
});
