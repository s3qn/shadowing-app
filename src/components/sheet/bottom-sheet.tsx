import { type ReactNode, useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { fonts } from '@/constants/fonts';
import { tide } from '@/constants/theme';
import { useDir, useT } from '@/lib/i18n';

const OPEN_MS = 240;
const CLOSE_MS = 200;
const DISMISS_DISTANCE = 80;
const DISMISS_VELOCITY = 600;

type BottomSheetProps = {
  /** Controlled by the parent: true shows the sheet, false starts its exit. */
  open: boolean;
  /** Backdrop tap, drag past the threshold, or Android back. The parent flips `open`. */
  onClose: () => void;
  /** Runs once `mounted` actually goes false, one render after the exit
   * animation finishes. Alerts and share sheets belong here, not in a row's
   * onPress, so they never race the Modal dismissing. */
  onDismissed?: () => void;
  title?: string;
  /** The title is content (an island's own name), not interface copy: it
   * keeps its own writing direction whatever language the app is in. */
  contentTitle?: boolean;
  /** A short explanation shown once under the title, in the muted style,
   * instead of repeating the same note on every row. */
  hint?: string;
  /** Wraps the content in KeyboardAvoidingView (padding). Rename needs it. */
  avoidKeyboard?: boolean;
  children: ReactNode;
};

/**
 * A bottom sheet on RN Modal: slides up from the dock, drags down to
 * dismiss. An internal `mounted` state keeps the Modal on screen through the
 * exit animation instead of yanking it away the instant `open` goes false.
 */
export function BottomSheet({ open, onClose, onDismissed, title, contentTitle, hint, avoidKeyboard, children }: BottomSheetProps) {
  const insets = useSafeAreaInsets();
  const { t } = useT();
  const dir = useDir();
  const reducedMotion = useReducedMotion();
  const [mounted, setMounted] = useState(open);
  const progress = useSharedValue(open ? 1 : 0);
  const drag = useSharedValue(0);
  const panelHeight = useSharedValue(0);

  useEffect(() => {
    if (open) {
      // `open` flips from outside; mounting has to follow it so the Modal is
      // there for the animation that starts right below.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMounted(true);
      drag.value = 0;
      progress.value = withTiming(1, {
        duration: reducedMotion ? 0 : OPEN_MS,
        easing: Easing.out(Easing.cubic),
      });
    } else if (mounted) {
      progress.value = withTiming(0, { duration: reducedMotion ? 0 : CLOSE_MS }, (finished) => {
        if (!finished) return;
        runOnJS(setMounted)(false);
      });
    }
    // Only `open` drives this: `mounted` here is the value at the moment
    // `open` changed, which is exactly what decides whether an exit is due.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // `onDismissed` fires from its own effect, one render after `mounted`
  // flips to false, instead of inline in the animation callback above: that
  // callback and the `setMounted(false)` it triggers land in the same turn,
  // so calling `onDismissed` there could beat React to unmounting the Modal.
  const wasMounted = useRef(mounted);
  useEffect(() => {
    if (wasMounted.current && !mounted) onDismissed?.();
    wasMounted.current = mounted;
  }, [mounted, onDismissed]);

  // Reanimated shared values are meant to be mutated from a worklet; the
  // react-compiler lint rule reads that as illegal state mutation.
  // activeOffsetY/failOffsetX keep this a vertical-only recognizer: without
  // them the pan claims the whole panel in any direction and beats a native
  // control (the Speed slider) to the gesture on Android.
  const pan = Gesture.Pan()
    .activeOffsetY([-10, 10])
    .failOffsetX([-12, 12])
    .onUpdate((e) => {
      // eslint-disable-next-line react-hooks/immutability
      drag.value = Math.max(0, e.translationY);
    })
    .onEnd((e) => {
      if (e.translationY > DISMISS_DISTANCE || e.velocityY > DISMISS_VELOCITY) {
        runOnJS(onClose)();
      } else {
        // eslint-disable-next-line react-hooks/immutability
        drag.value = withSpring(0);
      }
    });

  const panelStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: (1 - progress.value) * panelHeight.value + drag.value }],
  }));
  const backdropStyle = useAnimatedStyle(() => ({
    opacity: progress.value * 0.55,
  }));

  if (!mounted) return null;

  const content = (
    <View style={styles.wrap}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel={t('player.close')} />
      <Animated.View style={[styles.backdrop, backdropStyle]} pointerEvents="none" />
      <GestureDetector gesture={pan}>
        <Animated.View
          onLayout={(e) => {
            panelHeight.value = e.nativeEvent.layout.height;
          }}
          style={[styles.panel, { paddingBottom: insets.bottom + 16 }, panelStyle]}>
          <View style={styles.grab} />
          {title ? <Text style={[styles.title, contentTitle ? styles.autoText : dir.rtl && styles.rtlText]}>{title}</Text> : null}
          {hint ? <Text style={[styles.hint, dir.rtl && styles.rtlText]}>{hint}</Text> : null}
          <View style={styles.body}>{children}</View>
        </Animated.View>
      </GestureDetector>
    </View>
  );

  return (
    <Modal
      visible
      transparent
      animationType="none"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}>
      <GestureHandlerRootView style={styles.fill}>
        {avoidKeyboard ? (
          <KeyboardAvoidingView style={styles.fill} behavior="padding">
            {content}
          </KeyboardAvoidingView>
        ) : (
          content
        )}
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  wrap: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: '#000000' },
  panel: {
    backgroundColor: 'rgba(11,10,16,0.97)',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.08)',
    paddingHorizontal: 20,
  },
  grab: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.16)',
    marginTop: 9,
  },
  title: {
    fontFamily: fonts.uiMedium,
    fontWeight: '500',
    fontSize: 15,
    color: tide.text,
    textAlign: 'center',
    marginTop: 12,
    marginBottom: 4,
  },
  // The title and hint stay centred in every language: only their writing
  // direction changes, so Hebrew punctuation sits on the right of the line.
  rtlText: { writingDirection: 'rtl' },
  // A content title (an island name, which can be in any script) resolves its
  // direction from its own first strong character instead.
  autoText: { writingDirection: 'auto' },
  hint: {
    fontFamily: fonts.ui,
    fontSize: 12,
    color: tide.textDim,
    textAlign: 'center',
    marginBottom: 4,
  },
  body: { marginTop: 8 },
});
