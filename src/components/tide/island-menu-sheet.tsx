import { memo, useEffect, useState } from 'react';
import { StyleSheet, Text } from 'react-native';

import { BottomSheet } from '@/components/sheet/bottom-sheet';
import { SheetAction, type SheetIcon } from '@/components/sheet/sheet-rows';
import { GlassInput } from '@/components/tide/glass-input';
import { fonts } from '@/constants/fonts';
import { Spacing, tide, verb } from '@/constants/theme';
import { useDir, useT } from '@/lib/i18n';
import type { Complexity } from '@/lib/api';

/** Row icons: SF Symbol on iOS, the matching Material Symbol on Android. */
const ICONS = {
  save: { ios: 'checkmark', android: 'check' },
  rename: { ios: 'pencil', android: 'edit' },
  export: { ios: 'square.and.arrow.up', android: 'ios_share' },
  beforeAfter: { ios: 'arrow.left.arrow.right', android: 'compare_arrows' },
  revoice: { ios: 'person.wave.2', android: 'record_voice_over' },
  regenerate: { ios: 'arrow.clockwise', android: 'refresh' },
  calibrate: { ios: 'speaker.wave.2', android: 'volume_up' },
  watch: { ios: 'play.rectangle', android: 'smart_display' }, // youtube-shadowing
  listen: { ios: 'headphones', android: 'headphones' }, // podcast-listen
  delete: { ios: 'trash', android: 'delete' },
} satisfies Record<string, SheetIcon>;

type Props = {
  open: boolean;
  onClose: () => void;
  onDismissed?: () => void;
  title: string;
  complexity: Complexity;
  /** Revoicing or regenerating: both replace the island's lines. */
  busy: boolean;
  /** Playing from a download with no connection: every row needs the server. */ // offline-islands
  offline: boolean;
  recording: boolean;
  exporting: boolean;
  /** Null hides the Re-voice row: the island is already in the chosen voice. */
  revoiceName: string | null;
  /** False hides Re-voice and Regenerate: only a recorded island has the
   * recording and VOICEVOX lines both need. */
  recorded: boolean;
  onRename: (title: string) => void;
  onExport: () => void;
  onBeforeAfter: () => void;
  /** Set only on a YouTube island: adds the Watch the video row. */ // youtube-shadowing
  onWatch?: () => void;
  onListen?: () => void; // podcast-listen
  onRevoice: () => void;
  onRegenerate: () => void;
  onCalibrate: () => void;
  onDelete: () => void;
};

/**
 * The header `…` menu: rename, export, re-voice, regenerate, calibrate and
 * delete, on the same sheet library as the toolbar. Every row but Rename
 * calls its prop directly; the screen closes the sheet and defers the action
 * to `onDismissed`, so an Alert or a share sheet never races the Modal
 * dismissing.
 */
function IslandMenuSheetBase({
  open,
  onClose,
  onDismissed,
  title,
  complexity,
  busy,
  offline,
  recording,
  exporting,
  revoiceName,
  recorded,
  onRename,
  onExport,
  onBeforeAfter,
  onWatch, // youtube-shadowing
  onListen, // podcast-listen
  onRevoice,
  onRegenerate,
  onCalibrate,
  onDelete,
}: Props) {
  const { t } = useT();
  const dir = useDir();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(title);

  useEffect(() => {
    if (open) {
      // A fresh open always starts on the menu, not mid-rename from last time.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRenaming(false);
      setDraft(title);
    }
  }, [open, title]);

  function saveRename() {
    onRename(draft.trim());
  }

  return (
    <BottomSheet open={open} onClose={onClose} onDismissed={onDismissed} title={t('player.islandMenu')} avoidKeyboard>
      {renaming ? (
        <>
          <GlassInput
            autoFocus
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={saveRename}
            returnKeyType="done"
            // The island's own title, ordered by its own script.
            style={[styles.input, dir.content]}
          />
          <SheetAction label={t('player.save')} icon={ICONS.save} discColor={verb.tools.c1} onPress={saveRename} />
        </>
      ) : (
        <>
          {offline ? <Text style={[styles.offlineLine, dir.text]}>{t('player.offlineMenu')}</Text> : null}
          <SheetAction label={t('player.rename')} icon={ICONS.rename} discColor={verb.tools.c1} disabled={offline} onPress={() => setRenaming(true)} />
          <SheetAction
            label={exporting ? t('player.exporting') : t('player.exportAsAudio')}
            icon={ICONS.export}
            discColor={verb.tools.c1}
            disabled={exporting || busy || offline}
            onPress={onExport}
          />
          <SheetAction
            label={t('beforeAfter.title')}
            icon={ICONS.beforeAfter}
            discColor={verb.tools.c1}
            disabled={recording || busy}
            onPress={onBeforeAfter}
          />
          {onWatch ? ( // youtube-shadowing
            <SheetAction
              label={t('video.watch')}
              icon={ICONS.watch}
              discColor={verb.tools.c1}
              disabled={recording || busy}
              onPress={onWatch}
            />
          ) : null}
          {onListen ? ( // podcast-listen
            <SheetAction
              label={t('podcast.listen')}
              icon={ICONS.listen}
              discColor={verb.tools.c1}
              disabled={recording || busy}
              onPress={onListen}
            />
          ) : null}
          {recorded && revoiceName ? (
            <SheetAction
              label={busy ? t('player.revoicing') : t('player.revoiceIn', { name: revoiceName })}
              icon={ICONS.revoice}
              discColor={verb.tools.c1}
              disabled={busy || offline}
              onPress={onRevoice}
            />
          ) : null}
          {recorded ? (
            <SheetAction
              label={complexity === 'simple' ? t('player.regenerateComplex') : t('player.regenerateSimple')}
              icon={ICONS.regenerate}
              discColor={verb.tools.c1}
              disabled={busy || offline}
              onPress={onRegenerate}
            />
          ) : null}
          <SheetAction
            label={t('player.calibrateSpeaker')}
            icon={ICONS.calibrate}
            discColor={verb.tools.c1}
            disabled={recording || offline}
            onPress={onCalibrate}
          />
          <SheetAction
            label={t('player.deleteIsland')}
            icon={ICONS.delete}
            destructive
            discColor={verb.speak.c1}
            disabled={busy || offline}
            onPress={onDelete}
          />
        </>
      )}
    </BottomSheet>
  );
}

/** Memoised: the player screen renders often, and a closed sheet has
 * nothing to redraw. Its handler props come through useStableHandler. */
export const IslandMenuSheet = memo(IslandMenuSheetBase);

const styles = StyleSheet.create({
  offlineLine: { fontFamily: fonts.ui, fontSize: 12, color: tide.textDim, marginBottom: 4 },
  input: { marginBottom: Spacing.sm },
});
