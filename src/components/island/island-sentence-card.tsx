// The island's sentence card: the tappable words (or the wordless line), the
// reading row, the take feedback, the kept-up note and the English strip, in
// one card on the waterline. The route owns every piece of state and hands it
// down; `memo` gives the card the same containment the route's useMemo had.
import { type ComponentProps, memo, type ReactNode, type RefObject } from 'react';
import { type LayoutChangeEvent, Pressable, StyleSheet, Text, View } from 'react-native';
import { GestureDetector, type ScrollView } from 'react-native-gesture-handler';
import Animated from 'react-native-reanimated';

import { Frost } from '@/components/frost';
import { RubyWord } from '@/components/ruby-word';
import { SELECTION_HANDLE_CLEARANCE, SelectionHandles } from '@/components/selection-handles';
import { SELECTION_POPUP_WIDTH, SelectionPopup } from '@/components/selection-popup';
import { SlideReveal } from '@/components/slide-reveal';
import { TakeFeedback } from '@/components/take-feedback';
import { speedLabel } from '@/components/tide/speed-popover';
import type { Highlight } from '@/components/word-highlight';
import { POPOVER_WIDTH, WordPanel } from '@/components/word-panel';
import { fonts } from '@/constants/fonts';
import { Radius, tide } from '@/constants/theme';
import { textSpanToWords, type PhraseSpan } from '@/hooks/use-phrase';
import type { Gloss, Line, TakeAnalysis, TakeScore } from '@/lib/api';
import type { TFn } from '@/lib/i18n';
import { noopLayout } from '@/lib/island/island-consts';
import type { WordBoxes } from '@/lib/island/word-hit';
import type { wordPitches } from '@/lib/pitch';
import type { ReadingMode } from '@/lib/settings';
import type { useSlideReveal } from '@/lib/slide-reveal';
import type { wordsKeptUp } from '@/lib/takes';

type Props = {
  line: Line;
  blind: boolean;
  hidden: boolean;
  readingMode: ReadingMode;
  isJa: boolean;
  isRtl: boolean;
  isGrammar: boolean;
  highlight: Highlight;
  selected: number | null;
  dragSpan: PhraseSpan | null;
  phraseSpan: PhraseSpan | null;
  marks: TakeScore['words'] | null;
  keptUp: ReturnType<typeof wordsKeptUp>;
  total: number | null;
  ladderNote: { dir: 'up' | 'down'; speed: number } | null;
  feedback: TakeAnalysis | null;
  pitches: ReturnType<typeof wordPitches> | null;
  glossData: Gloss | null;
  explainContext: string | null | undefined;
  blockWidth: number;
  fit: number;
  handleDragging: boolean;
  modeLine: string | null;
  enFrosted: boolean;
  englishShown: boolean;
  t: TFn;
  /** The route's `sentenceGesture`: pan, swipe and tap over the words. */
  gesture: ComponentProps<typeof GestureDetector>['gesture'];
  /** The route's `cardDragStyle`: the rubber-band drag, driven on the UI thread. */
  dragStyle: ComponentProps<typeof Animated.View>['style'];
  jaReveal: ReturnType<typeof useSlideReveal>;
  enReveal: ReturnType<typeof useSlideReveal>;
  /** The guide's `lineCard` anchor: its ref, and the remeasure on layout. */
  cardRef: RefObject<View | null>;
  onCardLayout: () => void;
  /** The guide's `easyChip` anchor around the chip the route builds. */
  chipRef: RefObject<View | null>;
  onChipLayout: ComponentProps<typeof View>['onLayout'];
  easyChip: ReactNode;
  wordBoxes: RefObject<WordBoxes>;
  scrollRef: RefObject<ScrollView | null>;
  onBlockLayout: (e: LayoutChangeEvent) => void;
  onBlockTouch: () => void;
  onTapEmpty: NonNullable<ComponentProps<typeof Pressable>['onPress']>;
  onWordLayout: (i: number, e: LayoutChangeEvent) => void;
  onGrabHandle: ComponentProps<typeof SelectionHandles>['onGrab'];
  onDragHandle: ComponentProps<typeof SelectionHandles>['onDrag'];
  onReleaseHandle: ComponentProps<typeof SelectionHandles>['onRelease'];
  onHearWord: ComponentProps<typeof WordPanel>['onHear'];
  onClosePanel: ComponentProps<typeof WordPanel>['onClose'];
  onRepeatSelection: ComponentProps<typeof SelectionPopup>['onRepeat'];
  onOpenExplain: ComponentProps<typeof SelectionPopup>['onExplain'];
  onCopySelection: ComponentProps<typeof SelectionPopup>['onCopy'];
};

type WordsProps = Pick<
  Props,
  | 'line'
  | 'blind'
  | 'hidden'
  | 'readingMode'
  | 'isJa'
  | 'isGrammar'
  | 'highlight'
  | 'selected'
  | 'dragSpan'
  | 'phraseSpan'
  | 'marks'
  | 'pitches'
  | 'glossData'
  | 'explainContext'
  | 'blockWidth'
  | 'fit'
  | 'handleDragging'
  | 'gesture'
  | 'jaReveal'
  | 'wordBoxes'
  | 'scrollRef'
  | 'onBlockLayout'
  | 'onBlockTouch'
  | 'onTapEmpty'
  | 'onWordLayout'
  | 'onGrabHandle'
  | 'onDragHandle'
  | 'onReleaseHandle'
  | 'onHearWord'
  | 'onClosePanel'
  | 'onRepeatSelection'
  | 'onOpenExplain'
  | 'onCopySelection'
>;

type FooterProps = Pick<
  Props,
  'line' | 'hidden' | 'isJa' | 'isRtl' | 'modeLine' | 'feedback' | 'total' | 'keptUp' | 'ladderNote' | 'enFrosted' | 'englishShown' | 'enReveal' | 't'
>;

// The sentence sits on the waterline: the tappable block when words are
// known, the fallback line when they are not, then the reading row and the
// English strip, all inside one card. Blind keeps all of it in place and
// frosts the Japanese; dragging a finger across it sharpens whichever
// words sit under the touch, live, so a line change mid-drag (the island
// moving on) shows the new line's word under the finger sharp right away.
// The gesture sits outside the Frost because the frosted copy takes no
// touches; the Frost adds no offset, so the gesture's coordinates still
// match the word boxes.
export const IslandSentenceCard = memo(function IslandSentenceCard(props: Props) {
  const { dragStyle, cardRef, onCardLayout, chipRef, onChipLayout, easyChip } = props;
  return (
    <Animated.View ref={cardRef} onLayout={onCardLayout} style={[styles.activeCard, dragStyle]}>
      {/* bl58-easy-for-me: E4, the quiet pill beside the line number (the header carries the number). */}
      <View style={styles.easyRow} pointerEvents="box-none">
        <View ref={chipRef} onLayout={onChipLayout} collapsable={false}>
          {easyChip}
        </View>
      </View>
      <SentenceWords {...props} />
      <SentenceFooter {...props} />
    </Animated.View>
  );
});

function SentenceWords({
  line,
  blind,
  hidden,
  readingMode,
  isJa,
  isGrammar,
  highlight,
  selected,
  dragSpan,
  phraseSpan,
  marks,
  pitches,
  glossData,
  explainContext,
  blockWidth,
  fit,
  handleDragging,
  gesture,
  jaReveal,
  wordBoxes,
  scrollRef,
  onBlockLayout,
  onBlockTouch,
  onTapEmpty,
  onWordLayout,
  onGrabHandle,
  onDragHandle,
  onReleaseHandle,
  onHearWord,
  onClosePanel,
  onRepeatSelection,
  onOpenExplain,
  onCopySelection,
}: WordsProps) {
  // Popover under the tapped word, centred on it, kept inside the block.
  const box = selected !== null ? wordBoxes.current[selected] : undefined;
  const popLeft = box
    ? Math.max(0, Math.min(blockWidth - POPOVER_WIDTH, box.x + box.width / 2 - POPOVER_WIDTH / 2))
    : 0;
  const popTop = box ? box.y + box.height + 6 : 0;

  // The Repeat popup under a drag selection: the same clamping approach as
  // the word popover above, but anchored to the union of the span's word
  // boxes instead of one box.
  const dragBoxes = dragSpan
    ? Array.from(
        { length: dragSpan.to - dragSpan.from + 1 },
        (_, k) => wordBoxes.current[dragSpan.from + k],
      ).filter((b): b is { x: number; y: number; width: number; height: number } => !!b)
    : [];
  const dragUnion = dragBoxes.length
    ? dragBoxes.reduce(
        (acc, b) => ({
          x: Math.min(acc.x, b.x),
          y: Math.min(acc.y, b.y),
          right: Math.max(acc.right, b.x + b.width),
          bottom: Math.max(acc.bottom, b.y + b.height),
        }),
        { x: Infinity, y: Infinity, right: -Infinity, bottom: -Infinity },
      )
    : null;
  const dragPopLeft = dragUnion
    ? Math.max(
        0,
        Math.min(
          blockWidth - SELECTION_POPUP_WIDTH,
          dragUnion.x + (dragUnion.right - dragUnion.x) / 2 - SELECTION_POPUP_WIDTH / 2,
        ),
      )
    : 0;
  const dragPopTop = dragUnion ? dragUnion.bottom + SELECTION_HANDLE_CLEARANCE : 0;

  // Chunks for the wordless fallback's per-character reveal.
  const jaChars = Array.from(line.ja);
  const gSpan = isGrammar ? textSpanToWords(line, line.span) : null;

  if (line.words.length === 0) {
    return (
      <GestureDetector gesture={jaReveal.gesture}>
        <View collapsable={false}>
          {hidden ? (
            <SlideReveal
              finger={jaReveal.finger}
              count={jaChars.length}
              rowStyle={styles.words}
              blur={4.5}
              renderChunk={(i) => (
                <Text key={i} style={[styles.ja, fit < 1 && { fontSize: 26 * fit, lineHeight: 38 * fit }]}>
                  {jaChars[i]}
                </Text>
              )}
            />
          ) : (
            <Text style={[styles.ja, fit < 1 && { fontSize: 26 * fit, lineHeight: 38 * fit }]}>{line.ja}</Text>
          )}
        </View>
      </GestureDetector>
    );
  }

  return (
    <>
      {/* Fills the whole card, behind the block: catches a tap on the
          card's own padding, which sits outside the block's bounds and
          so never reaches the GestureDetector or its hitTest miss. Off in
          Blind mode, where only a hold on the sentence does anything. */}
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={onTapEmpty}
        disabled={blind}
        accessible={false}
      />
      <View
        style={styles.block}
        onLayout={onBlockLayout}
        onTouchStart={onBlockTouch}>
        <GestureDetector gesture={blind ? jaReveal.gesture : gesture}>
          <View collapsable={false}>
            {hidden ? (
              <SlideReveal
                finger={jaReveal.finger}
                count={line.words.length}
                rowStyle={styles.words}
                blur={4.5}
                renderChunk={(i, sharp) => (
                  <RubyWord
                    key={i}
                    word={line.words[i]!}
                    showRuby={isJa && readingMode === 'furigana'}
                    showPosAndRomaji={isJa}
                    index={i}
                    highlight={highlight}
                    concealed={!sharp}
                    selected={false}
                    grammar={!!gSpan && i >= gSpan.from && i <= gSpan.to}
                    dimmed={!!phraseSpan && (i < phraseSpan.from || i > phraseSpan.to)}
                    mark={marks && marks[i] !== 'ok' && marks[i] !== 'none' ? marks[i] : null}
                    pitch={pitches?.[i]}
                    scale={fit}
                    onLayout={noopLayout}
                  />
                )}
              />
            ) : (
              <>
                <View style={styles.words}>
                  {line.words.map((w, i) => (
                    <RubyWord
                      key={i}
                      word={w}
                      showRuby={isJa && readingMode === 'furigana'}
                      showPosAndRomaji={isJa}
                      index={i}
                      highlight={highlight}
                      concealed={hidden}
                      selected={i === selected || (!!dragSpan && i >= dragSpan.from && i <= dragSpan.to)}
                      grammar={!!gSpan && i >= gSpan.from && i <= gSpan.to}
                      dimmed={!!phraseSpan && (i < phraseSpan.from || i > phraseSpan.to)}
                      mark={marks && marks[i] !== 'ok' && marks[i] !== 'none' ? marks[i] : null}
                      pitch={pitches?.[i]}
                      scale={fit}
                      onLayout={onWordLayout}
                    />
                  ))}
                </View>
              </>
            )}
          </View>
        </GestureDetector>
        {dragSpan && wordBoxes.current[dragSpan.from] && wordBoxes.current[dragSpan.to] ? (
          <SelectionHandles
            start={wordBoxes.current[dragSpan.from]!}
            end={wordBoxes.current[dragSpan.to]!}
            scrollRef={scrollRef}
            onGrab={onGrabHandle}
            onDrag={onDragHandle}
            onRelease={onReleaseHandle}
          />
        ) : null}
        {selected !== null && line.words[selected] ? (
          <WordPanel
            word={line.words[selected]!.text}
            gloss={glossData}
            context={explainContext}
            left={popLeft}
            top={popTop}
            romaji={isJa && readingMode === 'romaji'}
            dictionary={isJa}
            onHear={onHearWord}
            onClose={onClosePanel}
          />
        ) : null}
        {dragSpan && dragUnion && !handleDragging ? (
          <SelectionPopup
            left={dragPopLeft}
            top={dragPopTop}
            onRepeat={onRepeatSelection}
            onExplain={onOpenExplain}
            onCopy={onCopySelection}
          />
        ) : null}
      </View>
    </>
  );
}

function SentenceFooter({
  line,
  hidden,
  isJa,
  isRtl,
  modeLine,
  feedback,
  total,
  keptUp,
  ladderNote,
  enFrosted,
  englishShown,
  enReveal,
  t,
}: FooterProps) {
  // Chunks for the English strip's per-word reveal.
  const enWords = line.en ? line.en.split(' ') : [];
  return (
    <>
      {modeLine !== null ? (
        <Frost frosted={hidden} ink={tide.textDim}>
          <Text style={styles.reading}>{modeLine}</Text>
        </Frost>
      ) : null}

      {/* languages: mora feedback only exists for Japanese timelines. */}
      {isJa && feedback && !hidden ? <TakeFeedback moras={line.timeline} analysis={feedback} /> : null}

      {total !== null || keptUp !== null || ladderNote ? (
        <Text
          style={[
            styles.keptUp,
            ladderNote ? { color: ladderNote.dir === 'up' ? tide.listen : tide.text } : null,
          ]}
        >
          {total !== null ? (
            <Text style={{ color: total >= 80 ? tide.listen : total >= 50 ? tide.text : tide.record }}>
              {t('player.takeScore', { score: total })}
            </Text>
          ) : null}
          {keptUp !== null
            ? `${total !== null ? ' · ' : ''}${t('player.keptUpWords', { kept: keptUp.kept, total: keptUp.total })}`
            : ''}
          {ladderNote
            ? `${keptUp !== null || total !== null ? ' · ' : ''}${t(ladderNote.dir === 'up' ? 'player.ladderUp' : 'player.ladderDown', { speed: speedLabel(ladderNote.speed) })}`
            : ''}
        </Text>
      ) : null}

      {/* The English in its own inset strip at the foot of the card. Blind
          frosts it; dragging a finger across the words sharpens whichever
          ones sit under it and the rest frost again once the finger lifts.
          The Pressable stays outermost (its padding would otherwise offset
          the gesture's x/y from the word boxes, which measure from the
          content inside that padding) and the strip sits above the card's
          tap-to-play fill, so a press here never plays. */}
      {line.en ? (
        <Pressable style={styles.enStrip} accessibilityLabel={englishShown ? line.en : t('player.translationHidden')}>
          <GestureDetector gesture={enReveal.gesture}>
            <View collapsable={false}>
              {enFrosted ? (
                <SlideReveal
                  finger={enReveal.finger}
                  count={enWords.length}
                  // languages: a Hebrew translation reveals right to left,
                  // so wrapping still fills each row starting from the right.
                  rowStyle={isRtl ? [styles.words, { flexDirection: 'row-reverse' as const }] : styles.words}
                  ink={tide.textDim}
                  blur={3.5}
                  renderChunk={(i) => (
                    <Text key={i} style={[styles.en, isRtl && styles.enRtl]}>
                      {enWords[i]}
                      {i < enWords.length - 1 ? ' ' : ''}
                    </Text>
                  )}
                />
              ) : (
                <Text style={[styles.en, isRtl && styles.enRtl]}>{line.en}</Text>
              )}
            </View>
          </GestureDetector>
        </Pressable>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  ja: { fontFamily: fonts.serifJp, fontSize: 26, lineHeight: 38, textAlign: 'center', color: tide.text },
  activeCard: {
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,158,128,0.35)',
    backgroundColor: 'rgba(255,255,255,0.04)',
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  block: { position: 'relative', zIndex: 5 },
  words: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center' },
  reading: { fontFamily: fonts.serifJp, fontSize: 16, lineHeight: 24, textAlign: 'center', color: tide.textDim },
  keptUp: { fontFamily: fonts.ui, fontSize: 12, textAlign: 'center', color: tide.textDim, marginTop: 2 },
  enStrip: {
    marginTop: 10,
    paddingVertical: 6,
    paddingHorizontal: 16,
    borderRadius: Radius.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.12)',
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  en: { fontFamily: fonts.ui, fontSize: 13, lineHeight: 18, textAlign: 'center', color: tide.textDim },
  // languages: iOS honours writingDirection; Android ignores it and falls
  // back to the string's own first-strong direction, which is right for
  // Hebrew text anyway.
  enRtl: { writingDirection: 'rtl' },
  // bl58-easy-for-me: the E4 pill's row, right-aligned above the words.
  easyRow: { flexDirection: 'row', justifyContent: 'flex-end', marginBottom: 4, zIndex: 6 },
});
