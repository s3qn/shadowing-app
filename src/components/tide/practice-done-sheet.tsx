import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { PrismButton } from '@/components/prism';
import { BottomSheet } from '@/components/sheet/bottom-sheet';
import { fonts } from '@/constants/fonts';
import { tide } from '@/constants/theme';
import { useDir, useT } from '@/lib/i18n';
import type { AutoChain } from '@/lib/auto-practice';

export type PracticeDoneSheetProps = {
  open: boolean;
  onClose: () => void;
  onDismissed?: () => void;
  /** The finished chain; the sheet shows `auto.end`. */
  auto: AutoChain | null;
  onDone: () => void;
  /** Offers the review project with the most due cards once the lesson is over. */
  review?: { label: string; onPress: () => void } | null;
};

/**
 * The summary the Practice today chain ends on: lines shadowed, minutes and
 * skipped islands, with Continue review (when cards are due) and Done. The
 * passes themselves run in the dock's strip.
 */
function PracticeDoneSheetBase({ open, onClose, onDismissed, auto, onDone, review }: PracticeDoneSheetProps) {
  const { t } = useT();
  const dir = useDir();
  const summary = auto?.end ?? null;

  return (
    <BottomSheet open={open} onClose={onClose} onDismissed={onDismissed} title={t('player.autoEcho')} hint={summary ? t('player.autoDoneTitle') : undefined}>
      {summary ? (
        <View style={styles.body}>
          <Text style={[styles.line, dir.text]}>{t('player.autoShadowed', { count: summary.shadowed })}</Text>
          <Text style={[styles.sub, dir.text]}>
            {[t('home.minutes', { count: summary.minutes }), summary.skipped > 0 ? t('player.autoSkipped', { count: summary.skipped }) : null]
              .filter(Boolean)
              .join(' · ')}
          </Text>
          <View style={styles.controls}>
            {review ? (
              <PrismButton shape="pill" verb="read" label={review.label} onPress={review.onPress} accessibilityRole="button" accessibilityLabel={review.label} />
            ) : null}
            <PrismButton shape="pill" verb="tools" label={t('player.autoDone')} onPress={onDone} accessibilityRole="button" accessibilityLabel={t('player.autoDone')} />
          </View>
        </View>
      ) : null}
    </BottomSheet>
  );
}

/** Memoised: the player screen renders often, and a closed sheet has
 * nothing to redraw. Its handler props come through useStableHandler. */
export const PracticeDoneSheet = memo(PracticeDoneSheetBase);

const styles = StyleSheet.create({
  body: { gap: 6, paddingTop: 4 },
  line: { fontFamily: fonts.uiMedium, fontSize: 16, color: tide.text },
  sub: { fontFamily: fonts.ui, fontSize: 14, color: tide.textDim },
  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 20, minHeight: 52, marginTop: 14 },
});
