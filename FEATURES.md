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
- Ring player: one big circular Play/Stop whose ring fills as the line plays
  (animated on the UI thread) and drains through the 2s breath with a
  countdown inside; Repeat Off / Line / Island (island plays every line in
  order with a breath between them and starts over); speed as a quiet slider.
  Line switches and speed changes keep playing; a finish is handled once.
- Cancel on the record screen: leave without recording or building, Discard
  on the review screen, and Close once an island is already building.
- Island housekeeping: long press an island in the list to delete it, after
  a confirmation. A Regenerate link in the player rebuilds the island at the
  other complexity from the stored recording, shows the build stage while it
  runs, and starts over at line 1 when it lands.
- Shadow takes: Record my take plays the line and records you speaking along,
  stops itself a second after the line ends, and keeps one take per line on the
  phone. Compare plays the original then your take; My take plays yours alone.
  Takes go with the island when it is deleted or regenerated.
- Take bleed removed: a take recorded on the speaker has the line itself in it.
  Calibrate speaker records the line once with you silent, learning the path
  from the phone's speaker to its own microphone; every take after that has the
  line subtracted and only your voice left. A take through headphones has no
  bleed to remove, and is detected and kept exactly as recorded.
- Blind mode and lag: a Blind pill hides the Japanese, the reading and the
  English so you shadow by ear, with a Tap to peek placeholder that shows the
  text for the current line only. A Lag setting (Off, 0.3s, 0.5s, 1s) lengthens
  the Record my take tail and the loop breath by that much, so speaking a beat
  behind the voice is not cut off or talked over. Both are remembered on the
  phone. The highlight and Compare are not shifted.

## Next (approved, in order)

1. Background audio and lock-screen controls (expo-audio supports it; needs
   `UIBackgroundModes` in app.json).
2. Furigana above kanji (ruby layout) instead of a separate reading line.

## Ideas (not approved)

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
- Pitch-accent marks over the reading, from VOICEVOX's accent phrases (the data
  is already in the timeline).
- Romaji toggle in the player.
- Phrase loop: tap a start word and an end word to loop only that span of a
  line, using the word timings the highlight already has.
- Spaced repetition: resurface islands on a schedule.
- Export an island as one audio file.
- Operations: autostart VOICEVOX, backend, cloudflared and the dashboard on
  boot (systemd user units); Cloudflare Access in front of dev.sean.build.
