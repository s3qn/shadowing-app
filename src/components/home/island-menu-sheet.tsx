import { SymbolView } from 'expo-symbols';
import { useImperativeHandle, useRef, useState, type Ref } from 'react';
import { StyleSheet } from 'react-native';

import { GlassPanel } from '@/components/prism/glass-panel';
import { PrismButton } from '@/components/prism/prism-button';
import { BottomSheet } from '@/components/sheet/bottom-sheet';
import { GlassInput } from '@/components/tide/glass-input';
import { Spacing, verb } from '@/constants/theme';
import type * as api from '@/lib/api';
import { confirmSheet } from '@/lib/confirm-sheet';
import { useDir, useT } from '@/lib/i18n';
import { cancelDownload, humanBytes, removeDownload, startDownload, useDownloadStatus } from '@/lib/offline-islands';

export type IslandMenuHandle = { openRename: (item: api.IslandSummary) => void };

type Props = {
  ref: Ref<IslandMenuHandle>;
  onRename: (id: string, title: string) => Promise<void> | void;
};

/** The rename sheet the floating peek's Rename opens. It owns its own state,
 * so opening it re-renders this sheet and not all of Home. */
export function IslandMenuSheet({ ref, onRename }: Props) {
  const { t } = useT();
  const dir = useDir();
  // Which island it is for.
  const [menuItem, setMenuItem] = useState<api.IslandSummary | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  // An action a sheet row picked, run once the sheet has fully closed (an
  // Alert shown while the Modal is dismissing can vanish on iOS otherwise).
  const afterSheet = useRef<(() => void) | null>(null);
  function closeSheetThen(fn: () => void) {
    afterSheet.current = fn;
    setMenuItem(null);
  }
  function runAfterSheet() {
    const fn = afterSheet.current;
    afterSheet.current = null;
    if (fn) fn();
  }
  useImperativeHandle(
    ref,
    () => ({
      openRename: (item) => {
        setDraftTitle(item.title);
        setMenuItem(item);
      },
    }),
    [],
  );
  function saveRename() {
    const item = menuItem;
    if (!item) return;
    const title = draftTitle;
    closeSheetThen(() => void onRename(item.id, title));
  }

  return (
    <BottomSheet
      open={menuItem !== null}
      onClose={() => setMenuItem(null)}
      onDismissed={runAfterSheet}
      title={menuItem?.title || t('home.untitledIsland')}
      contentTitle
      avoidKeyboard>
      <GlassInput
        autoFocus
        value={draftTitle}
        onChangeText={setDraftTitle}
        onSubmitEditing={saveRename}
        returnKeyType="done"
        style={[styles.sheetInput, dir.content]}
      />
      <GlassPanel style={[styles.sheetActionsRow, dir.rtl && styles.sheetActionsRowRtl]}>
        <PrismButton shape="pill" verb="tools" flat label={t('home.save')} onPress={saveRename}>
          <SymbolView name={{ ios: 'checkmark', android: 'check' }} size={16} weight="regular" tintColor={verb.tools.c1} />
        </PrismButton>
      </GlassPanel>
    </BottomSheet>
  );
}

/** offline-islands: the sheet's download control. Its own component, so the
 * per-file progress re-renders this pill and not all of Home. */
export function useDownloadAction(id: string, closeThen: (fn: () => void) => void) {
  const { t } = useT();
  const download = useDownloadStatus(id);
  const onPress = () => {
    if (download.state === 'none' || download.state === 'failed') {
      void startDownload(id);
    } else if (download.state === 'downloading') {
      closeThen(() => {
        void confirmSheet({
          title: t('home.downloadStopTitle'),
          actions: [
            { label: t('home.downloadKeepGoing'), verb: 'tools' },
            { label: t('home.downloadStop'), verb: 'speak', destructive: true },
          ],
        }).then((pick) => {
          if (pick === 1) cancelDownload(id);
        });
      });
    } else {
      closeThen(() => {
        void confirmSheet({
          title: t('home.downloadRemoveTitle'),
          message: t('home.downloadRemoveBody'),
          actions: [
            { label: t('common.cancel'), verb: 'tools' },
            { label: t('home.downloadRemove'), verb: 'speak', destructive: true },
          ],
        }).then((pick) => {
          if (pick === 1) removeDownload(id);
        });
      });
    }
  };
  const label =
    download.state === 'done'
      ? t('home.downloaded', { size: humanBytes(download.bytes) })
      : download.state === 'downloading'
        ? t('home.downloading', { done: download.done, total: download.total })
        : download.state === 'failed'
          ? t('home.downloadFailed')
          : t('home.download');
  const done = download.state === 'done';
  return { label, onPress, done };
}

const styles = StyleSheet.create({
  sheetInput: { marginBottom: Spacing.sm },
  // prism-home: one row of pill actions sharing a single GlassPanel blur.
  sheetActionsRow: { flexDirection: 'row', gap: Spacing.sm, padding: Spacing.sm, alignSelf: 'flex-start' },
  sheetActionsRowRtl: { alignSelf: 'flex-end' },
});
