import { type ReactNode } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { PrismButton } from '@/components/prism';
import { fonts } from '@/constants/fonts';
import { Spacing, tide } from '@/constants/theme';
import { useT } from '@/lib/i18n';
import { watchUrl } from '@/lib/youtube';

/** The embed's slot: the player and the fullscreen button, or the open-in-YouTube fallback. */
export function VideoFrame({
  videoId,
  size,
  cannotPlay,
  full,
  onToggleFull,
  children,
}: {
  videoId: string;
  size: { width: number; height: number };
  cannotPlay: boolean;
  full: boolean;
  onToggleFull: () => void;
  children: ReactNode;
}) {
  const { t } = useT();
  if (cannotPlay) {
    return (
      <View style={[styles.center, { width: size.width, height: size.height, flex: 0 }]}>
        <Text style={styles.hint}>{t('video.cannotPlay')}</Text>
        <PrismButton
          shape="pill"
          verb="tools"
          flat
          press="light"
          label={t('video.openInYoutube')}
          onPress={() => void Linking.openURL(watchUrl(videoId))}
        />
      </View>
    );
  }
  return (
    <View style={{ width: size.width, height: size.height }}>
      {children}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t(full ? 'video.exitFullscreen' : 'video.enterFullscreen')}
        onPress={onToggleFull}
        hitSlop={3}
        style={({ pressed }) => [styles.fullBtn, pressed && { opacity: 0.7 }]}>
        <SymbolView
          name={
            full
              ? { ios: 'arrow.down.right.and.arrow.up.left', android: 'fullscreen_exit' }
              : { ios: 'arrow.up.left.and.arrow.down.right', android: 'fullscreen' }
          }
          size={16}
          tintColor={tide.textDim}
        />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  fullBtn: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(20,28,44,0.72)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.lg,
    paddingHorizontal: 16,
  },
  hint: {
    fontSize: 14,
    lineHeight: 20,
    color: tide.textDim,
    fontFamily: fonts.ui,
    textAlign: 'center',
  },
});
