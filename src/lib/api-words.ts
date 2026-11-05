// Api domain: words.
import { BASE, fetch } from '@/lib/api-http';
import { headers, json } from '@/lib/api-core';
import type { Language, NativeLanguage, PosGroup } from '@/lib/api-types';
import { refreshEnergyAfterAi } from '@/lib/energy';

export type GlossSense = { pos: string[]; glosses: string[] };
export type GlossEntry = { kanji: string[]; kana: string[]; senses: GlossSense[] };
export type Gloss = { word: string; base: string; reading: string; entries: GlossEntry[]; found: boolean };

const glossCache = new Map<string, Gloss>();

export async function gloss(word: string): Promise<Gloss> {
  const hit = glossCache.get(word);
  if (hit) return hit;
  const out = await json<Gloss>(
    await fetch(`${BASE}/gloss?word=${encodeURIComponent(word)}`, { headers: headers() }),
  );
  glossCache.set(word, out);
  return out;
}

/** Every word's meanings for one island in a single request, for the offline
 * download. Returns {} on any failure (an older backend has no such route), so
 * a download still completes without meanings. */
export async function offlineGlosses(id: string): Promise<Record<string, Gloss>> {
  try {
    const res = await fetch(`${BASE}/islands/${id}/glosses`, { headers: headers() });
    if (!res.ok) return {};
    return (await res.json()) as Record<string, Gloss>;
  } catch {
    return {};
  }
}

/** How a word functions in the particular sentence it was tapped in. Cached
 * server side, keyed on (word, sentence). Empty string means the backend
 * tried and had nothing to say, not a failure the caller needs to surface. */
export async function explainWord(
  word: string,
  sentenceJa: string,
  sentenceEn: string,
  language: Language = 'ja',
  native: NativeLanguage = 'en',
): Promise<string> {
  const q = `word=${encodeURIComponent(word)}&sentence_ja=${encodeURIComponent(sentenceJa)}&sentence_en=${encodeURIComponent(sentenceEn)}&language=${encodeURIComponent(language)}&native=${encodeURIComponent(native)}`;
  try {
    const out = await json<{ context: string }>(await fetch(`${BASE}/explain-word?${q}`, { headers: headers() }));
    return out.context;
  } finally {
    refreshEnergyAfterAi();
  }
}

/** One turn of the Explain chat thread. */
export type ChatTurn = { role: 'user' | 'assistant'; text: string };

/** One vocabulary item in a structured Explain answer. `pos` uses the same
 * groups as the part-of-speech underline (see `PosGroup`), so a vocab row's
 * colour bar can match the word's underline in the sentence above it. */
export type ExplainVocabItem = { word: string; reading: string; meaning: string; pos: PosGroup };

/** One grammar point in a structured Explain answer. `span`, when present, is
 * the exact substring of the sentence being explained where the pattern
 * appears, validated server side to actually be a substring: safe to search
 * for verbatim to highlight it in place. */
export type ExplainGrammarItem = { pattern: string; explanation: string; span?: string };

/** A structured Explain answer. Any of the three sections may be missing:
 * the backend omits a section entirely rather than send it empty. */
export type ExplainAnswer = {
  vocab?: ExplainVocabItem[];
  grammar?: ExplainGrammarItem[];
  summary?: string;
};

/** Ask one question about a sentence, optionally about `marked` words within
 * it, with the thread so far for context. The thread itself lives in client
 * state; nothing here is persisted server side. */
export async function explainChat(body: {
  sentenceJa: string;
  sentenceEn: string;
  marked: string[];
  question: string;
  history: ChatTurn[];
  language?: Language;
  native?: NativeLanguage;
}): Promise<ExplainAnswer> {
  try {
    return await explainChatRaw(body);
  } finally {
    refreshEnergyAfterAi();
  }
}

async function explainChatRaw(body: Parameters<typeof explainChat>[0]): Promise<ExplainAnswer> {
  return json<ExplainAnswer>(
    await fetch(`${BASE}/explain-chat`, {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sentence_ja: body.sentenceJa,
        sentence_en: body.sentenceEn,
        marked: body.marked,
        question: body.question,
        history: body.history,
        language: body.language ?? 'ja',
        native: body.native ?? 'en',
      }),
    }),
  );
}
