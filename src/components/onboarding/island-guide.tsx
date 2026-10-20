import { type MutableRefObject, useEffect, useRef, useState } from 'react';

import { StyleSheet, View, useWindowDimensions } from 'react-native';

import { GuideLayer, guideBubbleHeight } from '@/components/onboarding/guide-layer';
import { setGuideStep, useGuideAnchors, useGuideStep } from '@/lib/guide';
import { useT } from '@/lib/i18n';

type Box = { x: number; y: number; width: number };

export type IslandGuideProps = {
  /** The dock's play and record boxes, relative to the dock root. */
  anchors: MutableRefObject<Partial<Record<string, Box>>>;
  /** The dock root's y inside the scene. */
  dockY: MutableRefObject<number>;
  /** Screen y of the scene's top: the status bar plus the header row. */
  sceneTop: number;
  playing: boolean;
  echoStep: string;
  stageActive: boolean;
};

/** A dock button is 48 pt; the hole is inflated 8 pt a side. */
const HOLE = 64;
/** Only the button's own 44 pt answers: next and the speed chip reach into the 64 pt glow. */
const HIT_INSET = 10;

/**
 * Moments 3a to 3d of the first-run guide: lights Listen, then Shadow on line 1,
 * Shadow on line 2 (four bubbles: the warm-up, Mumble, Read along, then Again and Ready) and Shadow on line 3 alone.
 * A tap turns the bubble's page; the control lights and answers from the page that says to tap it. The layer fades out
 * while the real ladder run is on screen. Only a finished Compare moves the guide on (the island's onEchoTakeStopped);
 * any other run end keeps the step.
 */
export function IslandGuide(p: IslandGuideProps) {
  const { t } = useT();
  const step = useGuideStep();
  const { lineCard: card, easyChip: chip } = useGuideAnchors();
  const { width: screenW } = useWindowDimensions();
  const [tapped, setTapped] = useState(false);
  const wasPlaying = useRef(false);

  const running = p.stageActive || (p.echoStep !== 'idle' && p.echoStep !== 'done');

  // Under the guide the island plays a line once and parks it at its top
  // (`playsOnce` there), so playing turning false means the line ended and
  // nothing is still running when Shadow lights up.
  useEffect(() => {
    if (step !== 'listen') return;
    if (running || (wasPlaying.current && !p.playing)) setGuideStep('shadow');
    else if (p.playing) wasPlaying.current = true;
  }, [p.playing, running, step]);

  // The hint stops on the first tap of each step and restarts with the next.
  useEffect(() => {
    setTapped(running || p.playing);
  }, [running, p.playing, step]);

  const target = step === 'listen' ? p.anchors.current.play : p.anchors.current.record;
  const cx = target ? target.x + target.width / 2 : NaN;
  const cy = target ? p.sceneTop + p.dockY.current + target.y + 22 : NaN;
  const have = Number.isFinite(cx) && Number.isFinite(cy);
  if (step !== 'listen' && step !== 'shadow' && step !== 'prep' && step !== 'solo') return null;
  const prepVars = {
    a: t('settings.onboarding.passMemoriseTitle'),
    b: t('settings.onboarding.passSayTitle'),
    again: t('ladder.again'),
    ready: t('ladder.ready'),
  };
  // bl58-easy-for-me: the Easy chip is lit on every moment; its three pages close the listen moment.
  const text =
    step === 'listen'
      ? [t('guide.listen'), t('guide.listen.b2'), t('guide.easy', { easy: t('ladder.easy') }), t('guide.easy.b2'), t('guide.easy.b3')]
      : step === 'shadow'
        ? [t('guide.shadow'), t('guide.shadow.b2'), t('guide.shadow.b3')]
        : step === 'prep'
          ? [t('guide.prep', prepVars), t('guide.prep.b2', prepVars), t('guide.prep.b3', prepVars), t('guide.prep.b4', prepVars)]
          : [t('guide.solo'), t('guide.solo.b2')];
  const kind = step === 'listen' ? 'listen' : step === 'solo' ? 'proud' : 'record';
  // The bubble sits by the dock hole, as before the chip's hole was added (the chip is `aside`).
  const holeY = cy - HOLE / 2;
  const bubbleTop = have ? (holeY > 400 ? holeY - guideBubbleHeight(kind, screenW) - 24 : holeY + HOLE + 22) : undefined;
  const hole = have ? { x: cx - HOLE / 2, y: cy - HOLE / 2, width: HOLE, height: HOLE, radius: HOLE / 2, hitInset: HIT_INSET } : null;
  return (
    <>
      <GuideLayer
        enabled={!running}
        holes={[
          ...(hole ? [hole] : []),
          ...(chip ? [{ x: chip.x - 6, y: chip.y - 6, width: chip.width + 12, height: chip.height + 12, aside: true }] : []),
        ]}
        // The current line card stays lit so the line, reading and gloss are readable.
        seeThrough={card ? [{ x: card.x, y: card.y, width: card.width, height: card.height, radius: 24 }] : undefined}
        hint={have ? { x: cx, y: cy } : undefined}
        stopped={tapped}
        bubble={{ kind, text, top: bubbleTop }}
        // Listen lights on "Tap Listen" (page 2); the Easy pages after it keep it lit.
        litPage={step === 'listen' ? 1 : undefined}
      />
      {/* While a run is on the dock (no stage view over it) only its Shadow button answers: prev, play, next, speed and
          the gear sit in this band and are swallowed. The stage view's own controls are never covered. */}
      {running && !p.stageActive && hole ? (
        <>
          <View style={[styles.sink, { top: hole.y, height: HOLE, left: 0, width: Math.max(0, hole.x + HIT_INSET) }]} onStartShouldSetResponder={() => true} />
          <View style={[styles.sink, { top: hole.y, height: HOLE, left: hole.x + HOLE - HIT_INSET, right: 0 }]} onStartShouldSetResponder={() => true} />
        </>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({ sink: { position: 'absolute', zIndex: 1000, elevation: 1000 } });
