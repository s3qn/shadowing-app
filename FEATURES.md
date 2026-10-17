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
  a streak (a day counts from 10 passes, a line played through or a take saved,
  or from one finished sentence ladder; days logged before those counters
  existed still count from 60s of line playback), with title search and a
  Newest / Least practiced sort.
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
- Prism Edge buttons across the app: verb colours, glass pill trays for the
  tab bar and sort control, drag between tabs, Tide Drop on big buttons, icon
  buttons for Retry, Regenerate, Refresh, Discard and Whole line.
- App renamed to Echo Tail: bundle id build.sean.echotail, scheme echotail.
- Onboarding: welcome, choose learning and understood languages, request
  microphone permission, five guided passes (listen, mumble, read along,
  shadow, compare) with one animated body part per pass, ready screen.
- Language picker: searchable catalogue of fifteen languages for onboarding and
  Settings > Language, unavailable languages shown but disabled.
- Spanish and English as learning languages: use Kokoro for voice and whisper
  for word timings; Japanese keeps VOICEVOX and mora timings. Islands carry
  their own learning language, Home filters by it.
- Islands scoped per device: each island is specific to the device that created
  it, with a daily build limit.
- Production backend: own port and data directory with deploy script and
  systemd unit.
- Hebrew interface: the whole app in Hebrew when that is the language you
  understand, with its own setting, and right-to-left alignment.
- Speed ladder: each island climbs from 0.5x toward 1.0x on kept-up words; the
  manual slider stays and wins a race with a scored take.
- Session ladder: the five guided passes run in the player, with help for the
  pass you are on and a count before the microphone opens.
- First take kept: the first take of every line is stored for a later before
  and after comparison.
- Operations: systemd user units for VOICEVOX, the prod backend, cloudflared
  and the dashboard (written; installing them is Sean's step).
- Schedule: an island moves up the schedule at most once a day.
- Practice sheet rebuilt to its chosen design; a building island on Home
  lights its constellation stage by stage.
- Sign-in with Apple and Google (Supabase), required, with sign out and
  delete account
- Home page and privacy policy at shadow.sean.build/shadow/ and
  /shadow/privacy
- Spanish highlight timing fix (ET-1): exact stretch and pause-snapped word
  timings
- Practice today: run every due island in a row
- Before and after: first take against the latest
- Phrase islands: ready topics through the + sheet
- Import an audio or srt file as an island
- Offline islands: download an island for no network
- Glass popovers + speed ruler verb colour
- Auto Echo Prism buttons (ring + glyph fixes)
- Tide toggle replaces native Switch
- Glass input + Prism CTAs, suggest cat loader
- Unique @username with a required launch gate
- New XP sources + a 120/day cap (milestones exempt)
- Cat leaderboard by level with dressed-cat rows
- Drive Mode: hands-free island radio for the car
- Scene depth pass (backlight, vignette, reflection)
- Home cat badge redesign
- Leaderboard spotlight band fits its content
- Leaderboard shows every named user, even at 0 XP
- Android internal-beta support (package, icon, Google-only sign-in)
- Cinematic YouTube player + per-word karaoke
- Security: closed coin/XP farming exploits
- Prominent @username on the Home badge
- Perf: practice route, Rive focus-gate, karaoke early-out
- Deferred level-up celebration pop-up
- Cinematic YouTube player: voice-synced per-word karaoke (predicted clock +
  soft slew), dock controls the video directly, calmer line swaps, captions
  off
- Auto practice: one button goes through every island due today, one after
  another, and has you shadow each one (8d0c1d8)
- Accounts with Supabase: sign in with Google and Apple, required (ba0301b)
- Phrase catalog with preset situation chips and categories (BL-19, BL-2)
- Saved-sentence review deck with SRS, original audio for podcasts (BL-28)
- Profile and stats from the leaderboard, OG serial, watch and listen time
  (BL-25)
- Leaderboard rows rise with a spring (BL-13)
- Resume where you left off in islands, podcasts and videos (BL-5)
- YouTube fullscreen in landscape (BL-4)
- YouTube play, pause and speed reach the player (BL-32)
- BL-31 compact floating dock + podcast shadow in place
- BL-33 repeat ring
- BL-34 line rail
- BL-35 tray family with drag rulers
- BL-37/38 kinsoku rows, no stale highlight
- BL-41 review inside the players on the ladder
- BL-36 step 1 YouTube word onsets
- BL-39 own confirm sheet
- BL-17 ET-1 Spanish Kokoro timings
- BL-16 Harmonizer round 2
- Default speed 1.0 on islands
- BL-42 voice topic phrases (P-A screen, topic mode in Record, Tatoeba corpus)
- BL-18 practice run in the dock (pass strip, count-in, sheet trimmed)
- BL-36 step 2 offline forced alignment
- BL-39 own confirm sheets on island
- BL-40 declog sweep
- ET-7 landscape sheet crash
- BL-50 Beta Tester Hat
- BL-43 grammar islands
- BL-46 podcast shadow in place
- BL-45 subtitle quality pipeline phase 1
- BL-47 animations A1 A7 A10
- Dev review tour
- BL-51 staged ladder
- BL-51 take score
- BL-51 Practice now sessions
- BL-51 daily Review XP and session summary
- Hebrew and RTL pass (The Translator)
- New app icon F01

## Next (approved, in order)

- TestFlight: deploy the production backend, route shadow.sean.build, EAS
  build and submit, friends and family testing group.
  Not verified: deploy-prod.sh (7838e2b), the systemd unit (3376f8a) and the
  eas.json submit profile (ba5a0a5) exist. Missing: no prod deploy, EAS build,
  TestFlight submission or testing group is recorded in git or the repo, so
  they need a check on the live host and in App Store Connect.

## Ideas (not approved)

- Before and after: a screen that plays your first take on a line next to
  your latest (first takes are already kept).
- Offline islands: download an island in full so it can be practised with no
  network, on a plane or a train.
- Anime player: import an episode (video or audio) plus its SRT; the subtitle
  lines become the island's lines with their own timings.
- Shadow a YouTube video: paste a link, transcribe with whisper, word timings
  from whisper instead of VOICEVOX (shares the SRT import path).
- Import existing audio or text as an island.
- Music: learn from songs through Apple Music, Spotify or online lyrics.
  Needs a check of what licensing allows.
- Cat animation in Rive: the app keeps the current cat until then.
- Micro-animations around the app, from a research list to be picked from.
