import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { interpolateColor, useAnimatedStyle, useDerivedValue, type SharedValue } from 'react-native-reanimated';

import { PrismButton } from '@/components/prism';
import { RubyWord } from '@/components/ruby-word';
import { BottomSheet } from '@/components/sheet/bottom-sheet';
import { DOCK_GOLD_INK } from '@/components/tide/compact-dock';
import type { HighlightState } from '@/components/word-highlight';
import { fonts } from '@/constants/fonts';
import { Spacing, tide } from '@/constants/theme';
import type { CatchTarget, Word } from '@/lib/api';
import { useT } from '@/lib/i18n';

const noLayout = () => {};

/** The target as one word of a line, for `RubyWord`. */
function wordOf(target: CatchTarget): Word {
  return { text: target.text, start: target.start, end: target.end, ...(target.ruby ? { ruby: target.ruby } : {}) };
}

type HudProps = {
  target: CatchTarget;
  /** Japanese: the word with its furigana. Otherwise plain serif text. */
  ja: boolean;
  /** Paused, disarmed by a tap outside the window, or the card is up. */
  disabled: boolean;
  /** 0 to 1, pulsed by the hook on a hit: the word flashes gold, the lit-karaoke look. */
  flash: SharedValue<number>;
  onTap: () => void;
};

/** The dock slot while the game runs: what to listen for, and the Catch button. */
export function CatchHud({ target, ja, disabled, flash, onTap }: HudProps) {
  const { t } = useT();
  // Word 0 of a one-word line, lit as far as `flash` says: RubyWord's own ink fade does the colour.
  const highlight = useDerivedValue<HighlightState>(() => ({ level: 1, on: flash.value, from: 0, to: 0 }));
  const plainInk = useAnimatedStyle(() => ({ color: interpolateColor(flash.value, [0, 1], [tide.text, DOCK_GOLD_INK]) }));
  const word = useMemo(() => wordOf(target), [target]);
  return (
    <View style={styles.hud}>
      <Text style={styles.label}>{t('video.catch.listenFor')}</Text>
      {ja ? (
        <RubyWord
          word={word}
          showRuby
          showPosAndRomaji={false}
          index={0}
          highlight={highlight}
          litColor={DOCK_GOLD_INK}
          selected={false}
          big
          onLayout={noLayout}
        />
      ) : (
        <Animated.Text style={[styles.word, plainInk]}>{target.text}</Animated.Text>
      )}
      <PrismButton shape="pill" verb="speak" label={t('video.catch.button')} onPress={onTap} disabled={disabled} haptic={false} />
    </View>
  );
}

/** The sentence around the target's first occurrence, so the word can sit in gold. */
function splitSentence(sentence: string, word: string): { before: string; word: string; after: string } {
  const at = word ? sentence.toLowerCase().indexOf(word.toLowerCase()) : -1;
  if (at < 0) return { before: sentence, word: '', after: '' };
  return { before: sentence.slice(0, at), word: sentence.slice(at, at + word.length), after: sentence.slice(at + word.length) };
}

type CardProps = {
  open: boolean;
  /** The word the card is about; the hook keeps it through the exit slide. */
  target: CatchTarget | null;
  /** Caught in the window, or missed at the line's end. */
  hit: boolean;
  ja: boolean;
  /** Backdrop, drag or Android back: the word is skipped, no grade. */
  onClose: () => void;
  onDismissed: () => void;
  onHearAgain: () => void;
  onGrade: (knew: boolean) => void;
};

/** The word's card after a catch or a miss: meaning, the sentence, Hear again, and the two grades. */
export function CatchCard({ open, target, hit, ja, onClose, onDismissed, onHearAgain, onGrade }: CardProps) {
  const { t } = useT();
  const tg = target;
  const parts = useMemo(() => splitSentence(tg?.sentence ?? '', tg?.text ?? ''), [tg]);
  const word = useMemo(() => (tg ? wordOf(tg) : null), [tg]);
  return (
    <BottomSheet open={open} onClose={onClose} onDismissed={onDismissed} title={t(hit ? 'video.catch.hit' : 'video.catch.missed')}>
      {tg && word ? (
        <View style={styles.card}>
          <View style={styles.wordRow}>
            {ja ? (
              <RubyWord word={word} showRuby showPosAndRomaji={false} index={0} selected={false} big onLayout={noLayout} />
            ) : (
              <Text style={styles.word}>{tg.text}</Text>
            )}
          </View>
          <Text style={[styles.meaning, !tg.meaning && styles.dim]}>{tg.meaning || '…'}</Text>
          <Text style={styles.sentence}>
            {parts.before}
            <Text style={styles.gold}>{parts.word}</Text>
            {parts.after}
          </Text>
          <Text style={styles.translation}>{tg.sentence_translation}</Text>
          <Pressable
            accessibilityRole="button"
            onPress={onHearAgain}
            hitSlop={8}
            style={({ pressed }) => [styles.link, pressed && styles.pressed]}>
            <Text style={styles.linkText}>{t('video.catch.hearAgain')}</Text>
          </Pressable>
          <View style={styles.actions}>
            <PrismButton shape="pill" verb="tools" flat label={t('video.catch.didntKnow')} onPress={() => onGrade(false)} />
            <PrismButton shape="pill" verb="speak" label={t('video.catch.knew')} onPress={() => onGrade(true)} />
          </View>
        </View>
      ) : null}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  hud: { alignItems: 'center', gap: Spacing.sm },
  label: { fontSize: 12, lineHeight: 16, fontFamily: fonts.ui, color: tide.textDim, textAlign: 'center' },
  word: { fontSize: 28, lineHeight: 36, fontFamily: fonts.serifLight, color: tide.text, textAlign: 'center' },
  card: { alignItems: 'center', gap: Spacing.md, paddingBottom: Spacing.sm },
  wordRow: { flexDirection: 'row', justifyContent: 'center' },
  meaning: { fontSize: 18, lineHeight: 24, fontFamily: fonts.ui, color: tide.text, textAlign: 'center' },
  dim: { color: tide.textDim },
  sentence: { fontSize: 20, lineHeight: 30, fontFamily: fonts.ui, color: tide.text, textAlign: 'center' },
  gold: { color: DOCK_GOLD_INK },
  translation: { fontSize: 15, lineHeight: 21, fontFamily: fonts.ui, color: tide.textDim, textAlign: 'center' },
  link: { paddingVertical: Spacing.xs, paddingHorizontal: Spacing.md },
  pressed: { opacity: 0.7 },
  linkText: { fontSize: 15, lineHeight: 20, fontFamily: fonts.ui, color: DOCK_GOLD_INK, textDecorationLine: 'underline' },
  actions: { flexDirection: 'row', justifyContent: 'center', gap: Spacing.md, marginTop: Spacing.xs },
});
