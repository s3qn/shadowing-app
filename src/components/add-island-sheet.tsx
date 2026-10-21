import { useRouter } from 'expo-router';
import { useWindowDimensions } from 'react-native';

import { BottomSheet } from '@/components/sheet/bottom-sheet';
import { SheetAction, type SheetIcon } from '@/components/sheet/sheet-rows';
import { GuideLayer, guideBubbleHeight } from '@/components/onboarding/guide-layer';
import { setGuideStep, useGuideAnchor, useGuideAnchors, useGuideStep } from '@/lib/guide';
import { useT } from '@/lib/i18n';

type Row = {
  key: string;
  label: string;
  icon: SheetIcon;
  /** Route the row opens. */
  href: '/record' | '/phrases' | '/import' | '/video/add';
};

/** From the row's start edge to the guide ring's centre: between the icon and the label's first letters. */
const PHRASES_RING_X = 40;
/** From the sheet's top edge to the Phrases row's top: the grab bar, the title and the Record row. */
const SHEET_HEAD = 100;

/**
 * The sheet behind Home's plus button: one row per way to add an island.
 * Each row is one control that closes the sheet and opens its screen.
 */
export function AddIslandSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, rtl } = useT();
  const { width } = useWindowDimensions();
  const router = useRouter();
  const guide = useGuideStep() === 'add' && open;
  const phrases = useGuideAnchor('addPhrases', guide);
  const box = useGuideAnchors().addPhrases;

  const rows: Row[] = [
    { key: 'record', label: t('home.add.record'), icon: { ios: 'mic.fill', android: 'mic' }, href: '/record' },
    { key: 'phrases', label: t('home.add.phrases'), icon: { ios: 'text.bubble', android: 'chat' }, href: '/phrases' },
    { key: 'import', label: t('home.add.import'), icon: { ios: 'square.and.arrow.down', android: 'upload' }, href: '/import' },
    { key: 'video', label: t('home.add.video'), icon: { ios: 'play.rectangle', android: 'smart_display' }, href: '/video/add' }, // youtube-shadowing
  ];

  return (
    <BottomSheet
      open={open}
      onClose={() => {
        if (guide) setGuideStep('home');
        onClose();
      }}
      onOpened={phrases.onLayout}
      title={t('home.addTitle')}
      overlay={
        guide && box ? (
          <GuideLayer
            holes={[{ ...box, radius: 16 }]}
            // The ring sits on the row's icon and the start of its label (SheetAction: 12 pt padding, 24 pt icon, 12 pt gap), not the row's empty middle.
            hint={{ x: rtl ? box.x + box.width - PHRASES_RING_X : box.x + PHRASES_RING_X, y: box.y + box.height / 2 }}
            // The cat ends on the sheet's top edge and the chip sits above it, so neither covers the sheet title (375x667 included).
            bubble={{ kind: 'record', text: [t('guide.add'), t('guide.add.b2')], top: box.y - SHEET_HEAD - guideBubbleHeight('record', width) - 4 }}
            chip={{ text: t('guide.chip.island'), place: 'above' }}
            onTapOutside={() => {
              setGuideStep('home');
              onClose();
            }}
          />
        ) : null
      }>
      {rows.map((row) => (
        <SheetAction
          key={row.key}
          label={row.label}
          icon={row.icon}
          anchor={row.key === 'phrases' ? phrases : undefined}
          onPress={() => {
            if (guide && row.key === 'phrases') {
              setGuideStep('listen');
              onClose();
              router.push({ pathname: '/phrases/build', params: { starter: '1', guide: 'listen' } });
              return;
            }
            if (guide) setGuideStep('home');
            onClose();
            router.push(row.href);
          }}
        />
      ))}
    </BottomSheet>
  );
}
