import Svg, { Circle, Line, Path, Text as SvgText } from 'react-native-svg';

import { fonts } from '@/constants/fonts';

/** Five 24-viewbox stroke icons for the player toolbar. Stroke 1.8, round
 * caps, no fill (the reading glyph is filled text instead, since a stroked
 * character is unreadable at this size). */

type IconProps = { color: string; size?: number };

const STROKE = 1.8;

export function SpeedIcon({ color, size = 24 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M4 16a8 8 0 1 1 16 0" stroke={color} strokeWidth={STROKE} strokeLinecap="round" />
      <Path d="M12 16 16 10" stroke={color} strokeWidth={STROKE} strokeLinecap="round" />
      <Circle cx={12} cy={16} r={1.4} stroke={color} strokeWidth={STROKE} />
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
export function RepeatIcon({ color, size = 24 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="m17 2 4 4-4 4" stroke={color} strokeWidth={STROKE} strokeLinecap="round" strokeLinejoin="round" />
      <Path
        d="M3 11v-1a4 4 0 0 1 4-4h14"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path d="m7 22-4-4 4-4" stroke={color} strokeWidth={STROKE} strokeLinecap="round" strokeLinejoin="round" />
      <Path
        d="M21 13v1a4 4 0 0 1-4 4H3"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

export function ReadingIcon({ color, size = 24 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <SvgText x={12} y={17.5} fontSize={17} fontFamily={fonts.serifJp} fill={color} textAnchor="middle">
        あ
      </SvgText>
    </Svg>
  );
}

export function BlindIcon({ color, size = 24 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Z"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Circle cx={12} cy={12} r={2.6} stroke={color} strokeWidth={STROKE} />
      <Line x1={3.5} y1={20.5} x2={20.5} y2={3.5} stroke={color} strokeWidth={STROKE} strokeLinecap="round" />
    </Svg>
  );
}

export function SearchIcon({ color, size = 24 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx={10.5} cy={10.5} r={6.5} stroke={color} strokeWidth={STROKE} />
      <Line x1={15.5} y1={15.5} x2={20.5} y2={20.5} stroke={color} strokeWidth={STROKE} strokeLinecap="round" />
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
