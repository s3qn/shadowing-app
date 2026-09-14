/**
 * Modified Hepburn romanisation, derived on the phone from the katakana
 * moras VOICEVOX spoke rather than from a dictionary reading, so it always
 * matches what the line actually sounds like. No imports: this file compiles
 * and runs on its own.
 */

const PUNCTUATION: Record<string, string> = { '、': ',', '。': '.', '！': '!', '？': '?', '…': '…' };

const SMALL_VOWEL_KANA = new Set(['ャ', 'ュ', 'ョ', 'ァ', 'ィ', 'ゥ', 'ェ', 'ォ', 'ヮ']);

const BASE: Record<string, string> = {
  ア: 'a', イ: 'i', ウ: 'u', エ: 'e', オ: 'o',
  カ: 'ka', キ: 'ki', ク: 'ku', ケ: 'ke', コ: 'ko',
  サ: 'sa', シ: 'shi', ス: 'su', セ: 'se', ソ: 'so',
  タ: 'ta', チ: 'chi', ツ: 'tsu', テ: 'te', ト: 'to',
  ナ: 'na', ニ: 'ni', ヌ: 'nu', ネ: 'ne', ノ: 'no',
  ハ: 'ha', ヒ: 'hi', フ: 'fu', ヘ: 'he', ホ: 'ho',
  マ: 'ma', ミ: 'mi', ム: 'mu', メ: 'me', モ: 'mo',
  ヤ: 'ya', ユ: 'yu', ヨ: 'yo',
  ラ: 'ra', リ: 'ri', ル: 'ru', レ: 're', ロ: 'ro',
  ワ: 'wa', ヰ: 'i', ヱ: 'e', ヲ: 'o', ン: 'n',
  ガ: 'ga', ギ: 'gi', グ: 'gu', ゲ: 'ge', ゴ: 'go',
  ザ: 'za', ジ: 'ji', ズ: 'zu', ゼ: 'ze', ゾ: 'zo',
  ダ: 'da', ヂ: 'ji', ヅ: 'zu', デ: 'de', ド: 'do',
  バ: 'ba', ビ: 'bi', ブ: 'bu', ベ: 'be', ボ: 'bo',
  パ: 'pa', ピ: 'pi', プ: 'pu', ペ: 'pe', ポ: 'po',
  ヴ: 'vu',
  ァ: 'a', ィ: 'i', ゥ: 'u', ェ: 'e', ォ: 'o', ヮ: 'wa',
};

const DIGRAPH: Record<string, string> = {
  キャ: 'kya', キュ: 'kyu', キョ: 'kyo',
  シャ: 'sha', シュ: 'shu', ショ: 'sho', シェ: 'she',
  チャ: 'cha', チュ: 'chu', チョ: 'cho', チェ: 'che',
  ニャ: 'nya', ニュ: 'nyu', ニョ: 'nyo',
  ヒャ: 'hya', ヒュ: 'hyu', ヒョ: 'hyo',
  ミャ: 'mya', ミュ: 'myu', ミョ: 'myo',
  リャ: 'rya', リュ: 'ryu', リョ: 'ryo',
  ギャ: 'gya', ギュ: 'gyu', ギョ: 'gyo',
  ジャ: 'ja', ジュ: 'ju', ジョ: 'jo', ジェ: 'je',
  ヂャ: 'ja', ヂュ: 'ju', ヂョ: 'jo',
  ビャ: 'bya', ビュ: 'byu', ビョ: 'byo',
  ピャ: 'pya', ピュ: 'pyu', ピョ: 'pyo',
  ファ: 'fa', フィ: 'fi', フェ: 'fe', フォ: 'fo', フュ: 'fyu',
  ティ: 'ti', ディ: 'di', トゥ: 'tu', ドゥ: 'du', テュ: 'tyu', デュ: 'dyu',
  ウィ: 'wi', ウェ: 'we', ウォ: 'wo',
  ヴァ: 'va', ヴィ: 'vi', ヴェ: 've', ヴォ: 'vo',
  ツァ: 'tsa', ツィ: 'tsi', ツェ: 'tse', ツォ: 'tso',
  イェ: 'ye',
  クァ: 'kwa', グァ: 'gwa',
};

const VOWEL_OF: Record<string, string> = { a: 'a', i: 'i', u: 'u', e: 'e', o: 'o' };
const MACRON: Record<string, string> = { a: 'ā', u: 'ū', e: 'ē', o: 'ō' };

function toKatakana(kana: string): string {
  let out = '';
  for (const ch of kana) {
    const code = ch.codePointAt(0)!;
    out += code >= 0x3041 && code <= 0x3096 ? String.fromCodePoint(code + 0x60) : ch;
  }
  return out;
}

type MoraTok = { kana: string; pass: boolean };

/** Split a katakana string into moras: a small kana attaches to the previous
 * mora, ッ and ー are their own moras, and anything outside katakana/ー (with
 * the punctuation map excepted) passes through as its own token. */
function splitMoras(kana: string): MoraTok[] {
  const out: MoraTok[] = [];
  for (const ch of kana) {
    if (ch === 'ー' || ch === 'ッ') {
      out.push({ kana: ch, pass: false });
      continue;
    }
    if (SMALL_VOWEL_KANA.has(ch) && out.length > 0 && !out[out.length - 1]!.pass) {
      out[out.length - 1]!.kana += ch;
      continue;
    }
    if (ch in BASE) {
      out.push({ kana: ch, pass: false });
      continue;
    }
    if (ch in PUNCTUATION) {
      out.push({ kana: PUNCTUATION[ch]!, pass: true });
      continue;
    }
    out.push({ kana: ch, pass: true });
  }
  return out;
}

function romajiForDigraphFallback(mora: string): string {
  const small = mora[mora.length - 1]!;
  const first = mora.slice(0, mora.length - 1);
  const firstRomaji = BASE[first] ?? first;
  const vowel = BASE[small] ?? small;
  return firstRomaji.slice(0, -1) + vowel;
}

function baseRomaji(mora: string): string {
  if (mora.length === 1) return BASE[mora] ?? mora;
  if (DIGRAPH[mora]) return DIGRAPH[mora];
  return romajiForDigraphFallback(mora);
}

/**
 * hiragana or katakana in, modified Hepburn out. By default the input is read
 * as spelled kana (a dictionary reading, the stored kana line), where う after
 * an お-row mora lengthens the o. Pass `spoken` for VOICEVOX mora texts: the
 * engine already writes a long o as オオ, so a ウ it speaks is a real u
 * (オモウ is omou, not omō).
 */
export function kanaToRomaji(kana: string, opts: { spoken?: boolean } = {}): string {
  const katakana = toKatakana(kana);
  const moras = splitMoras(katakana);
  const romajis: string[] = new Array(moras.length).fill('');

  // First pass: base romaji for every mora except ー/ッ, which are resolved below.
  for (let i = 0; i < moras.length; i++) {
    const tok = moras[i]!;
    if (tok.pass || tok.kana === 'ー' || tok.kana === 'ッ') continue;
    romajis[i] = baseRomaji(tok.kana);
  }

  // Long vowel: bare vowel moras or ー that repeat the previous syllable's final vowel.
  for (let i = 0; i < moras.length; i++) {
    const tok = moras[i]!;
    if (tok.pass) continue;
    const prev = i > 0 ? moras[i - 1]! : null;
    if (!prev || prev.pass) continue;
    const prevRomaji = romajis[i - 1]!;
    if (!prevRomaji) continue;
    const prevVowel = prevRomaji[prevRomaji.length - 1]!;
    let thisVowel: string | null = null;
    if (tok.kana === 'ー') {
      thisVowel = prevVowel;
    } else if (!opts.spoken && tok.kana === 'ウ' && prevVowel === 'o') {
      // Standard kana spelling: う after an お-row mora lengthens the o
      // (がっこう, きょう). Spelled kana only, see above.
      thisVowel = 'o';
    } else if (tok.kana.length === 1 && VOWEL_OF[romajis[i] ?? ''] !== undefined) {
      thisVowel = romajis[i]!;
    }
    if (thisVowel === null || thisVowel !== prevVowel) continue;
    if (thisVowel === 'i') {
      romajis[i] = 'i';
    } else {
      romajis[i - 1] = prevRomaji.slice(0, -1) + MACRON[prevVowel];
      romajis[i] = '';
    }
  }

  // ン and ッ, resolved against the following mora's romaji.
  for (let i = 0; i < moras.length; i++) {
    const tok = moras[i]!;
    if (tok.pass) continue;
    if (tok.kana === 'ン') {
      const next = i + 1 < moras.length ? moras[i + 1]! : null;
      const nextRomaji = next && !next.pass ? romajis[i + 1] : next && next.pass ? next.kana : '';
      const startsVowelOrY = !!nextRomaji && /^[aiueoy]/.test(nextRomaji);
      romajis[i] = startsVowelOrY ? "n'" : 'n';
    } else if (tok.kana === 'ッ') {
      const next = i + 1 < moras.length ? moras[i + 1]! : null;
      const nextRomaji = next && !next.pass ? romajis[i + 1] : '';
      if (nextRomaji.startsWith('ch')) romajis[i] = 't';
      else if (nextRomaji && /^[bcdfghjklmnpqrstvwxyz]/.test(nextRomaji)) romajis[i] = nextRomaji[0]!;
      else romajis[i] = '';
    }
  }

  let out = '';
  for (let i = 0; i < moras.length; i++) {
    out += moras[i]!.pass ? moras[i]!.kana : romajis[i];
  }
  return out;
}

function trailingPunctuation(text: string): string {
  let out = '';
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i]!;
    if (!(ch in PUNCTUATION)) break;
    out = PUNCTUATION[ch]! + out;
  }
  return out;
}

/** One romaji chunk per word, grouped by which word span each timeline mora
 * falls in. Falls back to the stored romaji, or the kana converted, when
 * there is no timeline or the alignment fell back to one whole-line word. */
export function lineRomaji(line: {
  timeline: { text: string; start: number }[];
  words: { text: string; start: number; end: number }[];
  romaji: string;
  kana: string;
}): string {
  if (line.timeline.length === 0 || line.words.length <= 1) {
    if (line.romaji) return line.romaji;
    if (line.kana) {
      const r = kanaToRomaji(line.kana);
      return r ? r[0]!.toUpperCase() + r.slice(1) : '';
    }
    return '';
  }

  const chunks: string[][] = line.words.map(() => []);
  let cursor = 0;
  for (const mora of line.timeline) {
    while (cursor < line.words.length - 1 && mora.start >= line.words[cursor]!.end) cursor++;
    chunks[cursor]!.push(mora.text);
  }

  const parts: string[] = [];
  for (let i = 0; i < line.words.length; i++) {
    const romaji = kanaToRomaji(chunks[i]!.join(''), { spoken: true }) + trailingPunctuation(line.words[i]!.text);
    if (romaji) parts.push(romaji);
  }
  const out = parts.join(' ');
  return out ? out[0]!.toUpperCase() + out.slice(1) : '';
}
