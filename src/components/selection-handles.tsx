import { type RefObject, useRef } from 'react';
import { StyleSheet } from 'react-native';
import { Gesture, GestureDetector, ScrollView } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';

import { tide } from '@/constants/theme';

/** The popup's top sits this far below the selection's union box, clearing the end knob. */
export const SELECTION_HANDLE_CLEARANCE = 18;

type Box = { x: number; y: number; width: number; height: number };

type Props = {
  start: Box; // wordBoxes[dragSpan.from]
  end: Box; // wordBoxes[dragSpan.to]
  scrollRef: RefObject<ScrollView | null>;
  onGrab: (which: 'start' | 'end') => void;
  onDrag: (x: number, y: number) => void; // block coordinates, every update
  onRelease: () => void;
};

const HIT_WIDTH = 44;
const HIT_VPAD = 14;
const KNOB_SIZE = 14;

/**
 * The pair of iOS style drag handles at the edges of a text selection: a
 * vertical line the height of the word box, a round knob above the line on
 * the start handle and below the line on the end handle. Each handle owns
 * its own pan so dragging one past the other still tracks the same finger;
 * the screen decides how a drag maps onto a new span.
 */
export function SelectionHandles({ start, end, scrollRef, onGrab, onDrag, onRelease }: Props) {
  return (
    <>
      <Handle
        key="start"
        which="start"
        box={start}
        lineX={start.x - 1}
        knobY={start.y - KNOB_SIZE}
        scrollRef={scrollRef}
        onGrab={onGrab}
        onDrag={onDrag}
        onRelease={onRelease}
      />
      <Handle
        key="end"
        which="end"
        box={end}
        lineX={end.x + end.width - 1}
        knobY={end.y + end.height}
        scrollRef={scrollRef}
        onGrab={onGrab}
        onDrag={onDrag}
        onRelease={onRelease}
      />
    </>
  );
}

type HandleProps = {
  which: 'start' | 'end';
  box: Box;
  lineX: number;
  knobY: number;
  scrollRef: RefObject<ScrollView | null>;
  onGrab: (which: 'start' | 'end') => void;
  onDrag: (x: number, y: number) => void;
  onRelease: () => void;
};

function Handle({ which, box, lineX, knobY, scrollRef, onGrab, onDrag, onRelease }: HandleProps) {
  const scale = useSharedValue(1);
  // Block coordinates of the touch at onBegin, read and written only from
  // this handle's own gesture callbacks.
  const origin = useRef({ x: 0, y: 0 });
  const hitLeft = lineX - HIT_WIDTH / 2;
  const hitTop = box.y - HIT_VPAD;

  function begin(x: number, y: number) {
    scale.value = withSpring(1.3);
    onGrab(which);
    origin.current = { x: hitLeft + x, y: hitTop + y };
  }

  function update(x: number, y: number) {
    onDrag(origin.current.x + x, origin.current.y + y);
  }

  function finish() {
    scale.value = withSpring(1);
    onRelease();
  }

  const pan = Gesture.Pan()
    .runOnJS(true)
    .minDistance(1)
    .blocksExternalGesture(scrollRef)
    .onBegin((e) => begin(e.x, e.y))
    .onUpdate((e) => update(e.translationX, e.translationY))
    .onFinalize(() => finish());

  const knobStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  return (
    <GestureDetector gesture={pan}>
      <Animated.View
        style={[styles.hit, { left: hitLeft, top: hitTop, width: HIT_WIDTH, height: box.height + HIT_VPAD * 2 }]}>
        <Animated.View
          pointerEvents="none"
          style={[styles.line, { left: HIT_WIDTH / 2 - 1, top: HIT_VPAD, height: box.height }]}
        />
        <Animated.View
          pointerEvents="none"
          style={[
            styles.knob,
            knobStyle,
            { left: HIT_WIDTH / 2 - KNOB_SIZE / 2, top: knobY - box.y + HIT_VPAD },
          ]}
        />
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  hit: {
    position: 'absolute',
    zIndex: 6,
  },
  line: {
    position: 'absolute',
    width: 2,
    backgroundColor: tide.lang.ja,
  },
  knob: {
    position: 'absolute',
    width: KNOB_SIZE,
    height: KNOB_SIZE,
    borderRadius: KNOB_SIZE / 2,
    backgroundColor: tide.lang.ja,
  },
});
