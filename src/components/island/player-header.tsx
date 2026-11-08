import { type ReactElement, memo, useRef } from 'react';
import { useRouter } from 'expo-router';
import { type StyleProp, StyleSheet, Text, type TextStyle, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PressScale } from '@/components/press-scale';
import { PrismButton } from '@/components/prism';
import { PlayerTitle } from '@/components/tide/player-title';
import { fonts } from '@/constants/fonts';
import { Spacing, prism, tide, verb } from '@/constants/theme';
import { PLAYER_HEADER_ROW_H, setHeaderBoxRect, setHeaderTitleRect, useMorphHidesTitle } from '@/lib/card-morph';
import { headerLeftButton, headerRightButton } from '@/lib/header-buttons';
import { useDir, useT } from '@/lib/i18n';

export const HEADER_ROW_H = PLAYER_HEADER_ROW_H;

export type PlayerHeaderProps = {
  id: string;
  title: string;
  lineIndex: number;
  lineCount: number;
  /** Loading: the line row shows with a stand-in for the unknown count. */
  placeholder: boolean;
  background: string;
  onBack: (() => void) | null; // bl57-intro-round2: null leaves an empty slot while the guide locks the screen
  /** The `…` island menu; null leaves an empty slot of the same size. */
  onMenu: (() => void) | null;
  /** bl58-easy-for-me: lines marked Easy for me on this island; 0 shows no pill. */
  known: number;
  /** A touch on the bar: closes an open word panel. */
  onTouch: () => void;
};

/**
 * The player's header, drawn in the screen rather than as native bar items
 * (those get the system's glass button background, which replays its appear
 * animation whenever the options change). The title stays hidden while the
 * card morph's flying title stands in for it.
 */
export const PlayerHeader = memo(function PlayerHeader({
  id,
  title,
  lineIndex,
  lineCount,
  placeholder,
  background,
  onBack,
  onMenu,
  known,
  onTouch,
}: PlayerHeaderProps) {
  const { t } = useT();
  const dir = useDir();
  const insets = useSafeAreaInsets();
  // The title and both buttons: the overlay draws them while a morph runs.
  const titleHidden = useMorphHidesTitle(id, 'header');
  const barRef = useRef<View>(null);
  const reportBar = () => {
    barRef.current?.measureInWindow((x, y, width, height) => setHeaderBoxRect({ x, y, width, height }));
  };
  return (
    <View
      ref={barRef}
      onLayout={reportBar}
      onTouchStart={onTouch}
      style={[styles.header, dir.row, { paddingTop: insets.top, height: insets.top + HEADER_ROW_H, backgroundColor: background }]}>
      <View pointerEvents="none" style={[styles.headerTitle, { top: insets.top }, known > 0 && (dir.rtl ? styles.headerTitleByPillRtl : styles.headerTitleByPill)]}>
        <PlayerTitle
          title={title}
          lineIndex={lineIndex}
          lineCount={lineCount}
          placeholder={placeholder}
          hidden={titleHidden}
          onTitleRect={setHeaderTitleRect}
        />
      </View>
      {onBack ? (
        <View style={[styles.headerButton, titleHidden ? styles.hiddenChrome : null]}>
          <PrismButton shape="round" size={prism.sizes.roundSm} verb="tools" onPress={onBack} accessibilityLabel={t('player.back')}>
            <BackGlyph />
          </PrismButton>
        </View>
      ) : (
        <View style={styles.headerButton} />
      )}{/* bl57-intro-round2 */}
      {known > 0 ? (
        // bl58-easy-for-me: E4 b, the "already yours" count beside the menu.
        <View style={[styles.knownPill, dir.rtl && styles.knownPillRtl, titleHidden ? styles.hiddenChrome : null]} accessibilityLabel={t('ladder.alreadyYours', { count: known })}>
          <Leaf size={14} />
          <Text style={styles.knownText}>{known}</Text>
        </View>
      ) : null}
      {onMenu ? (
        <PressScale onPress={onMenu} hitSlop={12} accessibilityLabel={t('player.islandMenu')} style={styles.headerButton}>
          <Text style={[styles.menuGlyph, titleHidden ? styles.hiddenChrome : null]}>…</Text>
        </PressScale>
      ) : (
        <View style={styles.headerButton} />
      )}
    </View>
  );
});

/** The back chevron, mirrored in Hebrew and Arabic. The one glyph every back
 * control draws, the player header and the card morph's flying copy included. */
export function BackGlyph({ style }: { style?: StyleProp<TextStyle> }) {
  const dir = useDir();
  return <Text style={[styles.backGlyph, style]}>{dir.rtl ? '›' : '‹'}</Text>;
}

/**
 * Native header options for a screen with the island player's back control:
 * one round button with the back glyph at the reading start, and an optional
 * `right` item at the other end (the glass capsule is dropped on iOS 26, see
 * `headerLeftButton`). Hebrew and Arabic swap the two sides. Spread into
 * `<Stack.Screen options>`.
 */
export function useBackHeaderOptions({ title, right }: { title?: string; right?: () => ReactElement } = {}) {
  const { t } = useT();
  const dir = useDir();
  const router = useRouter();
  const back = () => (
    <PrismButton
      shape="round"
      size={prism.sizes.roundSm}
      verb="tools"
      onPress={() => router.back()}
      accessibilityLabel={t('player.back')}>
      <BackGlyph />
    </PrismButton>
  );
  const first = headerLeftButton(back);
  const options = dir.rtl
    ? { ...dir.headerSides, ...headerRightButton(back), ...(right ? headerLeftButton(right) : { headerLeft: () => null }) }
    : { ...first, ...(right ? headerRightButton(right) : null) };
  return title === undefined ? options : { title, ...options };
}

/** bl58-easy-for-me: E4's leaf, drawn with two Views (a rounded leaf and its vein), no SVG. */
export function Leaf({ size }: { size: number }) {
  const r = size / 2;
  return (
    <View
      style={[
        styles.leaf,
        { width: size, height: size, borderTopRightRadius: r, borderBottomLeftRadius: r, borderTopLeftRadius: 0, borderBottomRightRadius: 0 },
      ]}>
      <View
        style={[
          styles.leafVein,
          { left: size * 0.21, top: size * 0.21, width: size * 0.5, height: size * 0.29, borderLeftWidth: size * 0.115, borderBottomWidth: size * 0.115 },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.sm,
  },
  headerTitle: {
    position: 'absolute',
    left: Spacing.sm + 44,
    right: Spacing.sm + 44,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  hiddenChrome: { opacity: 0 },
  menuGlyph: { fontFamily: fonts.ui, fontSize: 22, color: tide.text },
  headerTitleByPill: { right: Spacing.sm + 44 + 52 },
  headerTitleByPillRtl: { left: Spacing.sm + 44 + 52 },
  knownPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 30,
    paddingHorizontal: 12,
    borderRadius: 15,
    backgroundColor: 'rgba(61,220,151,0.14)',
    borderWidth: 1,
    borderColor: 'rgba(61,220,151,0.45)',
    marginStart: 'auto',
    marginEnd: 6,
  },
  // The header row is reversed, so the menu is on the left: the pill hugs it from the right.
  knownPillRtl: { marginStart: 6, marginEnd: 'auto' },
  knownText: { fontFamily: fonts.uiMedium, fontSize: 13, fontWeight: '600', color: verb.along.c2 },
  leaf: { backgroundColor: verb.along.c1, transform: [{ rotate: '-8deg' }] },
  leafVein: { position: 'absolute', borderColor: '#08231a', transform: [{ rotate: '-45deg' }] },
  backGlyph: { fontFamily: fonts.ui, fontSize: 28, color: tide.text },
});
