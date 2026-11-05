// focus-stories D9: the step list a hold on the step chip opens. A `PopoverBubble`
// (POP look) mounted only while `open`, over the stage root. `vis` holds the visible
// steps (indices into STEPS), `cur` is the current one's index in `vis`, `anchorX` is
// the step chip's centre x in the stage. A row calls `onPick(step)` (the composer runs
// `jumpStep` and closes); a tap outside calls `onClose`.
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { STEPS } from '@/components/tide/ladder/stage-model';
import { POP, PopoverBubble } from '@/components/tide/popover-bubble';
import { fonts } from '@/constants/fonts';
import { useDir, useT } from '@/lib/i18n';

const ROW_H = 40;
const LIST_W = 200;

export type StepListProps = {
  open: boolean;
  vis: number[];
  cur: number;
  anchorX: number;
  anchorTop: number;
  parentWidth: number;
  onPick: (step: number) => void;
  onClose: () => void;
};

export function StepList({ open, vis, cur, anchorX, anchorTop, parentWidth, onPick, onClose }: StepListProps) {
  const { t } = useT();
  const dir = useDir();
  if (!open) return null;
  return (
    <PopoverBubble
      anchorX={anchorX}
      anchorTop={anchorTop}
      parentWidth={parentWidth}
      width={LIST_W}
      height={vis.length * ROW_H + 16}
      radius={POP.radius}
      bodyStyle={styles.body}
      gap={4}
      onClose={onClose}>
      <View accessibilityLabel={t('ladder.pickStep')} accessibilityRole="menu">
        {vis.map((step, i) => {
          const s = STEPS[step]!;
          const on = i === cur;
          return (
            <Pressable
              key={step}
              onPress={() => onPick(step)}
              accessibilityRole="menuitem"
              accessibilityState={{ selected: on }}
              style={[styles.row, dir.row]}>
              <View style={[styles.dot, { backgroundColor: s.look.tint }]} />
              <Text style={[styles.name, { color: on ? POP.ink : POP.offInk }]}>{t(s.name)}</Text>
            </Pressable>
          );
        })}
      </View>
    </PopoverBubble>
  );
}

const styles = StyleSheet.create({
  body: { paddingVertical: 8, paddingHorizontal: 14 },
  row: { height: ROW_H, flexDirection: 'row', alignItems: 'center', gap: 10 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  name: { fontFamily: fonts.uiMedium, fontSize: 15 },
});
