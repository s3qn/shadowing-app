import { useRouter } from 'expo-router';

import { BottomSheet } from '@/components/sheet/bottom-sheet';
import { SheetAction, type SheetIcon } from '@/components/sheet/sheet-rows';
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

  const rows: Row[] = [
    { key: 'record', label: t('home.add.record'), icon: { ios: 'mic.fill', android: 'mic' }, href: '/record' },
    { key: 'phrases', label: t('home.add.phrases'), icon: { ios: 'text.bubble', android: 'chat' }, href: '/phrases' },
    { key: 'import', label: t('home.add.import'), icon: { ios: 'square.and.arrow.down', android: 'upload' }, href: '/import' },
    { key: 'video', label: t('home.add.video'), icon: { ios: 'play.rectangle', android: 'smart_display' }, href: '/video/add' }, // youtube-shadowing
  ];

  return (
    <BottomSheet open={open} onClose={onClose} title={t('home.addTitle')}>
      {rows.map((row) => (
        <SheetAction
          key={row.key}
          label={row.label}
          icon={row.icon}
          onPress={() => {
            onClose();
            router.push(row.href);
          }}
        />
      ))}
    </BottomSheet>
  );
}
