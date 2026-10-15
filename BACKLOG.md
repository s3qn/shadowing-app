# Backlog

Living list of Sean's requests and ideas. Every idea Sean gives is logged here
immediately, before building, so nothing lives only in chat and dies at
compaction. This is the source of truth. BUGS.md holds confirmed bugs (ET-n);
FEATURES.md holds shipped and approved scope. This file is the idea-capture and
status layer on top of them.

Status: **todo** / **doing** / **done** (cite commit) / **parked** (give reason).
New entries go at the bottom with the next BL number.

## Doing
- (nothing in flight)

## Todo (decided, not yet built)
- **BL-28 · Saved-sentence review deck.** In a video/podcast, tap a sentence →
  one-tap star ("Save to review", symbol pickable). Saved sentences become an
  SRS deck reviewed with the ORIGINAL audio (Sean's call: record/keep the audio
  clip, not just seek-loop; YouTube ToS/technical reality to resolve in
  planning). SRS per saved sentence. YouTube + podcasts LEAVE the due-today SRS
  loop (long media is watch/listen, not drilled wholesale). Decided 2026-10-15.
- **BL-2 · Preset learner search chips.** Backend phrase-search is MERGED
  (55f6062) and deployed to prod; the chips UI is still not built.
- **BL-4 · YouTube fullscreen.**
- **BL-5 · Passive auto-save / resume position.**
- **BL-13 · Leaderboard entrance animations.**
- **BL-16 · Harmonizer round 2.** Audit done, fixes not applied.
- **BL-18 · ET-3 shadow-player UX redesign.** Diagnosis/plan only so far.
- **BL-19 · Bigger phrase catalog + catalog UI + import-from-web.** Backend
  search is MERGED (55f6062) and deployed to prod; design winner done; UI never
  built (src/app/phrases/index.tsx is still a flat topic list); content not
  grown. Needs the search response to return samples/count/added/Hebrew title
  first.
- **BL-25 sub-items (stats/profile, none built):** tap-to-profile route from the
  leaderboard (no row onPress today); a backend profile endpoint keyed by
  username; wire usePracticeClock into the video and podcast screens (they count
  NO time today); instrument video-watch-seconds, podcast-listen-seconds and
  total-immersion-time (all confirmed absent); OG "#007" serial (profiles.serial).
- **BL-29 · menu-icons plan.** .claude/plans/menu-icons.md, never built
  (island-menu-sheet.tsx has no expo-symbols).
- **BL-20 · ET-4 Rive idle clip.** Still open (BUGS.md ET-4): fix lives in the .riv; untracked kageneko_v2/v3.riv may be the attempt, not wired in.
- **BL-25 · Statkeeper stats + profile view.** Tap a leaderboard user → dressed
  cat + all stats. Catalog of 62 stats built; backend counters + profile UI not
  built. Headline stats: total immersion time, YouTube watch time, podcast
  listen time.

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
- **BL-30 · BUGS.md hygiene** (ET-5 cat surface, ET-6 cat gaze moved to Closed) — fd9b05b, 43dad2a. Verified 2026-10-15 in code (cat-stage.tsx ROCK_*, use-gaze.ts, lookX/lookY in kageneko-view.tsx).
- **BL-27 · Cinematic YouTube sync overhaul** (voice-synced karaoke, dock
  controls the video, calm swaps, captions off) — e45a5cf. Opus review clean;
  LEAD_S device calibration still owed when Sean tests build 12. Keeper-verified 2026-10-15: commit touches video/[id].tsx, use-video-highlight.ts, ruby-word.tsx, youtube.ts; the Opus-review and device claims are not checkable from git.
- **BL-phrase-backend · Split phrase catalog + backend search** — 55f6062,
  deployed to prod. Verified 2026-10-15: prod /shadow/health release 55f6062, /phrases/search route in main.py, backend suite 703 passed.
- **BL-1 · YouTube cinematic player + per-word karaoke** — 83359ea (superseded by
  BL-27 tuning).
- **BL-14 · Prominent @username on Home badge** — 6e1c6d9.
- **BL-22 · Security exploit hunt (coin/XP) + fix + prod deploy** — 03ed10b.
- **BL-23 · Android beta infra (package, adaptive icon, Google-only sign-in) +
  APK** — 16b7f3a.
- **BL-26 · Deferred level-up pop-up** — 700c39e.
- **BL-perf · Practice route / Rive focus gate / cheaper karaoke** — 29c4239.
- **BL-lb · Leaderboard shows the viewer at their real rank** — 8f9263a.
- **BL-social (earlier) · Leaderboard with 0-XP users, visual fixes, default
  speed = 1.0.**
