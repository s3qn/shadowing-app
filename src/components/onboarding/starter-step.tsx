import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import Animated, {
  Easing,
  type SharedValue,
  cancelAnimation,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { EchoLoop, LOOP_T, backOut, clamp01, outCubic, springOut } from '@/components/onboarding/echo-loop';
import { GuideBubble } from '@/components/onboarding/guide-bubble';
import { finiteOr } from '@/components/onboarding/pass-effects';
import { StepCopy, StepFrame } from '@/components/onboarding/step-frame';
import { PrismButton, type Verb } from '@/components/prism';
import { fonts } from '@/constants/fonts';
import { Spacing, tide, verb } from '@/constants/theme';
import { useDir, useT } from '@/lib/i18n';
import { getSettingsSync, type StarterLevel } from '@/lib/settings';

const END = LOOP_T.end;
/** Where the welcome art splits into the cat and the bubble (a fraction of its width). */
const CAT_SPLIT = 0.41;
/** The pills' tints from the mock: the lit tray blue at .78 for New to it, the read gold at .55 for I know some. */
const TINT = { new: 'rgba(47,111,168,0.78)', some: 'rgba(160,120,30,0.55)' } as const;
const PILL_H = 62;
const PILL_GAP = 18;
/** The level bars: three, 4.08 wide, 7.2, 12 and 18 tall; an unlit one sits at 28 %. */
const BAR_H = [7.2, 12, 18];
const BAR_W = 4.08;
/** The art sits 16 pt from each edge in the mock; the frame pads 24. */
const ART_SIDE = 16;

/** One level pill: dim (35 %) and not pressable until the cat has finished, then rises 10 pt with the POP overshoot. */
function LevelPill({
  clock,
  index,
  live,
  verb: v,
  tint,
  bars,
  label,
  line,
  width,
  onPress,
}: {
  clock: SharedValue<number>;
  index: number;
  live: boolean;
  verb: Verb;
  tint: string;
  bars: number;
  label: string;
  line: string;
  width: number;
  onPress: () => void;
}) {
  const dir = useDir();
  const from = LOOP_T.pills + index * LOOP_T.pillStagger;
  const style = useAnimatedStyle(() => {
    const e = backOut(clamp01((finiteOr(clock.value, END) - from) / LOOP_T.pillFor));
    return { opacity: finiteOr(Math.min(1, 0.35 + 0.65 * e), 1), transform: [{ translateY: finiteOr(10 * (1 - e), 0) }] };
  });
  return (
    <Animated.View style={style} pointerEvents={live ? 'auto' : 'none'}>
      <PrismButton shape="pill" verb={v} on tint={tint} width={width} height={PILL_H} accessibilityLabel={label} onPress={onPress}>
        <View style={[styles.pillRow, dir.row]}>
          <View style={styles.bars}>
            {BAR_H.map((h, i) => (
              <View key={i} style={[styles.bar, { height: h, opacity: i < bars ? 1 : 0.28 }]} />
            ))}
          </View>
          <View style={styles.pillText}>
            <Text style={[styles.pillLabel, dir.text]} numberOfLines={1}>
              {label}
            </Text>
            <Text style={[styles.pillLine, dir.text]} numberOfLines={1}>
              {line}
            </Text>
          </View>
        </View>
      </PrismButton>
    </Animated.View>
  );
}

/**
 * The last onboarding step, the Echo Loop welcome (designs/welcome-10/motion):
 * "Hear it. Say it back." over the loop between the headphones and the mic
 * around ありがとう, Kageneko's hello, and the BL-58 level pick. The whole
 * entrance runs on one clock (`LOOP_T`): the bubble rises, the cat nudges,
 * the loop draws itself in, and the pills come live once the cat is done.
 * A tap anywhere before the end jumps to the final state behind a 120 ms
 * fade; reduced motion opens on the final state with a 200 ms fade. Skip is
 * the flow's own pill at the top. Either level pill starts the guide.
 */
export function StarterStep({ onStart, language }: { onStart: (level: StarterLevel) => void; language?: string }) {
  const { t } = useT();
  const reduced = useReducedMotion();
  const { width: screenW } = useWindowDimensions();
  const clock = useSharedValue(reduced ? END : 0);
  const fade = useSharedValue(reduced ? 0 : 1);
  const [live, setLive] = useState(reduced);
  // True once the entrance has ended or been jumped: a later tap does nothing.
  const done = useRef(reduced);
  const liveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (reduced) {
      fade.value = withTiming(1, { duration: 200 });
      return () => cancelAnimation(fade);
    }
    clock.value = withTiming(END, { duration: END, easing: Easing.linear });
    const pillsTimer = setTimeout(() => setLive(true), LOOP_T.pills);
    const endTimer = setTimeout(() => {
      done.current = true;
    }, END);
    return () => {
      clearTimeout(pillsTimer);
      clearTimeout(endTimer);
      if (liveTimer.current) clearTimeout(liveTimer.current);
      cancelAnimation(clock);
      cancelAnimation(fade);
    };
  }, [reduced, clock, fade]);

  // The pills go live once the fade has run, so the touch that skipped the
  // entrance cannot also pick a level (the web replays a tap as a click).
  const JUMP_MS = 120;
  const jump = () => {
    if (done.current) return;
    done.current = true;
    cancelAnimation(clock);
    clock.value = END;
    fade.value = 0.55;
    fade.value = withTiming(1, { duration: JUMP_MS, easing: Easing.out(Easing.quad) });
    liveTimer.current = setTimeout(() => setLive(true), JUMP_MS);
  };

  const fadeStyle = useAnimatedStyle(() => ({ opacity: finiteOr(fade.value, 1) }));
  const bubble = useDerivedValue(() => outCubic(finiteOr(clock.value, END) / LOOP_T.bubble));
  // The cat: scale 1 to 1.04 at 45 % and back, lifted 3 pt then 1 pt then settled, each leg on the SPRING ease.
  const catScale = useDerivedValue(() => {
    const p = clamp01((finiteOr(clock.value, END) - LOOP_T.catFrom) / LOOP_T.catFor);
    return finiteOr(p < 0.45 ? 1 + 0.04 * springOut(p / 0.45) : 1.04 - 0.04 * springOut((p - 0.45) / 0.55), 1);
  });
  const catY = useDerivedValue(() => {
    const p = clamp01((finiteOr(clock.value, END) - LOOP_T.catFrom) / LOOP_T.catFor);
    return finiteOr(p < 0.45 ? -3 + 2 * springOut(p / 0.45) : -1 + springOut((p - 0.45) / 0.55), 0);
  });

  const pillW = Math.max(0, screenW - 2 * Spacing.xl);
  // A touch anywhere (the dim pills included, they let touches through) jumps
  // the entrance: touch events bubble to this view whoever ends up handling them.
  return (
    <View style={styles.fill} onTouchStart={jump}>
      <Animated.View style={[styles.fill, fadeStyle]}>
        <StepFrame
          fill
          footer={
            <View style={styles.pills}>
              <LevelPill
                clock={clock}
                index={0}
                live={live}
                verb="listen"
                tint={TINT.new}
                bars={1}
                label={t('intro.level.new')}
                line={t('intro.level.newLine')}
                width={pillW}
                onPress={() => onStart('new')}
              />
              <LevelPill
                clock={clock}
                index={1}
                live={live}
                verb="read"
                tint={TINT.some}
                bars={3}
                label={t('intro.level.some')}
                line={t('intro.level.someLine')}
                width={pillW}
                onPress={() => onStart('some')}
              />
            </View>
          }>
          <StepCopy kicker={t('intro.kicker')} kickerColour={verb.listen.c1} kickerSize={13} title={t('intro.title')} titleSize={34} />
          <View style={styles.loop}>
            <EchoLoop clock={clock} language={language ?? getSettingsSync().learningLanguage} />
          </View>
          <View style={styles.cat}>
            <GuideBubble
              kind="welcome"
              text={t('intro.welcomeBubble')}
              fontSize={15}
              width={screenW - 2 * ART_SIDE}
              motion={{ bubble, catScale, catY, split: CAT_SPLIT }}
            />
          </View>
        </StepFrame>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  // The loop spans the whole screen width (the nodes sit 10 pt from the edges), so it bleeds out of the frame's gutter.
  loop: { flex: 1, minHeight: 150, marginHorizontal: -Spacing.xl, marginTop: Spacing.sm },
  cat: { marginHorizontal: -(Spacing.xl - ART_SIDE), alignItems: 'center' },
  pills: { gap: PILL_GAP, alignItems: 'center' },
  pillRow: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1, paddingHorizontal: 6 },
  bars: { flexDirection: 'row', alignItems: 'flex-end', gap: 3, height: 19.2 },
  bar: { width: BAR_W, borderRadius: 2, backgroundColor: tide.text },
  pillText: { flex: 1 },
  pillLabel: { fontFamily: fonts.uiMedium, fontSize: 17, fontWeight: '600', lineHeight: 20, color: '#FFFFFF' },
  pillLine: { fontFamily: fonts.ui, fontSize: 12.5, fontWeight: '500', lineHeight: 15, color: 'rgba(255,255,255,0.72)', marginTop: 1 },
});
