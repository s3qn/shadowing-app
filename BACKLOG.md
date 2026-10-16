# Backlog

Living list of Sean's requests and ideas. Every idea Sean gives is logged here
immediately, before building, so nothing lives only in chat and dies at
compaction. This is the source of truth. BUGS.md holds confirmed bugs (ET-n);
FEATURES.md holds shipped and approved scope. This file is the idea-capture and
status layer on top of them.

Status: **todo** / **doing** / **done** (cite commit) / **parked** (give reason).
New entries go at the bottom with the next BL number.

## Doing


- **wave-dock · BL-31 · Compact floating dock + podcast shadow in place (2026-10-15, expanded 2026-10-16).**
  Worktree /home/sean/app-projects/shadowing-app-worktrees/compact-dock,
  uncommitted, awaiting Sean's accept. Original ask: "Shadow this line"
  (podcast/[id].tsx) opened another screen (island player); decided in place: the
  dock record button pauses the podcast, counts 3, records the line, plays you
  next to the original, play continues. Plus today's on-phone fixes: dock floats
  over the text; blue karaoke fill and glowing underline removed; video repeat
  loops at the line end; blind JP conceals text in video/podcast; YouTube CC kept
  off; Harmonizer cleanup (boxed lines, toast, fullscreen button, close pills).
  Not done until committed, merged, tsc passes and Sean accepts.

- **wave-dock · BUILT, awaiting Sean's phone accept (2026-10-16, Keeper-checked on disk in worktree compact-dock, all uncommitted, NOT done):**
  BL-33 repeat ring (tide/repeat-ring.tsx, R-A); BL-34 line rail (tide/line-rail.tsx, L-A);
  BL-35 tray polish (popover-bubble.tsx and sibling popovers, tick-ruler.tsx; confirm ruler drag on phone);
  BL-37 kinsoku (src/lib/kinsoku.ts); BL-38 (shownLine gate in use-video-highlight.ts, line 176).
  Gap: none of it committed or merged; tsc and phone check not recorded.
- **wave-1016 · BL-36 step 1 (backend/youtube.py onset pieces, test_youtube_word_onsets.py, 741 tests per report) and BL-39 (confirm-sheet.ts + confirm-sheet-host.tsx), staged, uncommitted, NOT done.**
  BL-36 gap: not deployed to prod, use-video-highlight hook side lives in wave-dock. BL-39 gap: island/[id].tsx still has 4 Alert.alert (wave-dock holds the file); settings, data and index already converted in the worktree.

## Todo (decided, not yet built)

- **BL-16 · Harmonizer round 2.** BUILT, reviewed clean, uncommitted in /home/sean/app-projects/shadowing-app-worktrees/bl16-harmonizer-2 (Keeper saw 9 changed files on disk). Awaiting Sean's accept. Not done until committed, merged, tsc passes.
- **BL-18 · ET-3 shadow-player UX redesign.** Plan refreshed at compact-dock/.claude/plans/player-ux-redesign.md (worktree compact-dock). Nothing built. Awaiting Sean's overall approval of the plan.
- **BL-20 · ET-4 Rive idle clip.** Still open (BUGS.md ET-4): fix lives in the .riv; untracked kageneko_v2/v3.riv may be the attempt, not wired in.
- **BL-36 step 2 · Offline forced alignment (Qwen3-ForcedAligner), phone uploads audio.** Plan at .claude/plans/bl36-step2-align.md (see also .claude/runs/sync-scientist.md). Nothing built. Awaiting TWO Sean decisions: (a) residential proxy vs a home fetcher, (b) 3GB vs int8 memory cap.
- **BL-41 · Review runs inside the normal player, as the shadowing LADDER (2026-10-16).** Sean: the review deck must not be its own screen. A saved sentence is reviewed inside the normal video/podcast player; sentences saved from one video form one review project; the end of an island hands off into it. Review runs the shadowing ladder, not Anki-style Again/Got it ("we're building a shadowing app, not Anki"). BL-41 supersedes the UI of BL-28 (BL-28 is done: its backend and standalone screen shipped in b5d5f9b). BUILT in wave-dock (compact-dock worktree): review.tsx chooser and src/hooks/use-ladder.ts present on disk, plus video/podcast review mode and the AutoEchoSheet review pill (pill and mode not individually re-read by the Keeper); Opus reviews and fixes applied per report. Uncommitted. Awaiting Sean's accept. Not done until committed, merged, tsc passes.
- **BL-40 · Five-way Pipe Declogger sweep, then fixers (2026-10-16).** Runs LAST,
  once every other decided backlog item is built. Sean: send 5 Pipe Decloggers,
  each over its own part of the code. They look for duplicate code, things that
  make the app slower, loops that need not exist and anything else that need not
  be there, and each suggests fixes and code-quality improvements. From their
  reports, dispatch fixers to fix what they found. Suggested split: (1) player
  screens island/video/podcast, (2) tide components + Skia/Reanimated scene,
  (3) hooks + src/lib (audio, highlight, api, caches), (4) the other screens and
  navigation (tabs, settings, wardrobe, leaderboard, profile, review),
  (5) backend/ (FastAPI, store, whisper, VOICEVOX, generators). Not started.

- **BL-17 · ET-1 Spanish highlight sync (moved out of Parked 2026-10-16).** BUILT in /home/sean/app-projects/shadowing-app-worktrees/et1-spanish-highlight (backend/kokoro_tts.py, latin.py, main.py, voices.py, new scripts/retime_kokoro_lines.py and tests/test_synthesize_lines.py; 13 changed files, uncommitted). Kokoro timed model present at ~/models/kokoro-timed. 746+ tests per report, reviewed and fixed (suite not re-run by the Keeper). Sequence: Sean accepts, commit and merge, deploy-prod.sh and check prod health release, then Sean's OK to run backend/scripts/retime_kokoro_lines.py --apply. BUGS.md ET-1 stays open until then.

## Parked (reason)
- **BL-6 / BL-7 / BL-8 · Drive Mode v1 polish** (phone test, native build,
  island picker). Needs a device and a new native build.
- **BL-15 · Visual tuning pass.** Needs on-device measurement.
- **BL-23-ext · Android Google Cloud OAuth steps.** On Sean (Chrome): SHA-1 →
  Android OAuth client → add testers as Google test users.

## At risk / housekeeping
- Phrase-catalog backend: RESOLVED, merged 55f6062, prod health release 55f6062 (checked 2026-10-15).
- Untracked assets at risk: kageneko_v2.riv, kageneko_v3.riv,
  cosmetics_preview.png, kageneko-example.png.
- Stale/dirty worktrees safe to delete (confirm before deleting):
  actionbar-redesign, tabs-redesign, tiles-redesign, header-redesign, and other
  dirty ones once their diffs are confirmed already-merged.

## Ideas captured (not scheduled)
- Leaderboard medallion pre-baked thumbnails (perf, D47).

## Done
- **BL-19 + BL-2 · Phrase catalog UI + search chips**, **BL-13 · Leaderboard spring**, **BL-25 · Stats + profile view**, **BL-28 · Saved-sentence review deck** (BL-41 supersedes its UI), **BL-5 · Resume position**, **BL-32 · YouTube play/pause/speed bridge**: b5d5f9b, wave-1015, on main. Keeper-verified 2026-10-16: git show --stat touches phrases/index.tsx, phrase_catalog.py, leaderboard-row.tsx, backend/stats.py, profile/[username].tsx, user_profile.py, review_deck.py, review.tsx, save-star.tsx, last-line.ts (resumeLine at line 63), youtube.ts (PLAYER_BRIDGE_SCRIPT at line 69), with tests test_stats_profile, test_review_deck, test_phrase_catalog; prod /shadow/health release b5d5f9b. BL-32 video play confirmed by Sean. Test run not repeated by the Keeper.
- **BL-4 · YouTube fullscreen via landscape**: b5d5f9b, on main. Keeper-verified 2026-10-16: commit touches video/[id].tsx and package.json; ScreenOrientation.lockAsync LANDSCAPE/PORTRAIT_UP present at video/[id].tsx:72, expo-screen-orientation in package.json. Not checkable: on-phone behaviour.
- **BL-29 · Menu icons** (SF Symbols with Material fallback on island menu rows), a767d12, on main. Keeper-verified 2026-10-15: commit touches sheet-rows.tsx (SymbolView, SheetIcon) and island-menu-sheet.tsx (icon= on its rows); the plan file .claude/plans/menu-icons.md is therefore stale.
- **BL-30 · BUGS.md hygiene** (ET-5 cat surface, ET-6 cat gaze moved to Closed): fd9b05b, 43dad2a. Verified 2026-10-15 in code (cat-stage.tsx ROCK_*, use-gaze.ts, lookX/lookY in kageneko-view.tsx).
- **BL-27 · Cinematic YouTube sync overhaul** (voice-synced karaoke, dock
  controls the video, calm swaps, captions off): e45a5cf. Opus review clean;
  LEAD_S device calibration still owed when Sean tests build 12. Keeper-verified 2026-10-15: commit touches video/[id].tsx, use-video-highlight.ts, ruby-word.tsx, youtube.ts; the Opus-review and device claims are not checkable from git.
- **BL-phrase-backend · Split phrase catalog + backend search**: 55f6062,
  deployed to prod. Verified 2026-10-15: prod /shadow/health release 55f6062, /phrases/search route in main.py, backend suite 703 passed.
- **BL-1 · YouTube cinematic player + per-word karaoke**: 83359ea (superseded by
  BL-27 tuning).
- **BL-14 · Prominent @username on Home badge**: 6e1c6d9.
- **BL-22 · Security exploit hunt (coin/XP) + fix + prod deploy**: 03ed10b.
- **BL-23 · Android beta infra (package, adaptive icon, Google-only sign-in) +
  APK**: 16b7f3a.
- **BL-26 · Deferred level-up pop-up**: 700c39e.
- **BL-perf · Practice route / Rive focus gate / cheaper karaoke**: 29c4239.
- **BL-lb · Leaderboard shows the viewer at their real rank**: 8f9263a.
- **BL-social (earlier) · Leaderboard with 0-XP users, visual fixes, default
  speed = 1.0.**
