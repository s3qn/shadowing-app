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

## Next (approved, in order)

1. Word-level highlighting: highlight whole words as spoken instead of single
   kana, so word boundaries are clear.

## Ideas (not approved)

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
