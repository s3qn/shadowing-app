import type { Word } from '@/lib/api';

/** A chunk that may not start a row: closing punctuation, a small kana or a
 * long vowel mark (Japanese kinsoku). */
const NO_ROW_START = /^[。、，．,.！？!?」』）)】〉》…ー〜ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮ]/;
/** A word ending a sentence: the next word starts a new unit. */
const SENTENCE_END = /[。！？!?]$/;
/** A word cut after a small tsu (空っぽだっ + たり): the segmenter split a word. */
const CUT_TSU = /[っッ]$/;
/** Particles that ride on the word before them even when a line carries no
 * part of speech (a backend older than the pos underline). */
const PARTICLES = new Set(['ね', 'よ', 'な', 'か', 'わ', 'さ', 'ぞ', 'ぜ', 'の', 'は', 'が', 'を', 'に', 'へ', 'と', 'で', 'も', 'や', 'から', 'まで', 'より', 'けど', 'よね', 'かな']);
/** Trailing punctuation, stripped before the particle check. */
const TRAIL_PUNCT = /[。、，．,.！？!?」』）)…ー〜]+$/;
/** The longest a particle may be and still ride on the word before it. */
const PARTICLE_MAX = 3;
/** A unit never grows past this many characters, so it still fits a row. */
const UNIT_MAX = 10;

/**
 * Groups a Japanese line's words into the units a row may break between:
 * each word, with a short particle, a closing punctuation chunk or the rest
 * of a word the segmenter cut after a small tsu kept on the word before it.
 * So no row starts with "ね。" or "たり" when it can stay on the row above.
 * Returns each unit as its word indices, in order, covering every word.
 */
export function kinsokuUnits(words: Word[]): number[][] {
  const units: number[][] = [];
  let len = 0;
  words.forEach((w, i) => {
    const prev = i > 0 ? words[i - 1] : undefined;
    const n = Array.from(w.text).length;
    const attach =
      !!prev &&
      len + n <= UNIT_MAX &&
      (NO_ROW_START.test(w.text) ||
        (!SENTENCE_END.test(prev.text) &&
          (isParticle(w, n) || CUT_TSU.test(prev.text))));
    const last = units[units.length - 1];
    if (attach && last) {
      last.push(i);
      len += n;
    } else {
      units.push([i]);
      len = n;
    }
  });
  return units;
}

function isParticle(w: Word, n: number): boolean {
  if (w.pos === 'particle') return n <= PARTICLE_MAX;
  return PARTICLES.has(w.text.replace(TRAIL_PUNCT, ''));
}
