import { BlurView } from 'expo-blur';
import { SymbolView } from 'expo-symbols';
import { memo } from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Animated, { FadeIn, FadeOut, useAnimatedStyle, type SharedValue } from 'react-native-reanimated';

import { SparkleResult, type SparkleResultData } from '@/components/tide/sparkle-result';
import { fonts } from '@/constants/fonts';
import { prism, tide, withAlpha } from '@/constants/theme';
import { useDir, useT } from '@/lib/i18n';
import { segmentIndexOf, segmentsOf, type PassStep, type Programme } from '@/lib/pass-programme';

export type PassStripProps = {
  programme: Programme;
  step: PassStep;
  /** 0..1: how far the live pass has filled. */
  fill: SharedValue<number>;
  result: SparkleResultData;
  /** The screen picks it: the pass hint, the headphones prompt, the unscored note. */
  hint: string;
  /** Chain hold: every mark reads done and the name slot shows `player.autoNext`. */
  holdTitle?: string | null;
  onJump: (i: number) => void;
  onEnd: () => void;
  /** Ladder only. */
  onHelp?: () => void;
  /** Chain only: replaces the end glyph. */
  onSkip?: () => void;
};

const RAIL_HEIGHT = 34;

/**
 * The run's pass rail, rendered in `CompactDock`'s slot while a run is on:
 * one mark per pass (a tap jumps to it), the live pass's name, count and hint,
 * and the help and end glyphs. One pane of glass, not five chips.
 */
export const PassStrip = memo(function PassStrip({
  programme,
  step,
  fill,
  result,
  hint,
  holdTitle,
  onJump,
  onEnd,
  onHelp,
  onSkip,
}: PassStripProps) {
  const { t } = useT();
  const dir = useDir();
  const { width } = useWindowDimensions();
  const segments = segmentsOf(programme);
  const held = !!holdTitle;
  const index = held ? segments.length : segmentIndexOf(step, programme);
  const pass = index >= 0 && index < segments.length ? segments[index]! : null;

  // Guarded: a NaN on the UI thread ends the app in Expo Go without a red box.
  const fillStyle = useAnimatedStyle(() => {
    const f = Number.isFinite(fill.value) ? Math.min(1, Math.max(0, fill.value)) : 0;
    return { width: `${f * 100}%` };
  });

  return (
    <Animated.View
      entering={FadeIn.duration(180)}
      exiting={FadeOut.duration(150)}
      style={{ width: Math.min(width - 24, 400) }}>
      <View style={styles.rail}>
        <BlurView style={StyleSheet.absoluteFill} intensity={prism.blur.intensity} tint={prism.blur.tint} />
        <View style={[StyleSheet.absoluteFill, styles.railFill]} />
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.railRim]} />
        <View pointerEvents="none" style={styles.railTop} />
        <View pointerEvents="none" style={[styles.railFringe, styles.railFringeLeft]} />
        <View pointerEvents="none" style={[styles.railFringe, styles.railFringeRight]} />
        <View style={[styles.railRow, dir.row]}>
          {segments.map((segment, i) => (
            <Pressable
              key={segment.labelKey}
              onPress={() => onJump(i)}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel={t(segment.labelKey)}
              style={[styles.tab, { backgroundColor: withAlpha(segment.colour, 0.05) }]}>
              {i > 0 ? <View pointerEvents="none" style={[styles.divider, dir.rtl ? styles.dividerRtl : styles.dividerLtr]} /> : null}
              {i === index ? (
                <>
                  <View pointerEvents="none" style={[styles.bloom, styles.bloomLow, { backgroundColor: withAlpha(segment.colour, 0.06) }]} />
                  <View pointerEvents="none" style={[styles.bloom, styles.bloomMid, { backgroundColor: withAlpha(segment.colour, 0.09) }]} />
                  <View pointerEvents="none" style={[styles.bloom, styles.bloomHigh, { backgroundColor: withAlpha(segment.colour, 0.14) }]} />
                </>
              ) : null}
              <Text numberOfLines={1} style={[styles.tabLabel, i < index && styles.tabLabelDone, i === index && { color: tide.text }]}>
                {t(segment.labelKey)}
              </Text>
              {i < index ? (
                <View pointerEvents="none" style={[styles.underline, styles.underlineDone, { backgroundColor: withAlpha(segment.colour, 0.5) }]} />
              ) : null}
              {i === index ? (
                <Animated.View
                  pointerEvents="none"
                  style={[styles.underline, dir.rtl ? styles.underlineRtl : styles.underlineLtr, fillStyle, { backgroundColor: segment.colour }]}
                />
              ) : null}
            </Pressable>
          ))}
        </View>
      </View>

      <Animated.View key={index} entering={FadeIn.duration(100)} style={[styles.info, dir.row]}>
        {pass || held ? (
          <>
            <View
              style={[
                styles.dot,
                { backgroundColor: pass?.colour ?? tide.textDim, shadowColor: pass?.colour ?? tide.textDim },
              ]}
            />
            <Text numberOfLines={1} style={[styles.name, { color: pass?.colour ?? tide.textDim }]}>
              {held ? t('player.autoNext', { title: holdTitle }) : t(pass!.labelKey)}
            </Text>
            {pass && !held ? (
              <Text style={styles.count}>{t('player.passOf', { n: index + 1, total: segments.length })}</Text>
            ) : null}
          </>
        ) : null}
        <Text numberOfLines={1} style={[styles.hint, dir.rtl ? styles.hintRtl : styles.hintLtr]}>
          {held ? '' : hint}
        </Text>
        {onHelp ? (
          <Pressable onPress={onHelp} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('player.help')} style={styles.glyph}>
            <SymbolView name={{ ios: 'questionmark.circle', android: 'help_outline' }} size={16} tintColor={tide.textDim} />
          </Pressable>
        ) : null}
        {onSkip ? (
          <Pressable onPress={onSkip} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('player.autoSkip')} style={styles.glyph}>
            <SymbolView name={{ ios: 'forward.end', android: 'skip_next' }} size={16} tintColor={tide.textDim} />
          </Pressable>
        ) : (
          <Pressable onPress={onEnd} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('player.endRun')} style={styles.glyph}>
            <SymbolView name={{ ios: 'xmark', android: 'close' }} size={16} tintColor={tide.textDim} />
          </Pressable>
        )}
      </Animated.View>

      <View pointerEvents="none" style={styles.result}>
        <SparkleResult result={result} />
      </View>
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  rail: { height: RAIL_HEIGHT, borderRadius: 10, overflow: 'hidden' },
  railFill: { backgroundColor: 'rgba(255,255,255,0.045)' },
  railRim: { borderRadius: 10, borderWidth: 1, borderColor: prism.panel.rim },
  railTop: { position: 'absolute', left: 8, right: 8, top: 0, height: 1, backgroundColor: prism.fringe.top },
  railFringe: { position: 'absolute', top: 3, bottom: 3, width: prism.fringe.side },
  railFringeLeft: { left: 0, backgroundColor: prism.fringe.left },
  railFringeRight: { right: 0, backgroundColor: prism.fringe.right },
  railRow: { flexDirection: 'row', flex: 1 },
  tab: { flex: 1, minWidth: 0, alignItems: 'center', justifyContent: 'center' },
  divider: { position: 'absolute', top: 6, bottom: 6, width: StyleSheet.hairlineWidth, backgroundColor: prism.panel.rim },
  dividerLtr: { left: 0 },
  dividerRtl: { right: 0 },
  bloom: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  bloomLow: { height: '70%' },
  bloomMid: { height: '42%' },
  bloomHigh: { height: '20%' },
  tabLabel: { fontFamily: fonts.ui, fontSize: 11, color: withAlpha(tide.textDim, 0.55), paddingHorizontal: 2 },
  tabLabelDone: { color: tide.textDim },
  underline: { position: 'absolute', bottom: 0, height: 2 },
  underlineLtr: { left: 0 },
  underlineRtl: { right: 0 },
  underlineDone: { left: 0, right: 0 },
  info: { flexDirection: 'row', alignItems: 'center', gap: 7, height: 20, marginTop: 6 },
  dot: { width: 7, height: 7, borderRadius: 4, shadowOpacity: 0.9, shadowRadius: 6, shadowOffset: { width: 0, height: 0 }, elevation: 4 },
  name: { fontFamily: fonts.uiMedium, fontWeight: '600', fontSize: 12, letterSpacing: 1.4, textTransform: 'uppercase' },
  count: { fontFamily: fonts.ui, fontSize: 11, color: withAlpha(tide.textDim, 0.7), fontVariant: ['tabular-nums'] },
  hint: { flex: 1, fontFamily: fonts.ui, fontSize: 11, color: tide.textDim },
  hintLtr: { textAlign: 'right' },
  hintRtl: { textAlign: 'left', writingDirection: 'rtl' },
  glyph: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },
  result: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
});
