# Backlog

Living list of Sean's requests and ideas. Every idea Sean gives is logged here
immediately, before building, so nothing lives only in chat and dies at
compaction. This is the source of truth. BUGS.md holds confirmed bugs (ET-n);
FEATURES.md holds shipped and approved scope. This file is the idea-capture and
status layer on top of them.

Status: **todo** / **doing** / **done** (cite commit) / **parked** (give reason).
New entries go at the bottom with the next BL number.

## Doing

- (none). Everything built is on main; see the next section for what waits on prod.

## Merged, waiting on Sean's prod deploy (prod still on b5d5f9b, checked 2026-10-17)
- **BL-36 step 1 + step 2 · YouTube word onsets and offline forced alignment**: step 1 4e53e09, step 2 93f251e (backend/align.py, align_worker.py, test_align.py, video-audio route, src/lib/video-audio.ts). Needs prod: requirements-align.txt, the capped systemd align unit, deploy-prod.sh. Sean's phone test of the upload path still owed.
- **BL-17 (ET-1) Spanish highlight sync, BL-42 phrases by voice topic**: 4e53e09 / 94cdb56. Needs deploy, then Sean's OK for retime_kokoro_lines.py --apply (dry run first); copy ~/shadowing-data/tatoeba.db to ~/shadow-prod/data/. ET-1 stays open until then.
- **BL-43 · Grammar islands (Tasks 1-3)**: d676a94 (backend/grammar.py, build_grammar.py, test_grammar*.py, phrases/index.tsx swipe deck with the GR2-A3 level rail). Needs prod: the grammar.db file and route. Not checked: phone accept, grammar.db present on prod.
- **BL-45 · Subtitle quality phase 1**: d676a94 (backend/youtube.py, test_subtitle_quality.py). Server side, needs prod deploy. Phase 2 (Demucs, Whisper large-v3) stays out of scope.
- **BL-50 · Beta Tester Hat**: 93f251e (cosmetics_catalog.json, progression.py _grant_beta, asset, wardrobe tag). Needs prod: SHADOW_BETA_GRANT=1 in ~/shadow-prod/env, then deploy-prod.sh.

## Todo (decided, not yet built)
- **BL-51 · Ladder, sessions and daily Review (2026-10-17, Sean's spec from the Dead Sea talk).** Full spec, his words and the open questions in .claude/plans/bl51-ladder-session-spec.md. F1 text always visible; F2 every stage prepares you, very visual, slower by default plus a speed setting; F3 hear, memorise, say a few times; F4 accuracy score 0 to 100 per take (whisper content + existing take_score timing), tracked per session; F5 Practice now merges with Saved sentences and starts a session sized by sentence count; F6 track planned vs actual session time and learn from it; F7 session = bundle of projects, weakest or most important lines first; F8 daily Review is the main button and the biggest XP source. Sean may add more; WAIT for his answers before planning.

- **BL-20 · ET-4 Rive idle clip.** Still open (BUGS.md ET-4): fix lives in the .riv; untracked kageneko_v2/v3.riv may be the attempt, not wired in.

- **BL-49 · Intro trailer with Kageneko talking (2026-10-16, Sean, before sleep).** Like the Clash of Clans tutorial villager: Kageneko talks to you through speech bubbles, using AI-generated emotion images of Kageneko. Sean: "think out of the box on how to generate good pictures and connect you with a picture model generator, I don't like how you draw stuff, it's horrifying". Use his 8-lens creativity brief (question the question, assumptions, invert, steal from far away, scale, constraints, perspective, combine). Image source: the OpenAI image model ("chatgpt generated") with reference edits from assets/kageneko-base.png, so it stays on-model. Never hand-drawn. Must fit the approved onboarding (designs/echo-tail-flow.html) and the reuse rule. Tonight: an ideas report, an emotion sheet, and an HTML trailer mock for Sean's pick. 2026-10-17: Sean wants a different direction than the three pitched, and will come back to it. Image chain researched (.claude/runs/image-gen-options.md): Cloudflare Workers AI flux-2-klein-4b drafts (free 10k neurons a day, about 80 images), a local on-model check, then Gemini Nano Banana keepers at about $0.034 each (about $2-4.50 a month for 100 finals). A script, not an MCP, so images stay out of context. Waiting on Sean to create keys in ~/.config/kageneko/env. UPDATE 2026-10-17 (Sean's plan): the trailer comes from a real first-time user. Sean teaches a friend who has never used the app, notes what made it click, and the trailer explains the app through the app itself. Guide for the session: .claude/runs/bl49-friend-session.md. After it: transcribe the recording/notes, rank the stuck points (app fixes go to the backlog), write the trailer script as Kageneko speech-bubble scenes in the order the friend learned, and build it as an in-app guided tour on top of the review-tour pill mechanism (compare with the existing onboarding, designs/echo-tail-flow.html). WAITING on Sean's friend session.

## Parked (reason)
- **BL-48 · Search YouTube inside the app (2026-10-16, Sean asked "what about youtube searches?").** Today video/add.tsx only has a Paste button (a link copied from YouTube). Idea: search by topic or voice, reusing the podcast tab's search screen and the Record topic mic. Show only Japanese videos that have captions, preferring manual ones (better text, see BL-45). Needs a search source: the YouTube Data API (free key, about 100 searches a day) or a search run from the phone (the server IP is blocked by YouTube). PARKED by Sean 2026-10-16: "park it for now, maybe later if the app is successful".
- **BL-6 / BL-7 / BL-8 · Drive Mode v1 polish** (phone test, native build,
  island picker). Needs a device and a new native build.
- **BL-15 · Visual tuning pass.** Needs on-device measurement.
- **BL-23-ext · Android Google Cloud OAuth steps.** On Sean (Chrome): SHA-1 →
  Android OAuth client → add testers as Google test users.

## At risk / housekeeping
- Phrase-catalog backend: RESOLVED, merged 55f6062, prod health release 55f6062 (checked 2026-10-15).
- kageneko_v2.riv / v3.riv: NOT found anywhere on disk (2026-10-16 sweep); probably lost, check the Rive session. Untracked assets at risk:
  cosmetics_preview.png, kageneko-example.png.
- Stale/dirty worktrees safe to delete (confirm before deleting):
  actionbar-redesign, tabs-redesign, tiles-redesign, header-redesign, and other
  dirty ones once their diffs are confirmed already-merged.

## Ideas captured (not scheduled)
- Head-to-head challenges, and a leader-only cosmetic (crown or badge for the top 3, Sean's top pick). Sean 2026-10-14: wait until his friends are onboarded (memory social-xp-system).
- Mira font as an alternative font (Sean 2026-09-14, "put it as an idea").
- A reference app to study for the shadow player (Sean 2026-09-13, he names it).
- FEATURES.md ideas never approved: Anime player (SRT import), music via Apple Music or Spotify. Import-from-file is parked in .claude/parked/import-from-file.{md,patch} ("park it, maybe later", 2026-09-17).
- Leaderboard medallion pre-baked thumbnails (perf, D47).

## Done
- **BL-39 own confirm sheets (island/[id].tsx included), BL-40 Pipe Declogger sweep, BL-46 podcast shadow in place, BL-47 animations A1/A7/A10**: 93f251e and d676a94, on main. Keeper-verified 2026-10-17: no Alert.alert left in island/[id].tsx; podcast/[id].tsx no longer router.pushes to the island (253 lines changed); shared hooks use-saved-cards, use-dock-popovers, use-ladder-wiring, use-follow-build and dbconn.py added; pill-tab-bar.tsx and pill-tray.tsx carry the sliding pill, suggest.tsx the crossfade. BL-47 A9, A11, A12, A14-A17 were already live; A2-A6, A8, A13 rejected by Sean. Dev-only review tour (review-tour.tsx, dev_review.py) also in d676a94. Not checked: phone accept, tsc, a full test run.
- **BL-31 compact floating dock, BL-33 repeat ring, BL-34 line rail, BL-35 tray polish, BL-37 kinsoku, BL-38 shownLine gate, BL-41 review in the ladder**: 627a5b4, on main. Keeper-verified 2026-10-16: commit adds compact-dock.tsx, repeat-ring.tsx, line-rail.tsx, kinsoku.ts, use-ladder.ts, touches popover-bubble, tick-ruler, use-video-highlight (shownLine at line 183), review.tsx, podcast/[id].tsx. Not checked: tsc, phone accept.
- **BL-16 Harmonizer round 2**: 4e53e09, on main (cat/*, leaderboard, level-up-modal, settings, profile touched). Not checked: tsc, phone accept.
- **BL-18 ET-3 player UX redesign, BL-44 topic mic**: 94cdb56, on main. Keeper-verified: pass-strip.tsx, pass-help-sheet.tsx, practice-done-sheet.tsx added, auto-echo-sheet.tsx deleted; record.tsx topic mode (line 106); phrases/index.tsx and build.tsx touched.
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

- **BL-52 · Gate for external TestFlight: a how-to intro and a token limiter (2026-10-17, Sean).** Sean holds the external TestFlight group (public link, Beta App Review) until two things exist: (1) a good intro on how to use the app, which is BL-49's guided tour built from the friend session; (2) a token limiter in the app. Today the backend only counts actions per device per UTC day (main.py `_take_build_slot`: 5 creates, 3 reworks; `DAILY_CAPS`: explain 100, word_audio 400, podcast_search 60, take 200), invisible until a 429. Open questions for Sean before planning: a visible allowance in the app (a token or energy meter per user that refills daily) or only a hidden server cap; a global daily budget across all users so testers cannot exhaust Sean's Claude CLI and whisper capacity; what a tester sees at zero. The App Store Connect review text is ready (in chat 2026-10-17). Sean approved the design 2026-10-17 (build it sometime, not now): (a) a visible energy meter per user that refills daily, spent by every AI-costing action (create, regenerate, re-voice, explain); (b) a global daily budget across all users protecting the Claude CLI and whisper capacity; (c) at zero, a Kageneko "come back tomorrow" screen with the refill time, while review and practice on existing lines stay free. (d) Owner grants (Sean, 2026-10-17): only Sean (@sean, the owner device via _is_owner, never any other user) can give a person extra tokens, when he wants or when they ask him. Pick the user by @handle (reuse the leaderboard/profile lookup), choose an amount, the grant lands on top of their daily refill, and they get a small note in the app. Server-side check on the owner identity, logged for audit; the control is hidden for everyone else. Reuse the existing builds table and DAILY_CAPS. parked until Sean says go.

- **BL-53 · Wire the new kageneko.riv: tap reactions, purr and 8 emotions (2026-10-17, from Sean's Rive session).** New file at assets/rive/kageneko.riv (md5 2be82fe8…, drop-in: same artboard, state machine and ViewModel). New ViewModel props: `pressing` (boolean; tap under 0.4 s plays a random reaction, hold plays a purr loop; mirror pointer down/up yourself if the runtime does not run listener actions) and `emotion` (enum none|proud|excited|encouraging|sad|sleepy|love|curious|shy, looping, the app must set it back to none). Start the "Kageneko" state machine explicitly on load. Suggested triggers: proud after a good shadowing score, encouraging after a miss, sleepy when idle long, curious while listening. Wire in src/components/cat/kageneko-view.tsx (used by cat-avatar.tsx and cat-lab.tsx). Likely closes BL-20 (ET-4 idle clip). todo.
