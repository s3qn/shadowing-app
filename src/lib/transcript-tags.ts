/** The fault tags for the dev transcript review. The server holds the same
 * enum (backend/dev_transcripts.py): keep the two lists in step. */
export type TagGroup = 'Text' | 'Timing' | 'Structure';

export type TranscriptTag = { key: string; label: string; group: TagGroup; needsWords?: boolean };

export const TRANSCRIPT_TAGS: TranscriptTag[] = [
  { key: 'correct', label: 'Correct', group: 'Text' },
  { key: 'wrong_word', label: 'Wrong word', group: 'Text' },
  { key: 'missing_words', label: 'Missing words', group: 'Text' },
  { key: 'extra_words', label: 'Extra words', group: 'Text' },
  { key: 'name_kanji_wrong', label: 'Name kanji', group: 'Text' },
  { key: 'filler_shown', label: 'Filler shown', group: 'Text' },
  { key: 'starts_early', label: 'Starts early', group: 'Timing' },
  { key: 'starts_late', label: 'Starts late', group: 'Timing' },
  { key: 'word_offset', label: 'Word offset', group: 'Timing', needsWords: true },
  { key: 'too_fast', label: 'Too fast', group: 'Timing' },
  { key: 'too_slow', label: 'Too slow', group: 'Timing' },
  { key: 'lag_vs_audio', label: 'Lag vs audio', group: 'Timing' },
  { key: 'bad_split', label: 'Bad split', group: 'Structure' },
  { key: 'lines_merged', label: 'Lines merged', group: 'Structure' },
  { key: 'repeat_loop', label: 'Repeat loop', group: 'Structure' },
  { key: 'backchannel_shown', label: 'Backchannel', group: 'Structure' },
  { key: 'double_caption', label: 'Double caption', group: 'Structure' },
];

export const TAG_GROUPS: TagGroup[] = ['Text', 'Timing', 'Structure'];
