# Bugs and requests

Known bugs and requests, worked on after the TestFlight pilot ships. New
entries go at the bottom with the next number. Move an entry to Closed with
the commit that fixed it.

Status: **open**, **in progress**, **closed**. Type: **bug**, **feature**,
**ux** (works, but is uncomfortable to use). Priority: **P1** (blocks
practice), **P2** (hurts practice), **P3** (nice to have).

## Open

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

### ET-5 · feature · P3 · open
**A surface for the cat to stand on.**
The cat currently floats over the faint mountains. Give it something to sit/stand
on (a ledge, platform, cushion, rug, moonlit rock). Reported by Sean, 2026-10-14.
Routed to the Pre-Selector: 10 design variants in the Tide night-sky look,
converge over rounds to the best one, then hand the winner to the Animation
Maniac. Must sit under the cat without competing with it for focus (same taste
rules as the wardrobe scene).

### ET-6 · feature · P2 · open
**Cat gaze: the cat looks where you touch.**
The cat's eyes (and a slight head tilt) follow the user's touch point anywhere on
the screen, easing back to centre on release. Reported by Sean, 2026-10-14.
Needs a look-at input in the .riv (requested from the Rive session: `lookX`/`lookY`
numbers, -1..1) that the app drives from the global touch position. App side:
capture touch, map to the cat's local -1..1 space, write to the inputs.

## Closed

(none yet)
