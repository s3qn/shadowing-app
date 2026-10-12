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

## Closed

(none yet)
