# Stack

- **Client**: Expo SDK 57 + expo-router, TypeScript strict, npm. Routes live in
  `src/app/`, shared code in `src/lib/` and `src/constants/`. Audio is `expo-audio`
  (recording and pitch-corrected playback rate), which runs in Expo Go.
- **Backend**: Python FastAPI in `backend/`, started with `backend/run.sh` on
  `127.0.0.1:8020`. Never bind wider: this machine has a public IP and no NAT.
  Speech-to-text is local faster-whisper, Japanese generation goes through the
  local `claude --print` CLI (no API key), voice is VOICEVOX at `127.0.0.1:50021`
  (start with `~/voicevox/run --host 127.0.0.1 --port 50021`).
- **Reaching the backend from a phone**: cloudflared forwards
  `https://dev.sean.build/shadow/*` to `:8020`. The Expo client reads
  `EXPO_PUBLIC_SHADOW_API_URL` and `EXPO_PUBLIC_SHADOW_TOKEN` from `.env`.
- **Prod backend**: 127.0.0.1:8030 from `~/shadow-prod`, public at
  `https://shadow.sean.build/shadow`, deployed only by `backend/deploy-prod.sh`.
- Typecheck with `npx tsc --noEmit`. Read the exact versioned Expo docs at
  https://docs.expo.dev/versions/v57.0.0/ before writing native-facing code.

# Tests

The backend has a pytest suite in `backend/tests/`. It covers the pure logic
that is expensive to check by hand: the word to mora alignment in `segment.py`,
the VOICEVOX timeline maths, the bleed removal in `aec.py`, the sqlite store,
and the JSON the generator gets back from the claude CLI.

```bash
backend/run-tests.sh          # the whole suite
backend/run-tests.sh -k segment
```

It needs no VOICEVOX, no whisper model, no network and no live backend, and it
never touches the real islands: `tests/conftest.py` points `SHADOW_DATA_DIR` at
a throwaway directory before anything imports `store`. Keep it that way.

Run it before finishing any change under `backend/`, next to
`npx tsc --noEmit` for the client. A test that fails is a regression until
proven otherwise: fix the code, do not loosen the test. Test dependencies live
in `backend/requirements-dev.txt`.

# Feature-dev tunnel hygiene

- **Kill a feature's dev server as soon as we stop focusing on that feature.**
  Once a feature is accepted/merged (or we simply move attention elsewhere), stop
  its tunnel (`serve-tunnel/scripts/stop-tunnel.js <slug>`) so it stops holding a
  bundler, an ngrok agent, and disk/CPU. Don't leave idle servers running.
- **Only ONE tunnel works at a time** with this ngrok token (free tier = one
  usable domain). The state file is shared with the other projects on this
  machine, so a tunnel left running in another repo will block this one with
  exit 2. `node .claude/skills/serve-tunnel/scripts/list.js` shows what holds the
  slot. Serve and test features ONE AT A TIME.

# Writing style

Applies to everything a human reads: UI copy, code comments, JSDoc, docs and
commit messages. The `slop-check` skill holds the full rules and a scanner.

- **Never use an em dash.** Use the punctuation the sentence wants: a period for
  two independent clauses, a comma for a dependent one, a colon before a
  definition or list, parentheses around an aside. Never a bare hyphen instead.
<!-- slop-check: disable (the rule below has to quote the phrases it bans) -->
- **No hype filler in user-facing copy.** Cut the openers ("Nice!", "Perfect."),
  the empty enthusiasm ("Let's make it happen", "You're in good company") and the
  teaser asides ("One thing worth knowing…"). State what happens.
<!-- slop-check: enable -->
- **Deliberate exceptions, do not "fix" these:** en dashes in numeric ranges
  (`30–90s`, `0–10`) are correct typography, and trailing ellipses on progress
  labels (`Loading…`) are standard UI.
- **Before finishing a feature**, run the scanner and get a clean exit:
  ```bash
  node ~/.claude/skills/slop-check/scripts/scan.js
  ```
