import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withSequence, withTiming } from 'react-native-reanimated';

import { PrismButton } from '@/components/prism';
import { PillTrayShell, PILL_LABEL_SIZE } from '@/components/prism/pill-tray';
import { tide, verb } from '@/constants/theme';
import { candidateHasWords, selectCandidate, sendTag, undoTag, useTranscriptStore } from '@/lib/dev-transcripts';
import { hapticImpact } from '@/lib/haptics';
import { TAG_GROUPS, TRANSCRIPT_TAGS, type TranscriptTag } from '@/lib/transcript-tags';

const PILL_H = 28;
const ERROR_FLASH = '#FF5C5C';

export type TagPoint = { playerTime: number; lineIndex: number; lineText: string };

/** One tag pill. The accent flash is a fill over it: opacity 0.6 to 0 in 150 ms, scale 1 to 0.96 to 1 in 120 ms. */
function TagPill({ tag, disabled, onTap }: { tag: TranscriptTag; disabled: boolean; onTap: () => Promise<boolean> }) {
  const flash = useSharedValue(0);
  const scale = useSharedValue(1);
  const [ack, setAck] = useState({ n: 0, ok: true });
  const fill = useAnimatedStyle(() => ({ opacity: flash.value }));
  const press = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  useEffect(() => {
    if (ack.n === 0) return;
    /* eslint-disable react-hooks/immutability */
    scale.value = withSequence(withTiming(0.96, { duration: 60 }), withTiming(1, { duration: 60 }));
    flash.value = withSequence(withTiming(0.6, { duration: 0 }), withTiming(0, { duration: 150, easing: Easing.out(Easing.quad) }));
    /* eslint-enable react-hooks/immutability */
  }, [ack, flash, scale]);
  const tap = async () => {
    void hapticImpact();
    const sent = await onTap();
    setAck((a) => ({ n: a.n + 1, ok: sent }));
  };
  return (
    <Animated.View style={[press, { opacity: disabled ? 0.35 : 1 }]} pointerEvents={disabled ? 'none' : 'auto'}>
      <PrismButton shape="pill" verb="tools" flat height={PILL_H} haptic={false} label={tag.label} onPress={() => void tap()} />
      <Animated.View pointerEvents="none" style={[styles.flash, { backgroundColor: ack.ok ? verb.tools.c1 : ERROR_FLASH }, fill]} />
    </Animated.View>
  );
}

/**
 * Dev transcript review: candidate switcher on top, a counter and Undo, then
 * three rows of fault tags (Text, Timing, Structure). It sits in its own band
 * under the dock; the player reserves `onHeight` for it and never lets it
 * cover the captions.
 */
export function TranscriptTagBar({ getPoint, onHeight }: { getPoint: () => TagPoint; onHeight: (h: number) => void }) {
  const s = useTranscriptStore();
  const cand = s.candidates.find((c) => c.label === s.label);
  const hasWords = candidateHasWords(cand);
  const last = useRef(0);
  const onLayout = (e: LayoutChangeEvent) => {
    const h = Math.round(e.nativeEvent.layout.height);
    if (h !== last.current) {
      last.current = h;
      onHeight(h);
    }
  };
  return (
    <View style={styles.bar} onLayout={onLayout}>
      <View style={styles.top}>
        <PillTrayShell wrapStyle={styles.tray} style={styles.trayRow}>
          {s.candidates.map((c) => (
            <PrismButton
              key={c.label}
              shape="pill"
              verb="listen"
              flat
              height={PILL_H}
              on={c.label === s.label}
              label={c.label}
              onPress={() => selectCandidate(c.label)}
            />
          ))}
        </PillTrayShell>
        <View style={styles.chip}>
          <Text style={styles.chipText}>{`Sent ${s.counter}`}</Text>
        </View>
        <Pressable
          onPress={() => void undoTag()}
          disabled={s.undoStack.length === 0}
          accessibilityRole="button"
          accessibilityLabel="Undo last tag"
          style={[styles.chip, s.undoStack.length === 0 && { opacity: 0.35 }]}>
          <Text style={styles.chipText}>Undo</Text>
        </Pressable>
      </View>
      {TAG_GROUPS.map((g) => (
        <ScrollView key={g} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
          {TRANSCRIPT_TAGS.filter((t) => t.group === g).map((t) => (
            <TagPill key={t.key} tag={t} disabled={!!t.needsWords && !hasWords} onTap={() => sendTag(t.key, getPoint())} />
          ))}
        </ScrollView>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { gap: 6, paddingVertical: 6, backgroundColor: 'rgba(11,10,16,0.92)' },
  top: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12 },
  tray: { alignSelf: 'flex-start' },
  trayRow: { flexDirection: 'row', gap: 4, padding: 3 },
  row: { flexDirection: 'row', gap: 6, paddingHorizontal: 12 },
  chip: { paddingHorizontal: 12, height: PILL_H, justifyContent: 'center', borderRadius: PILL_H / 2, backgroundColor: 'rgba(255,255,255,0.1)' },
  chipText: { color: tide.text, fontSize: PILL_LABEL_SIZE, fontWeight: '600' },
  flash: { ...StyleSheet.absoluteFill, borderRadius: PILL_H / 2 },
});
