import { StyleSheet, Text, View } from 'react-native';

import { PrismButton } from '@/components/prism';
import { BottomSheet } from '@/components/sheet/bottom-sheet';
import { TranscriptTagBar } from '@/components/transcript-tag-bar';
import { tide } from '@/constants/theme';

type Point = { playerTime: number; lineIndex: number; lineText: string };

/** Dev transcript review: the tag bar pinned above the dock and the score sheet. */
export function TranscriptReviewBar({
  showBar,
  bottom,
  getPoint,
  onHeight,
  candidates,
  scoreOpen,
  onCloseScores,
  scores,
  onScore,
  onDone,
}: {
  showBar: boolean;
  bottom: number;
  getPoint: () => Point;
  onHeight: (h: number) => void;
  candidates: { label: string }[];
  scoreOpen: boolean;
  onCloseScores: () => void;
  scores: Record<string, number>;
  onScore: (label: string, n: number) => void;
  onDone: () => void;
}) {
  return (
    <>
      {showBar ? (
        <View style={[styles.trBar, { bottom }]}>
          <TranscriptTagBar getPoint={getPoint} onHeight={onHeight} />
        </View>
      ) : null}
      <BottomSheet open={scoreOpen} onClose={onCloseScores} title="Score each candidate" contentTitle>
        <View style={styles.trScores}>
          {candidates.map((c) => (
            <View key={c.label} style={styles.trScoreRow}>
              <Text style={styles.trScoreLabel}>{c.label}</Text>
              {[1, 2, 3, 4, 5].map((n) => (
                <PrismButton
                  key={n}
                  shape="pill"
                  verb="tools"
                  on={scores[c.label] === n}
                  label={String(n)}
                  onPress={() => onScore(c.label, n)}
                />
              ))}
            </View>
          ))}
          <PrismButton shape="pill" verb="listen" label="Done" onPress={onDone} />
        </View>
      </BottomSheet>
    </>
  );
}

const styles = StyleSheet.create({
  trBar: { position: 'absolute', left: 0, right: 0, zIndex: 17 },
  trScores: { gap: 12, paddingTop: 8 },
  trScoreRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  trScoreLabel: { color: tide.text, fontSize: 17, fontWeight: '700', width: 24 },
});
