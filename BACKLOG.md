# Backlog

Living list of Sean's requests and ideas. Every idea Sean gives is logged here
immediately, before building, so nothing lives only in chat and dies at
compaction. This is the source of truth. BUGS.md holds confirmed bugs (ET-n);
FEATURES.md holds shipped and approved scope. This file is the idea-capture and
status layer on top of them.

Status: **todo** / **doing** / **done** (cite commit) / **parked** (give reason).
New entries go at the bottom with the next BL number.

## Doing
- **wave-1015 · BL-19 + BL-2 · Phrase catalog UI + preset search chips.**
  Worktree phrase-catalog-ui. Built, uncommitted: not done until committed,
  merged and tsc passes.
- **wave-1015 · BL-13 · Leaderboard entrance spring.** Worktree stats-profile.
  Built (a spring tweak; the staggered entrance already existed). Uncommitted.
- **wave-1015 · BL-25 · Stats + profile view.** Worktree stats-profile. Being
  planned, nothing built.
- **wave-1015 · BL-28 · Saved-sentence review deck.** Worktree review-deck.
  Being planned, nothing built.
- **wave-1015 · BL-5 · Resume position.** Worktree resume-position. Being
  planned, nothing built.
- **wave-1015 · BL-32 · YouTube play/pause/speed reach the embed (2026-10-15).**
  Library 2.4.1 sends JSON, but the hosted iframe page only accepts plain
  strings, so controls never reached the embed. Fixed in wave-1015 with
  PLAYER_BRIDGE_SCRIPT (present in src/lib/youtube.ts, src/app/video/[id].tsx,
  src/app/review.tsx of the worktree, staged, not committed). Pending Sean's
  phone retest. Not done until committed and retested.

## Todo (decided, not yet built)
- BL-25 sub-items, BL-28 and BL-19 detail stay in Doing above while wave-1015 runs.
  Notes kept: BL-25 needs a leaderboard row onPress, a backend profile endpoint
  keyed by username, usePracticeClock wired into video and podcast screens (they
  count NO time today), new counters for video-watch, podcast-listen and total
  immersion time (all absent), and the OG "#007" serial (profiles.serial). BL-19
  needs the search response to return samples, count, added and Hebrew title.
- **BL-4 · YouTube fullscreen.**
- **BL-16 · Harmonizer round 2.** Audit done, fixes not applied.
- **BL-18 · ET-3 shadow-player UX redesign.** Diagnosis/plan only so far.
- **BL-20 · ET-4 Rive idle clip.** Still open (BUGS.md ET-4): fix lives in the .riv; untracked kageneko_v2/v3.riv may be the attempt, not wired in.
- **BL-31 · Podcast shadow flow in one place (2026-10-15).** Sean: listening to a
  podcast and shadowing a line live on different screens is confusing. "Shadow
  this line" (src/app/podcast/[id].tsx:300, router.push at :227) opens a different
  screen (the island player). He wants a faster flow with no screen change.
  Decided 2026-10-15: in place, like the video screen. The dock record button
  pauses the podcast, counts 3, records the current line, plays you next to the
  original, and play continues from the same spot. No screen change. Next wave
  (podcast/[id].tsx is busy in wave-1015).

## Parked (reason)
- **BL-6 / BL-7 / BL-8 · Drive Mode v1 polish** (phone test, native build,
  island picker). Needs a device and a new native build.
- **BL-15 · Visual tuning pass.** Needs on-device measurement.
- **BL-17 · ET-1 Spanish highlight sync.** Risky, chief-tier; build carefully,
  not under time pressure.
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
