// The ladder stage's background, shared by the live stage and its still preview.
// A plain View gradient: it paints in the same frame as the page around it and needs
// no measured size, so a newly mounted stage or hop cover never shows a flat dark frame
// before its sky draws (a Skia canvas painted a frame or two late).
import { Platform, StyleSheet, View } from 'react-native';

import { tideSkies } from '@/constants/theme';

const [TOP, MID, BOTTOM] = tideSkies.night;
const GRADIENT = `linear-gradient(180deg, ${TOP} 0%, ${MID} 55%, ${BOTTOM} 100%)`;
// react-native-web passes `backgroundImage` to CSS; native takes the experimental prop.
const sky = Platform.select<object>({ web: { backgroundImage: GRADIENT }, default: { experimental_backgroundImage: GRADIENT } });

/**
 * The mock's stage background: 180deg #070A12, #101A2A at 55%, #16243A. It rides on the
 * cube's live page (D4), so a turn shows a solid face, never the still page under it; the
 * root behind the cube is the gradient's top colour, so the strip above the page matches.
 */
export function StageSky() {
  return <View style={[StyleSheet.absoluteFill, sky]} pointerEvents="none" />;
}
