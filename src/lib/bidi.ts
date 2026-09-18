/**
 * Directional isolates, for text that mixes scripts.
 *
 * A run of Latin inside a Hebrew sentence is placed by the Unicode
 * bidirectional algorithm, not by where it sits in the source, and two things
 * go wrong without help. A Latin run at the start of a line decides the whole
 * line's direction (rule P2 takes the first strong character), so a Hebrew
 * sentence opening with "Echo Tail" lays out left to right and the name lands
 * at the wrong end. And punctuation or a symbol touching the run counts as
 * neutral, resolves to the Hebrew direction and drifts to the far side of the
 * line, away from the words it belongs to.
 *
 * `isolate()` wraps a run in FIRST STRONG ISOLATE (U+2068) and POP
 * DIRECTIONAL ISOLATE (U+2069). The run takes its direction from its own
 * first strong character, the algorithm skips over it while deciding the
 * line's direction, and it stays glued together. Isolates are text rather
 * than style, so unlike `writingDirection` they travel with the string into
 * an Alert body or an accessibility label, and they behave the same on both
 * platforms.
 */

/** U+2068 FIRST STRONG ISOLATE. */
const FSI = '⁨';
/** U+2069 POP DIRECTIONAL ISOLATE. */
const PDI = '⁩';

/**
 * Wraps a run so the text around it keeps its own direction. Safe on a run
 * that matches the sentence already: an isolate around Hebrew inside Hebrew
 * changes nothing. Both characters are default-ignorable, so they take no
 * width and screen readers skip them.
 */
export function isolate(text: string): string {
  return text === '' ? '' : FSI + text + PDI;
}
