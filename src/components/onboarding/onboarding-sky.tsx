import { useMemo } from 'react';
import { type DimensionValue, StyleSheet, View, useWindowDimensions } from 'react-native';

import { tideSkies } from '@/constants/theme';

const [SKY_TOP, SKY_MID, SKY_BOTTOM] = tideSkies.night;

/** The five stars of the design's `.stars` layer, as fractions of the
 * screen. Sizes are a touch larger than the artifact's 1px and 1.5px: a
 * CSS pixel on a 280px-wide mock is about 1.4pt on a phone. */
const STARS: { left: DimensionValue; top: DimensionValue; size: number; opacity: number }[] = [
  { left: '20%', top: '12%', size: 2, opacity: 0.7 },
  { left: '72%', top: '8%', size: 2, opacity: 0.5 },
  { left: '86%', top: '22%', size: 2.5, opacity: 0.6 },
  { left: '40%', top: '30%', size: 2, opacity: 0.4 },
  { left: '10%', top: '40%', size: 2, opacity: 0.5 },
];

/** The light bands: the artifact's `.water`, a 2pt line every 12pt over the
 * bottom 30% of the screen, fading in over the first 40% of that band. */
const BAND_ZONE = 0.3;
const BAND_PITCH = 12;
const BAND_THICKNESS = 2;
const BAND_ALPHA = 0.07;
const BAND_FADE = 0.4;

function bandOffsets(zoneHeight: number): { top: number; alpha: number }[] {
  const rows: { top: number; alpha: number }[] = [];
  const fadeTo = Math.max(1, zoneHeight * BAND_FADE);
  for (let top = 0; top + BAND_THICKNESS <= zoneHeight; top += BAND_PITCH) {
    rows.push({ top, alpha: BAND_ALPHA * Math.min(1, top / fadeTo) });
  }
  return rows;
}

/**
 * The ground every onboarding step sits on: the deep navy gradient, a few
 * faint stars, and soft horizontal light bands low on the screen. Mounted
 * once for the whole route so stepping forward never remounts or flashes it.
 * Plain Views and a background gradient, no blur and no canvas: this layer
 * is always on screen and must cost nothing per frame.
 */
export function OnboardingSky() {
  const { height } = useWindowDimensions();
  const zoneHeight = Math.round(height * BAND_ZONE);
  const bands = useMemo(() => bandOffsets(zoneHeight), [zoneHeight]);

  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.sky]}>
      {STARS.map((star) => (
        <View
          key={`${star.left}-${star.top}`}
          style={[
            styles.star,
            {
              left: star.left,
              top: star.top,
              width: star.size,
              height: star.size,
              borderRadius: star.size / 2,
              opacity: star.opacity,
            },
          ]}
        />
      ))}
      <View style={[styles.bandZone, { height: zoneHeight }]}>
        {bands.map((band) => (
          <View
            key={band.top}
            style={[styles.band, { top: band.top, backgroundColor: `rgba(124,200,255,${band.alpha.toFixed(3)})` }]}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  sky: {
    backgroundColor: SKY_TOP,
    experimental_backgroundImage: `linear-gradient(180deg, ${SKY_TOP} 0%, ${SKY_MID} 58%, ${SKY_BOTTOM} 100%)`,
  },
  star: { position: 'absolute', backgroundColor: '#FFFFFF' },
  bandZone: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  band: { position: 'absolute', left: 0, right: 0, height: BAND_THICKNESS },
});
