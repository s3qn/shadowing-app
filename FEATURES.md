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

## Next (approved, in order)

1. Tap a word to replay just that word (seek to its span, pause at its end).
2. Loop the whole island: a loop mode that plays every line in sequence and
   starts over, to drill several sentences together instead of one.
3. Per-word dictionary gloss: tap and hold a word to see its meaning
   (needs a dictionary such as JMdict on the backend, plus janome base forms).

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
