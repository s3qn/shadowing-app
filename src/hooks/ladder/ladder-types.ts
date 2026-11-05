import type { ReactNode } from 'react';
import type { SharedValue } from 'react-native-reanimated';

import type { Highlight } from '@/components/word-highlight';
import type { Language, Line, NativeLanguage } from '@/lib/api';
import type { LadderPace, LadderStage } from '@/lib/pass-programme';

// focus-stories: the shared shapes of the Stories gestures (D3, D8), used by the
// hosts, use-ladder, the stage composer and its pieces.
/** One word's box in the stage body's coordinates, for the word tap and its panel (D8). */
export type WordBox = { x: number; y: number; w: number; h: number };
/** What the stage sentence hands up through a ref: the body tap's hit test and the box a panel anchors to. */
export type SentenceHit = { hitTest: (x: number, y: number) => number | null; boxAt: (i: number) => WordBox | null };
/** The host's word-tap wiring (D8): the gloss and explain calls need these; `onHear` adds the panel's Hear button. */
export type LadderWord = { islandId: string; language: Language; native: NativeLanguage; onHear?: (text: string) => void };
/** Which sides have a neighbour island for the cube swipe (D3); the ids feed the previews' cache reads. */
export type LadderNeighbours = { prev: boolean; next: boolean; prevId?: string; nextId?: string };

/** The audio glue a track-span player (a video or a podcast) hands the ladder. */
export type LadderIo = {
  /** Current line from its start; the player calls `lineFinished()` at its end. */
  playLine: (speed: number) => void;
  /** Mic on the current line, the line under it unless silent. False when the mic did not open. */
  record: (speed: number) => Promise<boolean>;
  /** Silence the track, drop a take in progress, restore the dock speed. */
  stop: () => void;
  /**
   * The line's ladder finished (after Compare played the take back). `score` is
   * the take's total as the status row shows it (null while still scoring or
   * with no take). Return `{ holdMs }` to hold on the score longer than the
   * default (the island's Easy offer).
   */
  onLineDone: (score: number | null) => void | { holdMs?: number };
  /** A record-button ladder is over: let the track play on from the next line. */
  resume?: () => void;
  /** Move to the next line; false when there is none (the run's natural end, which may route away). */
  advance: () => boolean;
  /** Seek to line `i`; false when out of range. Never routes away, unlike `advance`. */
  goTo?: (i: number) => boolean;
  lineIndex?: number;
  lineCount?: number;
  /** The lines around the current one, for the stage's dim context. */
  context?: { before: string[]; after: string[] };
  title?: string;
  /** The dock speed the ruler sets (the players' `commitSpeed`). */
  setSpeed?: (v: number) => void;
  /** The current line's text, for the stage view. */
  lineText: string;
  line?: Line | null;
  /** False skips Mumble on this line (the guide's first line); default true. */
  prep?: boolean;
  /** Overrides the Hands-free (`autoEcho`) setting read at mount (a session forces it on). */
  autoEcho?: boolean;
  /** A mic that did not open leaves the run armed (the pass waits on Record again, as the island did) instead of ending it. */
  armOnMicFail?: boolean;
  /** focus-stories D8: the stage's word tap; absent, a word tap is a zone tap. */
  word?: LadderWord;
  /** focus-stories D3: neighbour islands for the cube swipe; absent, or false on a side, that swipe rubber-bands. */
  neighbours?: LadderNeighbours;
  /** focus-stories D3: the cube committed on that side; the host ends the run and opens the neighbour. */
  onHop?: (dir: -1 | 1) => void;
  /** focus-stories D5: the hold's translation; default the line's `en`. */
  translation?: string;
};

/** What the red button in the dock shows and does while the ladder runs. */
export type DockProps = {
  face: 'dot' | 'count' | 'stop' | 'dim';
  countIn: number | null;
  /** One count beat in ms, for the red button's beat ring. */
  beatMs: number;
  recordLabel: string;
  /** 0..4 while the five stages run, -1 otherwise. */
  stageIndex: number;
  ringDisabled: boolean;
  onRecord: () => void;
};

/** Everything the stage view needs to draw one ladder stage. */
export type LadderStageProps = {
  stage: LadderStage;
  index: number;
  total: number;
  phase: 'announce' | 'count' | 'gap' | 'run' | 'waiting';
  beat: number | null;
  repeat: number;
  repeats: number;
  isRecording: boolean;
  takePlaying: boolean;
  textHidden: boolean;
  text: string;
  /** The line with its words and ruby, for the card's furigana. */
  line?: Line | null;
  /** Live mic level, 0..1, for the recording meter. */
  level?: SharedValue<number>;
  /** The playing line's word highlight, so the stage's line lights up with the audio. */
  highlight?: Highlight;
  fill: SharedValue<number>;
  colour: string;
  /** The line is not playing under the take (no headset: turn-taking); the hint asks for headphones. */
  speaker?: boolean;
  holdTitle?: string | null;
  /**
   * This line's newest take's score, shown in the status row from the moment it
   * arrives until the next line starts; hidden when total is null. `scoring`
   * while the backend still works on it, `at` the take's recordedAt, `queued`
   * when the take is saved locally and waits for the connection (offline-first:
   * no total yet, the slot says so instead of scoring forever).
   */
  score?: { total: number | null; keptUp?: string; scoring?: boolean; at?: number; queued?: boolean };
  /** 2 while on the optional blind take after the recorded one. */
  round?: 1 | 2;
  /** Whether this run ends on the blind take (the blindTake setting). */
  finalOn?: boolean;
  /** False strikes the Mumble segment through (the guide's first line); it stays tappable. */
  prep?: boolean;
  /** bl58-easy-for-me: the Easy chip at the text block's top-right, so a run can be left with a mark. */
  chip?: ReactNode;
  /** Jump to pass `i` (0..4). The bar's segment tap and scrub release (D11), the step chip and its list (D9) all land here through `jumpStep`. */
  onJump: (i: number) => void;
  onEnd: () => void;
  /** The mic has closed on this take (Stop tapped, or the take ended and is saving). */
  stopped?: boolean;
  /** The dock's red button: stops the take in progress, which then moves on. */
  onStop?: () => void;
  /** The dock's red button while a take waits on the tap: counts in, then records. */
  onRecord?: () => void;
  /** Jumps to the blind take. */
  onFinal?: () => void;
  onHelp?: () => void;
  /** Next line (the bar's swipe left). */
  onSkip?: () => void;
  /** Previous line; on the first line it restarts it. */
  onPrev?: () => void;
  // Flow controls, all optional: a host without them (the island's own ladder) shows End and no bar or chips.
  paused?: boolean;
  onPause?: () => void;
  onResume?: () => void;
  loop?: boolean;
  onLoop?: (on: boolean) => void;
  lineIndex?: number;
  lineCount?: number;
  onLine?: (i: number) => void;
  context?: { before: string[]; after: string[] };
  title?: string;
  pace?: LadderPace;
  onPace?: (p: LadderPace) => void;
  speed?: number;
  onSpeed?: (v: number) => void;
  // focus-stories: the Stories gestures. All optional: a host without them keeps the zone taps and the bounce.
  /** D5: the translation shown while the body is held; empty or absent shows none. */
  translation?: string;
  /** D6: Hands-free (the `autoEcho` setting); false rests on Compare's score with the `ladder.tapNext` hint until a tap. */
  handsFree?: boolean;
  /** D8: the host's word-tap wiring; absent, a word tap is a zone tap. */
  word?: LadderWord;
  /** D3: which sides have a neighbour for the cube swipe; absent, both sides bounce. */
  neighbours?: LadderNeighbours;
  /** D3: the cube turn committed on that side (-1 previous, 1 next). */
  onHop?: (dir: -1 | 1) => void;
};
