# Features

The single list of what the shadowing app does, what is next, and what is only
an idea. Sean decides what moves between sections; Claude keeps it current.
Read and update through the `features` skill.

Statuses: **done** (merged to main), **next** (approved, in Sean's order),
**idea** (pitched, not yet approved; may be good or bad, he decides).

## Done

- Language islands: record 30–90s in English, transcribe (faster-whisper),
  write Japanese lines (claude CLI, simple or complex), voice them (VOICEVOX),
  shadow player with pitch-corrected speed, loop, per-mora highlighting.
- Live microphone level meter on the record screen (real readings, noise-gated)
  plus a seconds progress track.
- Voice picker in Settings: every VOICEVOX speaker and style with icons, same
  preview sentence in any voice, choice persisted; Re-voice link in the player
  for islands made with another voice.
- Continuous playback speed slider in the player, 0.5x to 1.5x in 0.05 steps,
  pitch-corrected, replacing the four preset buttons.
- Word-level highlighting: the Japanese sentence is split into words (janome,
  particles separate) and each word lights up over its own span of the audio;
  the reading line stays static. Smooth at any speed via interpolated position.
  Alignment anchors each word to the moras VOICEVOX actually spoke, so digits,
  names and counters land correctly.
- Natural slow playback: the slider speed is rendered by VOICEVOX itself
  (speedScale, cached per line and speed) instead of stretching the audio on
  the phone, so 0.5x sounds like slow speech rather than a chopped recording.
- Tap a word: a Yomitan-style popover under the word with reading, base form
  and JMdict meanings (offline; particles get a grammar note). The word plays
  once on open as its own VOICEVOX render, Hear again repeats it; the line's
  player and highlight are never touched.
- Player rules: Play always starts the sentence from the top; the highlight
  shows only while the line is playing; Loop leaves a 2s breath with an
  "again in" countdown and the button reads Stop while a loop runs.
- Robustness: interrupted islands are healed on backend startup, revoice
  replaces lines one by one, gateway errors read as a short message with
  Retry, and an island without lines offers Regenerate.
- Record in Hebrew or English: whisper detects the language of the take, and
  the Japanese generator is told which it was. No setting to touch.

## Next (approved, in order)

1. Ring player: one big circular Play/Stop with a progress ring that fills as
   the line plays and drains through the 2s breath; Repeat modes Off / Line /
   Island (island mode plays every line in order with the breath between them
   and starts over); speed and repeat as quiet pills below.

## Ideas (not approved)

- Cancel button on the record screen: a way to leave without recording or
  building (today the screen has no exit once opened).
- Import files as islands: an anime episode (video or audio) plus its SRT
  subtitle file; the subtitle lines become the island's lines with their own
  timings, and the word highlighting runs on top.
- Shadow a YouTube video: paste a link, the audio is transcribed to Japanese
  automatically (whisper), and you shadow it with the words highlighted while
  the video plays. Timings would come from whisper's word timestamps rather
  than VOICEVOX, so the aligner needs a second input path (shared with the
  SRT import).
- Import existing audio or text as an island (was part of the original pitch:
  "generate good AI vocals or import existing content").
- Regenerate an island at the other complexity from the player (backend route
  exists: `POST /shadow/islands/{id}/regenerate`).
- Delete an island from the list (swipe or long press); backend route exists.
- Record yourself shadowing a line and play it back against the original.
- Pitch-accent marks over the reading, from VOICEVOX's accent phrases (the data
  is already in the timeline).
- Furigana above kanji (ruby layout) instead of a separate reading line.
- Romaji toggle in the player.
- Background audio and lock-screen controls (expo-audio supports it; needs
  `UIBackgroundModes` in app.json).
- Spaced repetition: resurface islands on a schedule.
- Export an island as one audio file.
- Operations: autostart VOICEVOX, backend, cloudflared and the dashboard on
  boot (systemd user units); Cloudflare Access in front of dev.sean.build.
