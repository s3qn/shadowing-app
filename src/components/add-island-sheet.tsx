import { useRouter } from 'expo-router';

import { BottomSheet } from '@/components/sheet/bottom-sheet';
import { SheetAction, type SheetIcon } from '@/components/sheet/sheet-rows';
import { GuideLayer } from '@/components/onboarding/guide-layer';
import { setGuideStep, useGuideAnchor, useGuideAnchors, useGuideStep } from '@/lib/guide';
import { useT } from '@/lib/i18n';

type Row = {
  key: string;
  label: string;
  icon: SheetIcon;
  /** Route the row opens. */
  href: '/record' | '/phrases' | '/import' | '/video/add';
};

/**
 * The sheet behind Home's plus button: one row per way to add an island.
 * Each row is one control that closes the sheet and opens its screen.
 */
export function AddIslandSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useT();
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
            hint={{ x: box.x + box.width / 2, y: box.y + box.height / 2 }}
            bubble={{ kind: 'record', text: [t('guide.add'), t('guide.add.b2')], top: 300 }}
            chip={{ text: t('guide.chip.island'), place: 'below' }}
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
