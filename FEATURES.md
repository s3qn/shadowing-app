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
  English so you shadow by ear, and a finger drag over the blurred sentence or
  English reveals only the words under it. A Lag setting (Off, 0.3s, 0.5s, 1s) lengthens
  the Record my take tail and the loop breath by that much, so speaking a beat
  behind the voice is not cut off or talked over. Both are remembered on the
  phone. The highlight and Compare are not shifted.
- Background audio: the island player keeps playing with the screen locked or
  the app in the background (Expo Go, iOS and Android). Other apps' audio
  dips under a line and comes back. The breath between repeats is silence
  appended by the backend, so loops and Repeat Island survive a locked phone.
  A take or recording stops on background. Lock-screen metadata is set, but
  with ducking iOS keeps the music app's card, and Android needs a dev build.
- Phrase loop: long press a word and drag across the sentence to select whole
  words, then tap Repeat in the popup. The backend cuts that span from the
  line's audio, so the loop, breath, Lag, takes and a locked phone all work on
  the phrase; Whole line goes back. A quick tap still opens the word popover.
- Export an island: one tap shares an m4a of the island at the slider speed,
  each line twice with the breath after it, through the phone's share sheet.
  Built with ffmpeg on the backend and cached until a re-voice or regenerate.
- Reading display: furigana above kanji (checked against the spoken moras),
  an OJAD-style pitch-accent strip from VOICEVOX accent phrases, and a romaji
  mode, in one Reading pill row remembered on the phone. Older islands get
  ruby and accent filled in when opened.
- Hide English: a Hide EN pill in the player hides only the English line,
  remembered on the phone. With Blind on, Tap to peek shows the Japanese and
  keeps the English hidden.
- Rename an island: tap its title on the list or in the player. Re-voice keeps
  the new title; Regenerate writes a fresh one.
- Practice stats and sorting: the home screen shows minutes shadowed today and
  a streak (a day counts from 60s of line playback, measured from the player
  itself, takes excluded), with title search and a Newest / Least practiced sort.
- Take score: after Record my take, words that ran early, late or dropped get
  coloured underlines, measured against the take's own median delay, with a
  Behind the voice summary line.
- Tide fonts and palette: Noto Serif JP, Noto Serif and Space Grotesk load
  before the splash hides; theme.ts has the Tide palette.
- Tide home screen: dark sky over water, each island a band filled from the
  left by practice time (20 minutes fills it), with search, sort, rename,
  delete, the practice card and a round record button restyled.
- App icon: the cat artwork, with a navy background on Android and the splash
  (visible in a real build, not Expo Go).
- Tide player scene: the sentence on a waterline with a word-by-word
  reflection, tide marks for position in the island, a large countdown
  between repeats, round previous, play, next and record buttons, and flick
  up or down to change or replay the line.
- Press feedback: round buttons spring and give a light haptic tap when
  pressed.
- Toolbar sheets: Speed, Repeat, Reading, Blind and Lag each open a small
  bottom sheet; the Island menu (rename, export, re-voice, regenerate,
  calibrate, delete) is a sheet too
- Take row and word panel restyled to Tide, with early, late and dropped
  counts coloured
- Part-of-speech underline under each word, with small romaji below in
  Furigana mode
- Scrolling transcript on the waterline with auto-scroll, and a moving
  outline on the active word
- Auto Echo: Listen, Echo, Speak and Play as one loop in a sheet
- Player dock of tiles with accent highlight, Repeat cycle defaulting to
  Island, tidy sheets
- One control per function: take row and quick chips removed, record button
  opens Auto Echo; with headphones the line plays under your voice during Speak, on the speaker Speak is silent
- Explain: word meaning in context and one-tap phrase explanations
- Record page in the Tide look
- Pill tab bar and system fonts
- Repeat popover: the island always plays on line after line and wraps until
  paused. The Repeat tile opens two tick rulers that snap with a haptic per
  step: Times (Off, at most 5× per line) and Pause (0–10s in 0.5s steps after
  every play, with the countdown). Decision: Lag and the loop breath were the
  same thing, so Pause replaces both and the Lag tile is gone; Auto Echo's
  Echo step uses the same Pause, and a take's tail grows by it up to 1s. The
  old Off, Line and Island modes are gone; a phrase from the selection popup
  still loops until cleared.
- Delight wave: sky by time of day, pittari sparkle, voice ripples, selection
  handles, Skia water with tilt, frost, Repeat rulers, settings pages, home
  polish
- Smooth player: line and take audio reused and cached locally, line changes
  start in about 100ms, rippling play button with instant stop
- Reading Off option; Speed and Reading tiles glow only when not default
- Long islands play smoothly: the transcript mounts only the rows near the
  active line on islands over 120 lines.
- Opening an island has no dead frame: content staggers in as the card lands,
  the Cat Constellation loader covers slow loads, island data is cached.
- Island wheel with lanterns: Home snaps one card to the middle; its lanterns
  (one per line, coloured by the latest take) light once the wheel rests, the
  weakest flickers; pressing a card gives a haptic and side cards flash.
- Smoother player and Home: recording no longer re-renders the player, React
  Compiler compiles most of Home and the player parts, lighter lanterns and
  search, water shader compiled once, transcript windowed from 30 lines.
- Island menu icons: SF Symbols on each row (Material icons on Android).
- Re-voice stays on the player with the Cat Constellation and Re-voicing
  until the new voice lands, on the same line, with no old clips.
- SF Symbols on every sheet, popover and Settings row.
- Slide to reveal: in Blind and Hide EN a finger drag sharpens only the words
  under it.
- Simultaneous Speak: with headphones the line plays under your voice in Auto
  Echo; Times capped at 5.
- Kept up with X of Y words after a take and on the centred Home card.
- Suggest a feature in Settings, stored on the backend with an optional
  Discord webhook.
- Streak counts shadowing passes (10 a day); older days keep the 60 second
  rule.
- Backend: island language, import from audio and SRT with English lines,
  podcasts from RSS, due-today scheduling, per-mora length and pitch analysis
  on takes.
- Podcast tab: hand-picked Japanese shows in three sections with level tags,
  search by name or Apple Podcasts link, tap an episode to build an island.
- Due today on Home: a count on the practice card and an amber mark on due
  islands; never practised islands count as due.
- Mora length and pitch feedback after a take, on the sentence card and in
  the Auto Echo sheet.

## Next (approved, in order)

(empty: pick from Ideas)

## Ideas (not approved)

- Onboarding: a few first-run screens that say what each practice step is
  for, and ask for the learning and understood languages.
- A speed ladder that climbs: each island moves up from 0.5x toward 1.0x at
  90% or more kept-up words and drops back below 85%; the manual slider stays.
- A session ladder per island: five guided passes (listen blind, mumble, read
  in sync, record blind, compare).
- Before and after: replay your first take on an island next to your latest
  (first takes need to be kept from now on).
- Anime player: import your own anime episode (video or audio) plus its SRT
  subtitle file; the app plays the video with the subtitles moving along with
  it, the subtitle lines become the island's lines with their own timings, and
  the shadowing tools and word highlighting run on top.
- Shadow a YouTube video: paste a link, it opens the video with subtitles, the
  audio is transcribed to Japanese automatically (whisper), and every
  shadowing feature of the app works on it with the words highlighted while
  the video plays. Timings would come from whisper's word timestamps rather
  than VOICEVOX, so the aligner needs a second input path (shared with the
  SRT import).
- Import existing audio or text as an island (was part of the original pitch:
  "generate good AI vocals or import existing content"), including podcasts
  as a source.
- MVP release: accounts with Supabase, sign in with Google and Apple.
- Languages for the first public version: learn Japanese, Spanish or English,
  and pick the language you already understand (Hebrew or English) for the
  app's text, translations and explanations. English is a learning language so
  Israeli friends can learn it with Hebrew as their language; Hebrew is not a
  learning language for now. VOICEVOX only speaks Japanese, so the other
  languages need another voice engine; the word timing and mora logic is
  Japanese-specific today; Hebrew needs right-to-left layout. Onboarding asks
  for both languages, and a Languages screen in Settings changes either at any
  time; switching the understood language between Hebrew and English flips
  the layout direction, so the app restarts itself. Each island stores its own
  learning language, so switching never breaks or deletes islands. Sean's
  idea: islands in other learning languages are hidden by default (learning
  Japanese hides the Spanish islands), with a toggle in Settings (Languages)
  to show them all mixed together. They are only hidden, never deleted.
- Onboarding: a short, good onboarding that explains what shadowing is and
  teaches the user how to get the most out of the app.
- Music: learn from songs (a friend's request). Integrate Apple Music or
  Spotify, or look up lyrics online, so a song becomes something to shadow.
  Needs a check of what those services and lyrics licensing allow.
- Suggest a feature: a Settings entry where users send feature ideas,
  delivered to Telegram, Discord or inside the app (pick the common practice
  when it is built).
- Cat animation in Rive: Sean is learning Rive to make a proper animated cat;
  the app keeps the current cat until then.
- Shadowing revamp: rebuild the shadowing flow (Auto Echo and the shadowing
  button) around the research in designs/13-shadowing-research.md:
  simultaneous Speak with headphones, a step ladder per island (listen blind,
  mumble, with text, blind and recorded, compare), at most 5 passes per
  sitting, a speed ladder that climbs on 90 to 95% kept-up words, "kept up
  with X of Y" as the progress number, and duration and pitch feedback on
  takes.
- Spaced repetition: resurface islands on a schedule. Auto practice builds on
  it: one button that goes through every island due today, one after another,
  and has you shadow each one.
- Operations: autostart VOICEVOX, backend, cloudflared and the dashboard on
  boot (systemd user units); Cloudflare Access in front of dev.sean.build.
- Building island look on Home: an island that is still being built
  (transcribing, writing Japanese, recording the voice) needs a new look. The
  current diagonal light sweep with the small cat is awful. Options to pick
  from later: the lantern row lights one lantern per stage with the stage
  label and 3 pulsing dots; three stage steps (Transcribe, Write, Voice) with
  the current one pulsing; the Cat Constellation drawn larger on the card
  with stars appearing per stage; or a quiet shimmer on the title with the
  stage label.
- Slide to reveal, for both the Japanese and the English line (Sean loved it).
  Based on the slide-to-reveal demo
  (https://github.com/enzomanuelmangano/demos/tree/main/src/animations/slide-to-reveal):
  a Skia blur mask that follows the finger, gesture handler, the characters
  under the finger come into focus and grow slightly, everything blurs again
  on release. Japanese: in Blind mode the sentence stays on screen blurred
  instead of the Tap to peek placeholder, and sliding a finger shows only the
  words under it. English: with Hide EN the translation stays blurred, and
  sliding shows the meaning of just that part of the line (fits the research's
  meaning pass last step). Our sentence is regular text with furigana and
  part-of-speech underlines, not Skia text, so it likely needs a blur and mask
  layer over it (the app already has a Frost blur component).
- SF Symbols in every sheet: the island menu already has icons (SheetAction's
  optional `icon`, SF Symbols with Material fallbacks on Android). Go through
  every other bottom sheet and modal (Speed, Repeat, Reading, Blind, Lag, Auto
  Echo, Explain, Home's rename and delete sheet, the settings screens' rows)
  and add a fitting SF Symbol wherever a row or option has none, with the same
  size, weight and tint rules.
- Micro-animations around the app: small, quick animations on the UI thread in
  more places, from a research list to be picked from.
