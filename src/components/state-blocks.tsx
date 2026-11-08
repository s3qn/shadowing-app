import { StyleSheet, Text, View } from 'react-native';

import { CatConstellation } from '@/components/cat-constellation';
import { PrismButton } from '@/components/prism/prism-button';
import { SecondaryAction } from '@/components/prism/actions';
import { fonts } from '@/constants/fonts';
import { Spacing, tide } from '@/constants/theme';
import { useDir, useT } from '@/lib/i18n';

/**
 * The one loading state: the cat constellation with `common.loading` and the
 * pulsing dots. Full (120, fills the screen and centres) or `inline` (48, sits
 * in a row or a card).
 */
export function LoadingBlock({ inline }: { inline?: boolean }) {
  const { t } = useT();
  if (inline) {
    return (
      <View style={styles.inline}>
        <CatConstellation size={48} compact label={t('common.loading')} />
      </View>
    );
  }
  return (
    <View style={styles.center}>
      <CatConstellation size={120} label={t('common.loading')} />
    </View>
  );
}

/** A titled empty list: what is missing and what to do about it. */
export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: { label: string; onPress: () => void } }) {
  const dir = useDir();
  return (
    <View style={styles.center}>
      <Text style={[styles.title, dir.writing]}>{title}</Text>
      {hint ? <Text style={[styles.hint, dir.writing]}>{hint}</Text> : null}
      {action ? <PrismButton shape="pill" verb="listen" label={action.label} onPress={action.onPress} /> : null}
    </View>
  );
}

/** A failed load: the message and a Retry (a SecondaryAction). */
export function ErrorState({ message, onRetry, retryLabel }: { message: string; onRetry: () => void; retryLabel?: string }) {
  const { t } = useT();
  const dir = useDir();
  return (
    <View style={styles.center}>
      <Text style={[styles.hint, dir.writing]}>{message}</Text>
      <SecondaryAction label={retryLabel ?? t('common.retry')} onPress={onRetry} />
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.lg, paddingHorizontal: 16 },
  inline: { alignItems: 'center', justifyContent: 'center', paddingVertical: Spacing.md },
  title: { fontSize: 20, fontWeight: '700', color: tide.text, fontFamily: fonts.ui, textAlign: 'center' },
  hint: { fontSize: 14, lineHeight: 20, color: tide.textDim, fontFamily: fonts.ui, textAlign: 'center' },
});
