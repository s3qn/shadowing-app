import { StyleSheet, View } from 'react-native';

import { PASSES, PassExplainer } from '@/components/onboarding/pass-step';
import { StepAction } from '@/components/onboarding/step-frame';
import { BottomSheet } from '@/components/sheet/bottom-sheet';
import { useT } from '@/lib/i18n';
import type { NativeLanguage } from '@/lib/api';
import type { LearningLanguage } from '@/lib/settings';

/**
 * The "how this pass works" sheet behind the strip's ? glyph. Display only:
 * the run keeps going underneath.
 */
export function PassHelpSheet({
  open,
  pass,
  learning,
  understood,
  onClose,
}: {
  open: boolean;
  pass: 0 | 1 | 2 | 3 | 4;
  learning: LearningLanguage;
  understood: NativeLanguage;
  onClose: () => void;
}) {
  const { t } = useT();
  return (
    <BottomSheet open={open} onClose={onClose}>
      <View style={styles.body}>
        <PassExplainer pass={pass} learning={learning} understood={understood} />
        <View style={styles.action}>
          <StepAction verb={PASSES[pass].nextVerb} label={t('settings.onboarding.gotIt')} onPress={onClose} />
        </View>
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  body: { gap: 16, paddingTop: 4, paddingBottom: 8 },
  action: { alignItems: 'center' },
});
