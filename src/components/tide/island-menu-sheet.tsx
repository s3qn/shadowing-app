import { memo, useEffect, useState } from 'react';
import { StyleSheet, TextInput } from 'react-native';

import { BottomSheet } from '@/components/sheet/bottom-sheet';
import { SheetAction, type SheetIcon } from '@/components/sheet/sheet-rows';
import { fonts } from '@/constants/fonts';
import { tide } from '@/constants/theme';
import type { Complexity } from '@/lib/api';

/** Row icons: SF Symbol on iOS, the matching Material Symbol on Android. */
const ICONS = {
  save: { ios: 'checkmark', android: 'check' },
  rename: { ios: 'pencil', android: 'edit' },
  export: { ios: 'square.and.arrow.up', android: 'ios_share' },
  revoice: { ios: 'person.wave.2', android: 'record_voice_over' },
  regenerate: { ios: 'arrow.clockwise', android: 'refresh' },
  calibrate: { ios: 'speaker.wave.2', android: 'volume_up' },
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
  recording: boolean;
  exporting: boolean;
  /** Null hides the Re-voice row: the island is already in the chosen voice. */
  revoiceName: string | null;
  onRename: (title: string) => void;
  onExport: () => void;
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
  recording,
  exporting,
  revoiceName,
  onRename,
  onExport,
  onRevoice,
  onRegenerate,
  onCalibrate,
  onDelete,
}: Props) {
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
    <BottomSheet open={open} onClose={onClose} onDismissed={onDismissed} title="Island menu" avoidKeyboard>
      {renaming ? (
        <>
          <TextInput
            autoFocus
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={saveRename}
            returnKeyType="done"
            style={styles.input}
          />
          <SheetAction label="Save" icon={ICONS.save} onPress={saveRename} />
        </>
      ) : (
        <>
          <SheetAction label="Rename" icon={ICONS.rename} onPress={() => setRenaming(true)} />
          <SheetAction
            label={exporting ? 'Exporting…' : 'Export as audio'}
            icon={ICONS.export}
            disabled={exporting || busy}
            onPress={onExport}
          />
          {revoiceName ? (
            <SheetAction
              label={busy ? 'Re-voicing…' : `Re-voice in ${revoiceName}`}
              icon={ICONS.revoice}
              disabled={busy}
              onPress={onRevoice}
            />
          ) : null}
          <SheetAction
            label={complexity === 'simple' ? 'Regenerate with complex patterns' : 'Regenerate one sentence at a time'}
            icon={ICONS.regenerate}
            disabled={busy}
            onPress={onRegenerate}
          />
          <SheetAction label="Calibrate speaker" icon={ICONS.calibrate} disabled={recording} onPress={onCalibrate} />
          <SheetAction label="Delete island" icon={ICONS.delete} destructive disabled={busy} onPress={onDelete} />
        </>
      )}
    </BottomSheet>
  );
}

/** Memoised: the player screen renders often, and a closed sheet has
 * nothing to redraw. Its handler props come through useStableHandler. */
export const IslandMenuSheet = memo(IslandMenuSheetBase);

const styles = StyleSheet.create({
  input: {
    fontFamily: fonts.ui,
    fontSize: 16,
    color: tide.text,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 8,
  },
});
