# Bugs and requests

Known bugs and requests, worked on after the TestFlight pilot ships. New
entries go at the bottom with the next number. Move an entry to Closed with
the commit that fixed it.

Status: **open**, **in progress**, **closed**. Type: **bug**, **feature**,
**ux** (works, but is uncomfortable to use). Priority: **P1** (blocks
practice), **P2** (hurts practice), **P3** (nice to have).

## Open

### ET-12 · bug · P2 · open
**Settings > Language, Asia filter: the "Coming soon" list is cut and runs into the footer.**
Found by verify-monkey on wave-1017c (2026-10-20) and reproduced by hand: with
the Asia filter on, the Coming soon list is clipped and the Chinese row
collides with the "I UNDERSTAND" section. language-picker.tsx is not in the
wave diff, so main has it too. Evidence:
~/verify-evidence/monkey/wave-1017c-full2/pairs/074-settings_languages.png.

### ET-9 · bug · P2 · open
**Practice now: the Loading constellation draws on top of the first sentence.**
Tapping Practice now on Home crossfades into the session with both screens
visible (the session text over the Home cards), then the cat-constellation
loader and "Loading" stay drawn over the Japanese line for about a second
after the line is already shown. Screen recording from Sean, 2026-10-20.
Expected: the loader replaces the content until it is ready, never overlaps it.

### ET-10 · bug · P2 · open
**Video player, Listen: the sentence card is too short, so a long line is cut.**
On a YouTube video in Listen, a wrapped two-line sentence plus its English does
not fit the small caption card above the step strip. The second line and the
translation are clipped, so Sean has to scroll the card up and down to read
it (the jumps in the recording are his own scrolling, not the app). The card
also overlaps the step strip. Screen recording from Sean, 2026-10-20.
Expected: the card grows to fit the whole line and its translation (or the
text scales down), with no scrolling and no overlap.

### ET-11 · bug · P2 · open
**Memorise 3-2-1 countdown flickers at every step and at both ends.**
Frame by frame (Sean's recording, 2026-10-20): at each tick the whole gold
disc dips dark and the old and new digits show on top of each other ("3"
over "2", "2" over "1") for 2 or 3 frames; the "Starts after N" caption
switches instantly, a frame ahead of the digit. At the start the disc fades
in over the 1/2 dots and the Again / I'm ready buttons (both visible), and at
the end the "1" ghosts over the restored dots and buttons. Suspect: the disc
remounts per digit (key on the number) with an enter/exit fade, and the
countdown and the step content crossfade instead of one replacing the other.
Expected: the disc stays put, only the digit changes (a quick swap or a
number roll), caption in step, and no overlap with the step content.

### ET-8 · bug · P2 · open
**Wardrobe: fast tab taps flicker (two lit tabs, vanishing label, grid dips).**
Tapping Head, Face, Body, Extras quickly on the wardrobe shows, for a few
frames: two tab pills lit at once (ghosting), the new tab's label invisible
(its ink turns dark at once while its pill is still fading in), and the item
grid dimming to about a third before the new items appear. Screen recording
from Sean, 2026-10-20. Cause:
- `src/components/cat/slot-tabs.tsx` SlotPill: every pill fades its own light
  fill over 200ms, so the old and new pill overlap; the label colour switches
  instantly instead of following `lit`.
- `src/components/cat/item-grid.tsx` ItemGrid: a fade-through (out 100ms, swap,
  in) restarts on each tap, so rapid taps keep the grid dimmed.
Fix direction: one sliding indicator shared by the tray (translate, not four
crossfades), label colour interpolated from the same value, and a grid swap
that does not dip to dark when interrupted.

### ET-1 · bug · P1 · open
**Spanish islands: the words that light up do not match what is spoken.**
On a Spanish island the highlighted words and the audio drift apart, so what
lights up is not what you hear. Reported by Sean, 2026-10-12.
Suspects, to check in this order:
- The generator prompt for Spanish is loose (it was tuned for Japanese), so the
  text may not be what Kokoro ends up saying.
- The word timings come from whisper on the Kokoro audio; a mistranscribed or
  merged word shifts every word after it.
- The aligner that maps whisper words back to the written words.

### ET-2 · feature · P2 · open
**Ready-made phrase islands.**
A catalogue of everyday phrases (common questions, small talk, getting
around) already built as islands, so you pick one and it lands on Home with
no recording. Per learning language. Reported by Sean, 2026-10-12.

### ET-3 · ux · P1 · open
**Practising with the shadowing player and the ladders does not feel
comfortable yet.**
Sean finds the shadowing flow, the session ladder and the speed ladder
uncomfortable to learn with, and wants to understand why before anything is
changed. First step: a short session where Sean practises and says out loud
what gets in the way, then a list of concrete causes, then a redesign he
approves. Reported by Sean, 2026-10-12.

### ET-4 · bug · P3 · open
**Rive cat idle: the body and tail look clipped.**
During the idle animation part of the cat reads as cut off: a seam across the
belly and the tail getting sliced. Reported by Sean, 2026-10-14, with a marked
screenshot. Lives in the Rive artboard, not app code: the idle keyframes push
the body/tail outside the artboard bounds (or a layer separates), so Rive clips
it. Fix belongs in the `.riv` (the Rive MCP session): keep every idle pose
inside the artboard, or widen the artboard/bounds. Low priority, cosmetic.

## Closed

### ET-7 · crash · P0 · closed
**TestFlight build 14 crashes when a sheet opens in landscape.**
iOS abort in `__supportedInterfaceOrientations` while presenting the RN Modal of
`bottom-sheet.tsx`. That Modal is portrait-only by default, and YouTube fullscreen
locks the window to landscape, so any sheet opening there kills the app.
Reported by Sean (crash log), 2026-10-16. Fixed in 93f251e: `supportedOrientations` on the Modal (bottom-sheet.tsx:146) and the video leaves fullscreen before a help or explain sheet opens. Ships in the next TestFlight build.


### ET-5 · feature · P3 · closed
**A surface for the cat to stand on.**
The cat currently floats over the faint mountains. Give it something to sit/stand
on (a ledge, platform, cushion, rug, moonlit rock). Reported by Sean, 2026-10-14.
Routed to the Pre-Selector: 10 design variants in the Tide night-sky look,
converge over rounds to the best one, then hand the winner to the Animation
Maniac. Must sit under the cat without competing with it for focus (same taste
rules as the wardrobe scene).
Closed 2026-10-15: sea-rock stage in fd9b05b (cat-stage.tsx ROCK_*), depth pass 43dad2a.

### ET-6 · feature · P2 · closed
**Cat gaze: the cat looks where you touch.**
The cat's eyes (and a slight head tilt) follow the user's touch point anywhere on
the screen, easing back to centre on release. Reported by Sean, 2026-10-14.
Needs a look-at input in the .riv (requested from the Rive session: `lookX`/`lookY`
numbers, -1..1) that the app drives from the global touch position. App side:
capture touch, map to the cat's local -1..1 space, write to the inputs.
Closed 2026-10-15: fd9b05b (src/hooks/use-gaze.ts with dwell, kageneko-view.tsx drives lookX/lookY, updated kageneko.riv).

