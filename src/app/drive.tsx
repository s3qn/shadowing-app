import { useLocalSearchParams, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PrismButton } from '@/components/prism/prism-button';
import { PlayerTitle } from '@/components/tide/player-title';
import { fonts } from '@/constants/fonts';
import { Radius, Spacing, tide, verb } from '@/constants/theme';
import { useDrive, type DrivePhase } from '@/hooks/use-drive';
import { hapticSelection } from '@/lib/haptics';
import { useDir, useT } from '@/lib/i18n';
import { LOADER_OUT_MS, loaderShown, requestLoader } from '@/lib/loading-overlay';
import { useSkyStyle } from '@/lib/sky';

/** The stack's fade into this screen (`animationDuration` of `drive` in app/_layout.tsx). */
const SCREEN_FADE_MS = 250;
const FG_IN_MS = 180;

function labelColour(phase: DrivePhase): string {
  if (phase === 'listen') return verb.listen.c1;
  if (phase === 'repeat') return verb.speak.c1;
  return tide.textDim;
}

/**
 * Drive Mode: the user's islands as one hands-free radio. The whole area
 * between the top and bottom rows is one tap target: pause, or replay the
 * current line when paused. Nothing here animates on a timer.
 */
export default function DriveScreen() {
  const { id, line: lineParam } = useLocalSearchParams<{ id?: string; line?: string }>();
  const { t } = useT();
  const dir = useDir();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const sky = useSkyStyle();
  const reduced = useReducedMotion();
  const lineNo = lineParam !== undefined ? Number(lineParam) : undefined;
  const d = useDrive({ id, line: lineNo !== undefined && Number.isFinite(lineNo) ? lineNo : undefined });
  const { phase, island, line } = d;

  // Home stays under this screen while it fades in: nothing of its own (the loader included)
  // shows until the fade is done, so the two screens' text never mix.
  const [landed, setLanded] = useState(reduced);
  useEffect(() => {
    if (landed) return;
    const id = setTimeout(() => setLanded(true), SCREEN_FADE_MS);
    return () => clearTimeout(id);
  }, [landed]);
  const fg = useSharedValue(landed ? 1 : 0);
  useEffect(() => {
    if (landed) fg.value = reduced ? 1 : withTiming(1, { duration: FG_IN_MS, easing: Easing.out(Easing.quad) });
  }, [landed, reduced, fg]);
  const fgStyle = useAnimatedStyle(() => ({ opacity: Number.isFinite(fg.value) ? fg.value : 1 }));
  useEffect(() => {
    requestLoader(landed && phase === 'loading');
  }, [landed, phase]);
  useEffect(() => () => requestLoader(false), []);

  const paused = phase === 'paused';
  const dim = useSharedValue(1);
  useEffect(() => {
    const to = paused ? 0.55 : 1;
    dim.value = reduced ? to : withTiming(to, { duration: 200, easing: Easing.out(Easing.quad) });
  }, [paused, reduced, dim]);
  const blockStyle = useAnimatedStyle(() => ({ opacity: dim.value }));
  const fillStyle = useAnimatedStyle(() => ({ width: `${Math.max(0, Math.min(1, d.progress.value)) * 100}%` }));

  const colour = labelColour(phase);
  const labelKey =
    phase === 'listen' ? 'drive.listen' : phase === 'repeat' ? 'drive.repeat' : phase === 'offline' ? 'drive.offline' : 'drive.paused';
  // The line waits out the loading phase (its audio is still on the way): the loader stands in for it.
  const showText = line !== null && phase !== 'empty' && phase !== 'offline' && phase !== 'loading';
  // Arriving while the loader is still drawn, the line waits for its fade-out instead of showing under it.
  const afterLoader = phase !== 'loading' && loaderShown.value > 0.01 ? LOADER_OUT_MS : 0;

  const close = () => (router.canGoBack() ? router.back() : router.replace('/'));

  return (
    <View style={[styles.root, { backgroundColor: sky.top }]}>
      <View style={[StyleSheet.absoluteFill, sky.from]} />
      <Animated.View style={[StyleSheet.absoluteFill, sky.to, sky.fadeStyle]} />
      <Animated.View style={[styles.root, fgStyle]}>
        <View style={[styles.top, { paddingTop: insets.top + Spacing.sm }, dir.row]}>
          <PrismButton
            shape="round"
            verb="tools"
            size={36}
            flat
            onPress={close}
            accessibilityLabel={t('drive.close')}
            containerStyle={styles.close}>
            <SymbolView name={{ ios: 'xmark', android: 'close' }} size={16} weight="semibold" tintColor={verb.tools.c1} />
          </PrismButton>
          <View style={styles.title}>
            {island ? (
              <PlayerTitle title={island.title} lineIndex={line?.idx ?? 0} lineCount={island.lineCount} />
            ) : (
              <Text style={styles.titleOnly}>{t('drive.title')}</Text>
            )}
          </View>
          <View style={styles.close} />
        </View>

        <Pressable
          style={styles.tap}
          accessibilityRole="button"
          accessibilityLabel={paused ? t('drive.tapToReplay') : t('drive.pauseAction')}
          disabled={phase === 'loading' || phase === 'empty'}
          onPress={() => {
            void hapticSelection();
            d.toggle();
          }}>
          {phase === 'empty' ? (
            <Text style={styles.empty}>{t('drive.empty')}</Text>
          ) : (
            <Animated.View style={[styles.block, blockStyle]}>
              {phase !== 'loading' ? (
                <Animated.View
                  entering={reduced ? undefined : FadeIn.delay(afterLoader).duration(FG_IN_MS).easing(Easing.out(Easing.quad))}
                  style={styles.block}>
                  <Animated.View
                    key={labelKey}
                    entering={reduced ? undefined : FadeIn.duration(180).easing(Easing.linear)}
                    exiting={reduced ? undefined : FadeOut.duration(180).easing(Easing.linear)}>
                    <Text style={[styles.label, { color: colour }]}>{t(labelKey)}</Text>
                  </Animated.View>
                  {showText ? (
                    <>
                      <Text style={styles.ja} adjustsFontSizeToFit numberOfLines={4}>
                        {line.ja}
                      </Text>
                      {line.en ? (
                        <Text style={styles.en} numberOfLines={3}>
                          {line.en}
                        </Text>
                      ) : null}
                      <View style={styles.track}>
                        <Animated.View style={[styles.fill, { backgroundColor: colour }, fillStyle]} />
                      </View>
                      {paused ? <Text style={styles.hint}>{t('drive.tapToReplay')}</Text> : null}
                    </>
                  ) : null}
                </Animated.View>
              ) : null}
            </Animated.View>
          )}
        </Pressable>

        <View style={[styles.bottom, { paddingBottom: insets.bottom + Spacing.lg }, dir.row]}>
          <PrismButton
            shape="round"
            verb="tools"
            size={56}
            flat
            onPress={d.previous}
            disabled={phase === 'empty' || phase === 'loading'}
            accessibilityLabel={t('drive.previousLine')}>
            <SymbolView name={{ ios: 'backward.end.fill', android: 'skip_previous' }} size={22} weight="regular" tintColor={verb.tools.c1} />
          </PrismButton>
          <PrismButton
            shape="round"
            verb="tools"
            size={56}
            flat
            onPress={d.next}
            disabled={phase === 'empty' || phase === 'loading'}
            accessibilityLabel={t('drive.nextLine')}>
            <SymbolView name={{ ios: 'forward.end.fill', android: 'skip_next' }} size={22} weight="regular" tintColor={verb.tools.c1} />
          </PrismButton>
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  top: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: Spacing.lg, paddingBottom: Spacing.sm },
  close: { width: 36, height: 36 },
  title: { flex: 1, alignItems: 'center' },
  titleOnly: { color: tide.text, fontFamily: fonts.ui, fontSize: 16, fontWeight: '600' },
  tap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: Spacing.xl },
  block: { alignItems: 'center', alignSelf: 'stretch' },
  label: { fontSize: 13, fontWeight: '700', letterSpacing: 1.5, textTransform: 'uppercase', fontFamily: fonts.ui, marginBottom: Spacing.md, textAlign: 'center' },
  ja: { fontFamily: fonts.ui, fontSize: 30, fontWeight: '600', lineHeight: 42, color: tide.text, textAlign: 'center' },
  en: { fontFamily: fonts.ui, fontSize: 17, lineHeight: 24, color: tide.textDim, textAlign: 'center', marginTop: Spacing.md },
  track: { marginTop: Spacing.xl, width: '60%', height: 3, borderRadius: Radius.pill, backgroundColor: 'rgba(255,255,255,0.10)', overflow: 'hidden' },
  fill: { height: 3, borderRadius: Radius.pill },
  hint: { marginTop: Spacing.md, fontSize: 13, fontFamily: fonts.ui, color: tide.textDim, textAlign: 'center' },
  empty: { fontFamily: fonts.ui, fontSize: 17, lineHeight: 24, color: tide.textDim, textAlign: 'center' },
  bottom: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: Spacing.xl },
});
