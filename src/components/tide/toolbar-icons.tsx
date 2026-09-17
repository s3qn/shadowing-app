import { StyleSheet, View } from 'react-native';
import Svg, { Circle, Line, Path, Text as SvgText } from 'react-native-svg';

import { fonts } from '@/constants/fonts';
import { type Verb } from '@/constants/theme';

import { VerbGradient, verbPaint } from '@/components/prism/verb-gradient';

/** Five 24-viewbox stroke icons for the player toolbar. Stroke 1.8, round
 * caps, no fill (the reading glyph is filled text instead, since a stroked
 * character is unreadable at this size). Each can take a `verb` instead of a
 * plain `color`, which paints it with that verb's prism gradient. */

type IconProps = { color: string; size?: number; verb?: Verb };

const STROKE = 1.8;

export function SpeedIcon({ color, size = 24, verb }: IconProps) {
  const paint = verb ? verbPaint(verb) : color;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {verb ? <VerbGradient verb={verb} /> : null}
      <Path d="M4 16a8 8 0 1 1 16 0" stroke={paint} strokeWidth={STROKE} strokeLinecap="round" />
      <Path d="M12 16 16 10" stroke={paint} strokeWidth={STROKE} strokeLinecap="round" />
      <Circle cx={12} cy={16} r={1.4} stroke={paint} strokeWidth={STROKE} />
    </Svg>
  );
}

/** Path data from Lucide's "repeat" icon (ISC licence), 24 viewBox:
 * https://lucide.dev/icons/repeat, also at
 * https://github.com/lucide-icons/lucide/blob/main/icons/repeat.svg
 * Tried "repeat-2" first: its two chevrons cross through the middle of the
 * glyph, which reads as a muddy X at this icon's small on-screen size. Plain
 * "repeat" keeps its loop as one clean rectangle with a chevron at each end,
 * so it stays legible at 22px and matches the classic media-player repeat
 * glyph better. */
export function RepeatIcon({ color, size = 24, verb }: IconProps) {
  const paint = verb ? verbPaint(verb) : color;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {verb ? <VerbGradient verb={verb} /> : null}
      <Path d="m17 2 4 4-4 4" stroke={paint} strokeWidth={STROKE} strokeLinecap="round" strokeLinejoin="round" />
      <Path
        d="M3 11v-1a4 4 0 0 1 4-4h14"
        stroke={paint}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path d="m7 22-4-4 4-4" stroke={paint} strokeWidth={STROKE} strokeLinecap="round" strokeLinejoin="round" />
      <Path
        d="M21 13v1a4 4 0 0 1-4 4H3"
        stroke={paint}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

export function ReadingIcon({ color, size = 24, verb }: IconProps) {
  const paint = verb ? verbPaint(verb) : color;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {verb ? <VerbGradient verb={verb} /> : null}
      <SvgText x={12} y={17.5} fontSize={17} fontFamily={fonts.serifJp} fill={paint} textAnchor="middle">
        あ
      </SvgText>
    </Svg>
  );
}

export function BlindIcon({ color, size = 24, verb }: IconProps) {
  const paint = verb ? verbPaint(verb) : color;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {verb ? <VerbGradient verb={verb} /> : null}
      <Path
        d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Z"
        stroke={paint}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Circle cx={12} cy={12} r={2.6} stroke={paint} strokeWidth={STROKE} />
      <Line x1={3.5} y1={20.5} x2={20.5} y2={3.5} stroke={paint} strokeWidth={STROKE} strokeLinecap="round" />
    </Svg>
  );
}

export function SearchIcon({ color, size = 24, verb }: IconProps) {
  const paint = verb ? verbPaint(verb) : color;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {verb ? <VerbGradient verb={verb} /> : null}
      <Circle cx={10.5} cy={10.5} r={6.5} stroke={paint} strokeWidth={STROKE} />
      <Line x1={15.5} y1={15.5} x2={20.5} y2={20.5} stroke={paint} strokeWidth={STROKE} strokeLinecap="round" />
    </Svg>
  );
}

export function EchoIcon({ color, size = 24 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M4 6v12l8-6-8-6Z" stroke={color} strokeWidth={STROKE} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M15.5 8.5a5 5 0 0 1 0 7" stroke={color} strokeWidth={STROKE} strokeLinecap="round" />
      <Path d="M19 6a9 9 0 0 1 0 12" stroke={color} strokeWidth={STROKE} strokeLinecap="round" />
    </Svg>
  );
}

/** A speech bubble built from plain Views, no SVG, for the Explain button in
 * the selection popup. `background` must match the surface the icon sits on:
 * the tail's fill hides the bubble's own border where the two shapes
 * overlap. */
export function ExplainIcon({ color, background, size = 22 }: IconProps & { background: string }) {
  return (
    <View style={{ width: size, height: size }}>
      <View style={[iconStyles.explainBubble, { borderColor: color }]}>
        <View style={[iconStyles.explainDot, { backgroundColor: color }]} />
        <View style={[iconStyles.explainDot, { backgroundColor: color }]} />
        <View style={[iconStyles.explainDot, { backgroundColor: color }]} />
        <View style={[iconStyles.explainTail, { borderColor: color, backgroundColor: background }]} />
      </View>
    </View>
  );
}

/** Two overlapping rounded squares, standing in for a copy icon, no SVG.
 * `background` must match the surface behind the icon so the front square
 * can hide the back square's border where they overlap. */
export function CopyIcon({ color, background, size = 15 }: IconProps & { background: string }) {
  return (
    <View style={{ width: size, height: size }}>
      <View style={[iconStyles.copySquare, iconStyles.copyBack, { borderColor: color }]} />
      <View
        style={[iconStyles.copySquare, iconStyles.copyFront, { borderColor: color, backgroundColor: background }]}
      />
    </View>
  );
}

/** A checkmark cut from the bottom-left corner of a rotated box, no SVG, for
 * the brief check state shown after a copy succeeds. */
export function CheckIcon({ color, size = 22 }: IconProps) {
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <View style={[iconStyles.check, { borderColor: color }]} />
    </View>
  );
}

const iconStyles = StyleSheet.create({
  explainBubble: {
    position: 'absolute',
    left: 2,
    top: 3,
    width: 18,
    height: 14,
    borderWidth: 1.5,
    borderRadius: 5,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2.5,
  },
  explainDot: { width: 2.5, height: 2.5, borderRadius: 1.25 },
  explainTail: {
    position: 'absolute',
    left: 3,
    bottom: -3,
    width: 5,
    height: 5,
    borderRightWidth: 1.5,
    borderBottomWidth: 1.5,
    transform: [{ rotate: '45deg' }],
  },
  copySquare: { position: 'absolute', width: 11, height: 11, borderWidth: 1.5, borderRadius: 2.5 },
  copyBack: { left: 1, top: 1 },
  copyFront: { left: 4, top: 4 },
  check: { width: 12, height: 6, borderLeftWidth: 2, borderBottomWidth: 2, transform: [{ rotate: '-45deg' }], marginTop: -2 },
});
