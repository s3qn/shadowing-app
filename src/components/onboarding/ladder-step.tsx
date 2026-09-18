import { StyleSheet, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols';

import { PASSES, type PassInfo } from '@/components/onboarding/pass-step';
import { StepAction, StepCopy, StepFrame } from '@/components/onboarding/step-frame';
import { fonts } from '@/constants/fonts';
import { Spacing, tide, withAlpha } from '@/constants/theme';
import { useDir, useT } from '@/lib/i18n';

/** One rung: the pass's symbol in a disc of its own colour, the name with a
 * short line under it, and the speed on the trailing side. Built like the
 * settings and sheet rows (leading icon, label, trailing value), with the
 * second line and the per-row colour those rows do not carry. */
function Rung({ info }: { info: PassInfo }) {
  const { t } = useT();
  const dir = useDir();
  return (
    <View style={[styles.rung, dir.row]}>
      <View style={[styles.disc, { backgroundColor: withAlpha(info.colour, 0.16) }]}>
        <SymbolView name={info.icon} size={17} weight="regular" tintColor={info.colour} />
      </View>
      <View style={styles.text}>
        <Text style={[styles.name, dir.text]}>{t(info.titleKey)}</Text>
        <Text style={[styles.line, dir.text]}>{t(info.ladderLineKey)}</Text>
      </View>
      {/* The speed is a number pair: the Hebrew string isolates it so 0.85×
          keeps its order on a right to left line. */}
      <Text style={[styles.speed, { color: info.colour }]}>
        {t('settings.onboarding.ladderSpeed', { speed: info.speed })}
      </Text>
    </View>
  );
}

/**
 * The method overview: the five passes on one screen, in the order they run,
 * with the speed each one plays at. It sits between the microphone question
 * and the first pass, so the walkthrough that follows is already placed.
 * The rows read from the same `PASSES` table the pass steps use, so the names,
 * colours and speeds cannot drift apart.
 */
export function LadderStep({ onNext }: { onNext: () => void }) {
  const { t } = useT();
  return (
    <StepFrame
      footer={<StepAction verb="listen" label={t('settings.onboarding.ladderAction')} onPress={onNext} />}>
      <StepCopy
        kicker={t('settings.onboarding.ladderKicker')}
        title={t('settings.onboarding.ladderTitle')}
        body={t('settings.onboarding.ladderLine')}
      />
      <View style={styles.ladder}>
        {PASSES.map((info) => (
          <Rung key={info.titleKey} info={info} />
        ))}
      </View>
    </StepFrame>
  );
}

const styles = StyleSheet.create({
  ladder: { gap: 7 },
  rung: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    paddingVertical: 8,
    paddingHorizontal: 11,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  disc: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  text: { flex: 1, gap: 1 },
  name: { fontFamily: fonts.uiMedium, fontSize: 15, fontWeight: '700', color: tide.text },
  line: { fontFamily: fonts.ui, fontSize: 12, color: tide.textDim },
  speed: {
    fontFamily: fonts.uiMedium,
    fontSize: 12,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
    marginHorizontal: Spacing.xs,
  },
});
