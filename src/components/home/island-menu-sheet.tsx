import { SymbolView } from 'expo-symbols';
import { useImperativeHandle, useRef, useState, type Ref } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { GlassPanel } from '@/components/prism/glass-panel';
import { PrismButton } from '@/components/prism/prism-button';
import { BottomSheet } from '@/components/sheet/bottom-sheet';
import { GlassInput } from '@/components/tide/glass-input';
import { fonts } from '@/constants/fonts';
import { Radius, Spacing, verb, withAlpha } from '@/constants/theme';
import type * as api from '@/lib/api';
import { confirmSheet } from '@/lib/confirm-sheet';
import { useDir, useT } from '@/lib/i18n';
import { cancelDownload, humanBytes, removeDownload, startDownload, useDownloadStatus } from '@/lib/offline-islands';

export type IslandMenuHandle = { open: (item: api.IslandSummary) => void };

type Props = {
  ref: Ref<IslandMenuHandle>;
  onRename: (id: string, title: string) => Promise<void> | void;
  onDelete: (item: api.IslandSummary) => Promise<void> | void;
};

/** The Rename/Delete/Download sheet a long press on a card opens. It owns its
 * own state, so opening it re-renders this sheet and not all of Home. */
export function IslandMenuSheet({ ref, onRename, onDelete }: Props) {
  const { t } = useT();
  const dir = useDir();
  // Which island it is for, and whether it is showing the menu or the rename field.
  const [menuItem, setMenuItem] = useState<api.IslandSummary | null>(null);
  const [renaming, setRenaming] = useState(false);
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
      open: (item) => {
        setRenaming(false);
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
      {/* prism-home: edited region */}
      {renaming ? (
        <>
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
        </>
      ) : (
        <>
        <GlassPanel style={[styles.sheetMenuRow, dir.row]}>
          <PrismButton
            shape="pill"
            verb="tools"
            flat
            containerStyle={styles.sheetActionPill}
            label={t('home.rename')}
            onPress={() => setRenaming(true)}>
            <SymbolView name={{ ios: 'pencil', android: 'edit' }} size={16} weight="regular" tintColor={verb.tools.c1} />
          </PrismButton>
          {/* Delete reads as destructive: red label, red icon, red-tinted glass
              fill. The label is a plain Text rather than the `label` prop so it
              can take the verb colour outright, with no "on" state involved. */}
          <View style={styles.sheetDeleteFill}>
            <PrismButton
              shape="pill"
              verb="speak"
              flat
              containerStyle={styles.sheetActionPill}
              accessibilityLabel={t('home.deleteIsland')}
              onPress={() => {
                const item = menuItem;
                if (!item) return;
                closeSheetThen(() => void onDelete(item));
              }}>
              <SymbolView name={{ ios: 'trash', android: 'delete' }} size={16} weight="regular" tintColor={verb.speak.c1} />
              <Text style={styles.sheetDeleteLabel}>{t('home.deleteIsland')}</Text>
            </PrismButton>
          </View>
        </GlassPanel>
        {/* offline-islands: one control, three states */}
        {menuItem?.status === 'ready' ? (
          <GlassPanel style={styles.sheetMenuRow}>
            <DownloadPill id={menuItem.id} closeThen={closeSheetThen} />
          </GlassPanel>
        ) : null}
        </>
      )}
      {/* prism-home: end */}
    </BottomSheet>
  );
}

/** offline-islands: the sheet's download control. Its own component, so the
 * per-file progress re-renders this pill and not all of Home. */
function DownloadPill({ id, closeThen }: { id: string; closeThen: (fn: () => void) => void }) {
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
  return (
    <PrismButton
      shape="pill"
      verb="tools"
      flat
      containerStyle={styles.sheetActionPill}
      label={label}
      onPress={onPress}>
      <SymbolView
        name={
          download.state === 'done'
            ? { ios: 'arrow.down.circle.fill', android: 'download' }
            : { ios: 'arrow.down.circle', android: 'download' }
        }
        size={16}
        weight="regular"
        tintColor={verb.tools.c1}
      />
    </PrismButton>
  );
}

const styles = StyleSheet.create({
  sheetInput: { marginBottom: Spacing.sm },
  // prism-home: one row of pill actions sharing a single GlassPanel blur.
  sheetActionsRow: { flexDirection: 'row', gap: Spacing.sm, padding: Spacing.sm, alignSelf: 'flex-start' },
  sheetActionsRowRtl: { alignSelf: 'flex-end' },
  // The Rename/Delete row: both pills share the sheet's full width (no
  // alignSelf hug), evenly split with a 12pt gap between them.
  sheetMenuRow: { flexDirection: 'row', gap: Spacing.md, padding: Spacing.sm },
  sheetActionPill: { flex: 1 },
  // Clips the red tint to the pill's own rounded shape, matching PrismFace's
  // pill radius (999) rather than the panel's squarer one.
  sheetDeleteFill: { flex: 1, borderRadius: Radius.pill, overflow: 'hidden', backgroundColor: withAlpha(verb.speak.c1, 0.18) },
  sheetDeleteLabel: {
    fontFamily: fonts.ui,
    fontWeight: '600',
    fontSize: 13,
    color: verb.speak.c1,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 6,
    textShadowColor: withAlpha(verb.speak.c1, 0.55),
  },
});
