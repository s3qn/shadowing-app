/**
 * Home's bottom dock (variant E of the compact mocks): Practice now with the
 * due count, Drive (beta only) and the add button, in one rounded bar floating
 * above the tab bar. It stays put while the island list scrolls under it.
 *
 * With nothing due and no islands, Practice now dims and does not press; the
 * add button stays live and is the way out. `dueCount` null (still loading)
 * leaves the count off the label.
 */

import { BlurView } from 'expo-blur';
import { SymbolView } from 'expo-symbols';
import type { ComponentProps } from 'react';
import { Platform, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PrismButton } from '@/components/prism/prism-button';
import { verb } from '@/constants/theme';
import { PILL_TAB_BAR_REACH } from '@/components/pill-tab-bar';
import { useDir, useT } from '@/lib/i18n';

/** The dock's own height: 50pt buttons plus 10pt padding top and bottom. */
export const DOCK_H = 70;
const GAP_ABOVE_TABS = 8;
// The mock's Drive button: 16pt padding either side of the car glyph.
const DRIVE_W = 52;
/** How far the dock reaches above the tab bar's reach: its gap plus its height. */
export const DOCK_REACH = GAP_ABOVE_TABS + DOCK_H;

type Anchor = { ref: React.Ref<View>; onLayout: (e: LayoutChangeEvent) => void };

/** beta-gate: `onDrive` comes only with the beta layer; without it the Drive button is not drawn. */
export function PracticeDock({
  dueCount,
  hasIslands,
  onPractice,
  onDrive,
  onAdd,
  addAnchor,
  style,
  hidden,
}: {
  dueCount: number | null;
  hasIslands: boolean;
  onPractice: () => void;
  onDrive?: () => void;
  onAdd: () => void;
  /** The guide's 'addFab' anchor, on the + button. */
  addAnchor?: Anchor;
  /** Animated opacity from the search row, so the dock fades with it. */
  style?: ComponentProps<typeof Animated.View>['style'];
  /** Search is open: the dock takes no touches. */
  hidden?: boolean;
}) {
  const { t } = useT();
  const dir = useDir();
  const insets = useSafeAreaInsets();
  const label = dueCount ? `${t('home.practiceNow')} · ${dueCount}` : t('home.practiceNow');
  const idle = dueCount === 0 && !hasIslands;
  return (
    <Animated.View
      pointerEvents={hidden ? 'none' : 'box-none'}
      style={[styles.dock, { bottom: insets.bottom + PILL_TAB_BAR_REACH + GAP_ABOVE_TABS }, style]}>
      {Platform.OS === 'ios' ? <BlurView intensity={20} tint="dark" style={StyleSheet.absoluteFill} /> : null}
      <View style={[styles.row, dir.row]}>
        <PrismButton
          shape="pill"
          verb="speak"
          height={50}
          label={label}
          fitLabel
          disabled={idle}
          onPress={onPractice}
          accessibilityLabel={label}
          containerStyle={[styles.practice, idle && styles.idle]}
          style={styles.practiceFace}>
          <SymbolView
            name={{ ios: 'play.fill', android: 'play_arrow' }}
            size={16}
            weight="regular"
            tintColor={verb.speak.c1}
            style={dir.rtl ? styles.flip : undefined}
          />
        </PrismButton>
        {onDrive ? (
          <PrismButton shape="pill" verb="listen" height={50} width={DRIVE_W} onPress={onDrive} accessibilityLabel={t('home.drive')}>
            <SymbolView name={{ ios: 'car.fill', android: 'directions_car' }} size={22} weight="regular" tintColor={verb.listen.c1} />
          </PrismButton>
        ) : null}
        <View ref={addAnchor?.ref} onLayout={addAnchor?.onLayout} collapsable={false}>
          <PrismButton shape="round" size={50} verb="speak" press="tide" onPress={onAdd} accessibilityLabel={t('home.addTitle')}>
            <SymbolView name={{ ios: 'plus', android: 'add' }} size={28} weight="regular" tintColor={verb.speak.c1} />
          </PrismButton>
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  dock: {
    position: 'absolute',
    left: 12,
    right: 12,
    padding: 10,
    borderRadius: 36,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#7A5A52',
    backgroundColor: 'rgba(8,20,28,0.82)',
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  practice: { flex: 1 },
  practiceFace: { alignSelf: 'stretch', justifyContent: 'center' },
  idle: { opacity: 0.5 },
  flip: { transform: [{ scaleX: -1 }] },
});
