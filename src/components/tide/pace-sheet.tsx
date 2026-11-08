import { router } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Segmented } from '@/components/segmented';
import { BottomSheet } from '@/components/sheet/bottom-sheet';
import { TickRuler } from '@/components/tide/tick-ruler';
import { fonts } from '@/constants/fonts';
import { SPEED_MAX, SPEED_MIN, tide } from '@/constants/theme';
import { formatSpeed } from '@/lib/format';
import { useDir, useT } from '@/lib/i18n';
import type { LadderPace } from '@/lib/pass-programme';

// The ladder's pace sheet in the Tide look: "Pace" over the Prism pill tray
// the Settings pace picker uses, then "Speed" over the tick ruler from the
// repeat popover, with the readout above it, the host's chip (the island's
// Easy) under that, and a last row into Settings > Playback.

// Quarter steps: the video host plays through the YouTube embed, whose
// setPlaybackRate takes only its listed rates (0.25 apart), and the ladder
// plays every host at snapRate. A finer step would show a rate that never plays.
const SPEED_STEP = 0.25;
const SPEED_STEPS = Math.round((SPEED_MAX - SPEED_MIN) / SPEED_STEP) + 1;
/** Distance between two speed ticks: five steps spread over the sheet's width. */
const TICK_STEP = 44;

/** The capsule's reading order: Quick | Normal | Deep. */
const PACE_ORDER: readonly LadderPace[] = ['quick', 'steady', 'calm'];

const PACE_KEY: Record<LadderPace, 'ladder.paceQuick' | 'ladder.paceNormal' | 'ladder.paceDeep'> = {
  quick: 'ladder.paceQuick',
  steady: 'ladder.paceNormal',
  calm: 'ladder.paceDeep',
};

/** The pace chip's label: Quick / Normal / Deep. */
export function paceLabelKey(pace: LadderPace) {
  return PACE_KEY[pace];
}

function speedAt(index: number): number {
  return Math.round(Math.min(SPEED_MAX, Math.max(SPEED_MIN, SPEED_MIN + index * SPEED_STEP)) * 100) / 100;
}

function indexOf(speed: number): number {
  return Math.min(SPEED_STEPS - 1, Math.max(0, Math.round((speed - SPEED_MIN) / SPEED_STEP)));
}

type Props = {
  open: boolean;
  onClose: () => void;
  pace?: LadderPace;
  onPace?: (p: LadderPace) => void;
  speed?: number;
  onSpeed?: (v: number) => void;
  /** The host's own chip (the island's Easy), centred under the ruler. */
  chip?: ReactNode;
};

/**
 * The ladder's pace sheet: the pace tray and the speed ruler over the running
 * stage. Audio keeps playing under it; the pace applies at the next stage or
 * repeat, the speed at the next play.
 */
export function PaceSheet({ open, onClose, pace, onPace, speed, onSpeed, chip }: Props) {
  const { t } = useT();
  const dir = useDir();
  const [rulerW, setRulerW] = useState(0);
  const options = PACE_ORDER.map((p) => ({ value: p, label: t(PACE_KEY[p]) }));
  const openSettings = () => {
    onClose();
    router.push('/settings/playback');
  };
  return (
    <BottomSheet open={open} onClose={onClose} title={t('settings.section.playback')}>
      <View style={styles.body}>
        {pace && onPace ? (
          <>
            <Text style={[styles.h3, dir.text]}>{t('settings.playback.pace')}</Text>
            <Segmented options={options} value={pace} onChange={onPace} />
          </>
        ) : null}
        {typeof speed === 'number' && onSpeed ? (
          <>
            <Text style={[styles.h3, styles.h3Speed, dir.text]}>{t('player.toolbarSpeed')}</Text>
            <View style={styles.rulerBox} onLayout={(e) => setRulerW(Math.round(e.nativeEvent.layout.width))}>
              <Text style={styles.readout}>{formatSpeed(speed)}</Text>
              {rulerW > 0 ? (
                <TickRuler
                  width={rulerW}
                  steps={SPEED_STEPS}
                  index={indexOf(speed)}
                  step={TICK_STEP}
                  onIndexChange={(i) => onSpeed(speedAt(i))}
                  isMajor={() => true}
                  tickLabel={(i) => formatSpeed(speedAt(i))}
                  accessibilityLabel={`${t('player.toolbarSpeed')}, ${formatSpeed(speed)}`}
                />
              ) : null}
            </View>
          </>
        ) : null}
        {chip ? <View style={styles.chipRow}>{chip}</View> : null}
        <Pressable onPress={openSettings} accessibilityRole="link" style={({ pressed }) => [styles.settingsRow, dir.row, pressed && { opacity: 0.7 }]}>
          <Text style={[styles.settingsText, dir.text]}>{t('ladder.playbackSettings')}</Text>
          <Text style={styles.settingsChevron}>{dir.chevron}</Text>
        </Pressable>
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 24, paddingBottom: 8 },
  h3: { fontFamily: fonts.uiMedium, fontSize: 14, fontWeight: '500', color: tide.textDim, marginBottom: 8 },
  h3Speed: { marginTop: 24 },
  rulerBox: { alignItems: 'center', gap: 4 },
  readout: { fontFamily: fonts.uiMedium, fontSize: 17, fontWeight: '700', color: tide.text, fontVariant: ['tabular-nums'] },
  chipRow: { marginTop: 24, alignItems: 'center' },
  settingsRow: { marginTop: 24, height: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  settingsText: { fontFamily: fonts.uiMedium, fontSize: 15, fontWeight: '500', color: tide.text },
  settingsChevron: { fontSize: 22, lineHeight: 26, color: tide.textDim },
});
