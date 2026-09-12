# Island housekeeping

Two things Sean asked for: delete an island from the list, and regenerate an
island at the other complexity from the player. Both backend routes already
exist and are unchanged by this feature. All work is in the Expo client.

Builders: `AGENTS.md` and `CLAUDE.md` are untracked and therefore missing from
this worktree. Read `/home/sean/app-projects/shadowing-app/AGENTS.md` before
writing anything. Its writing rules apply to every string you add: never an em
dash, no hype filler, state what happens.

## Context

- Islands pile up in the list and there is no way to remove one. The backend
  already has `DELETE /shadow/islands/{id}` (removes the row and the audio
  folder). The list needs a way to trigger it, with a confirmation, because it
  is destructive and there is no undo.
- Each island was written at one complexity: "one sentence at a time"
  (simple) or "more complex sentences to practice complex shadowing patterns"
  (complex). The backend already has `POST /shadow/islands/{id}/regenerate`
  with a `complexity` form field, which rewrites and re-voices the island from
  the stored recording in roughly 40 seconds. The player needs a link that
  calls it for the other complexity and shows what is happening while it runs.
- `src/lib/api.ts` already has `deleteIsland(id)` and
  `regenerate(id, complexity)`. Both currently ignore the response, so a 404,
  409 or 502 is swallowed. This feature makes them throw like the rest of the
  module.

## Design

### No backend changes

Both routes do what is needed. `regenerate` validates the complexity first
(400), then the island (404), then the recording (409), clears the lines,
flips the row to `working` / `writing`, and runs `_build_island` in the
background: transcribe again, write, speak, then `set_ready`. `delete_island`
is a no-op for an unknown id and returns `{"ok": true}`. Nothing to restart.

### Delete from the list (`src/app/index.tsx`)

- Gesture: long press on an island card. Sean's own wording in FEATURES.md
  was "swipe or long press"; long press needs no gesture library and no new
  layout, so it wins. Assumption: this is discoverable enough for a one-user
  app. A visible button per card would cost row space for a rare action.
- Confirmation: `Alert.alert` from react-native (works in Expo Go on both
  platforms, no dependency). Title `Delete "<title>"?`, message
  `The recording, its lines and their audio are removed. This cannot be undone.`,
  buttons `Cancel` (style `cancel`) and `Delete` (style `destructive`).
- On confirm: `await api.deleteIsland(id)`, then drop the row from local
  state so it vanishes at once; the 3s focus poll keeps the list truthful
  after that. On failure: `Alert.alert('Could not delete', message)`, because
  the list's `error` state only renders when the list is empty.
- The card `Pressable` is `disabled` while an island is building, which also
  disables long press. So a building island cannot be deleted until it lands
  as ready or failed (a minute at most). Failed islands can be deleted.
- The card currently uses `<Link asChild>`. It becomes a plain `Pressable`
  with `onPress={() => router.push(...)}` (the pattern `record.tsx` already
  uses with `router.replace`) and `onLongPress`. This removes any doubt about
  `Link` composing `onLongPress`.

### Regenerate from the player (`src/app/island/[id].tsx`)

- Placement: a text link in the controls block, directly under the existing
  Re-voice link, same style (the `revoice` / `revoiceText` styles, renamed
  `action` / `actionText` since two actions now share them).
- Copy, from Sean's two level names:
  - island is `simple`: `Regenerate with complex patterns`
  - island is `complex`: `Regenerate one sentence at a time`
  - while running: `Regenerating…`
- Confirmation: `Alert.alert`. Title is the link text with a question mark
  (`Regenerate with complex patterns?`). Message:
  `The current lines are replaced with new ones written from the same recording. This takes about a minute.`
  Buttons `Cancel` and `Regenerate`. A confirmation is warranted: the old
  lines are gone the moment the route runs (`store.clear_lines`), and the
  learner may have liked them.
- Both links are disabled while either revoice or regenerate is running.

### While a regenerate is running

The revoice precedent (`doRevoice`) is: pause the player, call the route,
poll `getIsland` once a second until `ready` or `failed`, then swap in the new
island and go to line 0. Regenerate mirrors it, with two differences that come
from the backend: the old lines no longer exist on the server during the
build, and there are three stages (transcribing, writing, speaking) that take
about 40 seconds instead of a few.

- The poll loop in `doRevoice` is lifted into one helper, `waitForIsland`,
  used by both flows (see Task 3 for the signature). Revoice keeps its 60
  second budget; regenerate gets 240 seconds because it transcribes again.
- While `regenerating` is true the player screen shows a spinner and the
  current stage label instead of the sentence and controls, the same way the
  `!line` branch shows `Still building this island…`. The stage labels
  (`Transcribing…`, `Writing Japanese…`, `Recording the voice…`) already exist
  as `STAGE_LABEL` in `index.tsx`; they move to `api.ts` so both screens read
  one map.
- When the island comes back `ready`: reset the ring, anchor and position
  (the same lines `go()` runs), bump a local `generation` counter, set line 0,
  set the island. `generation` goes into the `v` query parameter of
  `lineAudioUrl` as `${island.speaker}-${generation}`. This is required, not
  a nicety: `useAudioPlayer` keys the native player on the serialized source,
  so with an identical URL the new line 0 would play the old wav.
- When it comes back `failed`: reload the island (`setAttempt`). The server
  now has a failed island with no lines, and the existing `!line` branch
  already shows the error with its own Regenerate button (which retries at
  the island's current complexity, now the new one). Nothing new to build.
- When 240 seconds pass with no answer: show an inline error
  `Still building. Open this island again from the list in a minute.` and
  leave the old lines on screen. `generation` is not bumped, so the audio on
  screen still matches the text on screen.
- Leaving the screen mid-regenerate is fine and needs no code: the list's
  3s poll shows the row with its stage label and a spinner, the card is
  disabled until the island lands, and reopening it loads the new lines. The
  orphaned poll promise resolves against an unmounted screen, which React 18
  ignores.

### Left out, on purpose

- Delete from inside the player. The list is where you tidy; one place is
  enough.
- Swipe to delete. Needs `Swipeable` from gesture-handler and a row redesign
  for an action used a few times a month.
- Showing the complexity on the player. The link text already says which
  level you are on by naming the other one.
- Backend guard against regenerating an island that is already building. The
  client disables the link while it runs; the list disables the card. Adding
  a 409 would need a backend restart Sean has to do himself.
- Skipping the second transcription in `_build_island` (the transcript is
  already stored). A real saving of maybe 10 seconds, but a backend change;
  listed under Risks as a follow-up.

## Tasks

Order: Task 1 first (small, the others import from it). Tasks 2 and 3 are
independent of each other and run in parallel after Task 1. Task 4 is
independent and can run at any time. Every task runs in the worktree
`/home/sean/app-projects/shadowing-app-worktrees/island-housekeeping`.

Shared verification snippets (the backend token lives only in the main
checkout; the worktree has no `backend/.env`):

```bash
cd /home/sean/app-projects/shadowing-app-worktrees/island-housekeeping
npx tsc --noEmit -p tsconfig.json
node ~/.claude/skills/slop-check/scripts/scan.js
TOK=$(grep '^SHADOW_TOKEN=' /home/sean/app-projects/shadowing-app/backend/.env | cut -d= -f2-)
```

Never run curl against a real island id with DELETE or regenerate: those are
Sean's islands. The fake id `nope` exercises auth, routing and validation
without touching data.

### Task 1: harden `api.ts` and share the stage labels

Files: `src/lib/api.ts` only. Independent. Run first.

1. `deleteIsland`: replace the bare `await fetch(...)` with
   `await json<unknown>(await fetch(\`${BASE}/islands/${id}\`, { method: 'DELETE', headers: headers() }))`
   so a bad status throws the same readable message the rest of the module
   produces. JSDoc: `/** Remove an island, its lines and its audio. There is no undo. */`
2. `regenerate`: capture the `expoFetch` response in `res` and end with
   `await json<unknown>(res);`, exactly as `revoice` does. JSDoc:
   `/** Rewrite and re-voice an island at the given complexity from its stored recording. Poll getIsland until ready. */`
3. Add, next to the `IslandSummary` type (anchor: `export type IslandSummary`):
   ```ts
   /** What each backend build stage means to the person waiting for it. */
   export const STAGE_LABEL: Record<string, string> = {
     queued: 'Queued…',
     transcribing: 'Transcribing…',
     writing: 'Writing Japanese…',
     speaking: 'Recording the voice…',
   };
   ```
   Do not touch `index.tsx` here; Task 2 switches it to this export.
4. In `lineAudioUrl`, extend the comment (anchor: `` `v` changes with the voice ``)
   to: `` // `v` changes with the voice and with every regeneration so a replaced line is never served from cache. ``

Verify:
```bash
npx tsc --noEmit -p tsconfig.json
node ~/.claude/skills/slop-check/scripts/scan.js
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE 127.0.0.1:8020/shadow/islands/nope                       # 401, no token
curl -s -H "Authorization: Bearer $TOK" -X DELETE 127.0.0.1:8020/shadow/islands/nope                         # {"ok":true}
curl -s -H "Authorization: Bearer $TOK" -F complexity=complex -X POST 127.0.0.1:8020/shadow/islands/nope/regenerate   # {"detail":"no such island"}
curl -s -H "Authorization: Bearer $TOK" -F complexity=bogus -X POST 127.0.0.1:8020/shadow/islands/nope/regenerate     # {"detail":"complexity must be 'simple' or 'complex'"}
```
The last two prove that a failed regenerate now has a body `json()` turns
into `404 {"detail":"no such island"}` style messages on the phone.

### Task 2: long press to delete, in the list

Files: `src/app/index.tsx` only. Depends on Task 1 (imports `STAGE_LABEL`).

1. Imports: add `Alert` to the react-native import; remove `Link` from the
   expo-router import (it becomes unused). Delete the local `STAGE_LABEL`
   const (anchor: `const STAGE_LABEL: Record<string, string>`) and read
   `api.STAGE_LABEL` in `renderItem` instead.
2. Inside `IslandsScreen`, after `load`, add:
   ```ts
   async function remove(id: string) {
     try {
       await api.deleteIsland(id);
       setIslands((prev) => prev.filter((i) => i.id !== id));
     } catch (e) {
       Alert.alert('Could not delete', e instanceof Error ? e.message : 'The server did not answer.');
     }
   }

   function confirmDelete(item: api.IslandSummary) {
     Alert.alert(
       `Delete "${item.title || 'Untitled island'}"?`,
       'The recording, its lines and their audio are removed. This cannot be undone.',
       [
         { text: 'Cancel', style: 'cancel' },
         { text: 'Delete', style: 'destructive', onPress: () => void remove(item.id) },
       ],
     );
   }
   ```
3. In `renderItem`, replace the `<Link href=... asChild>` wrapper (anchor:
   `<Link href={{ pathname: '/island/[id]'`) with the `Pressable` alone:
   ```tsx
   <Pressable
     disabled={busy}
     onPress={() => router.push({ pathname: '/island/[id]', params: { id: item.id } })}
     onLongPress={() => confirmDelete(item)}
     style={...unchanged...}>
   ```
   Body of the card is unchanged. Add a one-line comment above the
   `Pressable`: `// Long press deletes, after a confirmation. Building islands are disabled, so they cannot be deleted until they land.`

Verify:
```bash
npx tsc --noEmit -p tsconfig.json
node ~/.claude/skills/slop-check/scripts/scan.js
grep -n 'Link' src/app/index.tsx            # expect no hits
grep -n 'STAGE_LABEL' src/app/index.tsx     # expect only api.STAGE_LABEL
```

### Task 3: regenerate at the other complexity, from the player

Files: `src/app/island/[id].tsx` only. Depends on Task 1 (imports
`STAGE_LABEL`, relies on `regenerate` throwing). Independent of Task 2.

1. Imports: add `Alert` to the react-native import.
2. State, next to `const [revoicing, setRevoicing] = useState(false);`:
   ```ts
   const [regenerating, setRegenerating] = useState(false);
   // Backend stage while a regenerate runs, for the label on the waiting screen.
   const [buildStage, setBuildStage] = useState('');
   // Bumped after each regenerate so the line audio URLs change. useAudioPlayer
   // keys the native player on the serialized source: the same URL would keep
   // the old wav loaded under the new text.
   const [generation, setGeneration] = useState(0);
   ```
3. The `source` memo (anchor: `api.lineAudioUrl(island.id, line.idx, island.speaker, speed)`):
   pass `` `${island.speaker}-${generation}` `` as the third argument and add
   `generation` to the dependency array.
4. Lift the poll loop out of `doRevoice` into a helper above it:
   ```ts
   // Polls until the island settles. Returns the ready island, throws with the
   // island's error when it failed, returns null when maxSeconds pass first.
   // A poll can fail while the server is briefly unreachable; that is not the
   // island failing, so keep polling.
   async function waitForIsland(
     islandId: string,
     maxSeconds: number,
     onStage?: (stage: string) => void,
   ): Promise<api.Island | null> {
     for (let i = 0; i < maxSeconds; i += 1) {
       await new Promise((r) => setTimeout(r, 1000));
       let data: api.Island;
       try {
         data = await api.getIsland(islandId);
       } catch {
         continue;
       }
       onStage?.(data.stage);
       if (data.status === 'ready') return data;
       if (data.status === 'failed') throw new Error(data.error || 'Building failed');
     }
     return null;
   }
   ```
   `doRevoice` keeps its behaviour and shrinks to:
   ```ts
   try {
     await api.revoice(island.id, voice);
     const data = await waitForIsland(island.id, 60);
     if (data) {
       setIsland(data);
       setIdx(0);
     }
   } catch (e) {
     setError(e instanceof Error ? e.message : 'Re-voicing failed');
   } finally {
     setRevoicing(false);
   }
   ```
   Its guard becomes `if (!island || voice === null || revoicing || regenerating) return;`.
5. Add the regenerate flow after `doRevoice`:
   ```ts
   function confirmRegenerate() {
     if (!island || revoicing || regenerating) return;
     const target: api.Complexity = island.complexity === 'simple' ? 'complex' : 'simple';
     Alert.alert(
       target === 'complex' ? 'Regenerate with complex patterns?' : 'Regenerate one sentence at a time?',
       'The current lines are replaced with new ones written from the same recording. This takes about a minute.',
       [
         { text: 'Cancel', style: 'cancel' },
         { text: 'Regenerate', onPress: () => void doRegenerate(target) },
       ],
     );
   }

   // The backend drops the old lines as soon as the route runs and rebuilds
   // from the stored recording: transcribe, write, speak. The screen shows the
   // stage until the island is ready again, then starts over at line 0.
   async function doRegenerate(target: api.Complexity) {
     if (!island) return;
     setRegenerating(true);
     setBuildStage('writing');
     cancelGap();
     playWhenLoaded.current = false;
     player.pause();
     closePanel();
     try {
       await api.regenerate(island.id, target);
       const data = await waitForIsland(island.id, 240, setBuildStage);
       if (!data) {
         setError('Still building. Open this island again from the list in a minute.');
         return;
       }
       cancelAnimation(ring);
       ring.value = 0;
       ringAimed.current = false;
       anchor.current = { time: 0, at: Date.now(), playing: false, rate: 1 };
       setPosition(0);
       setGeneration((g) => g + 1);
       setIdx(0);
       setIsland(data);
     } catch (e) {
       // The server now holds a failed island with no lines. Reloading shows
       // the failed screen, which already offers Regenerate.
       setError(e instanceof Error ? e.message : 'Regenerating failed');
       setAttempt((n) => n + 1);
     } finally {
       setRegenerating(false);
     }
   }
   ```
6. Waiting screen. Right after the `if (!line) { ... }` early return and
   before `const activeWord`, add:
   ```tsx
   if (regenerating) {
     return (
       <SafeAreaView style={StyleSheet.flatten([styles.fill, styles.center, { backgroundColor: palette.bg }])}>
         <Stack.Screen options={{ title: island.title || 'Island' }} />
         <ActivityIndicator color={palette.accent} />
         <Text style={[styles.body, { color: palette.muted }]}>
           {api.STAGE_LABEL[buildStage] ?? 'Rebuilding this island…'}
         </Text>
       </SafeAreaView>
     );
   }
   ```
   All hooks sit above the existing early returns, so this one is safe.
7. The link. Rename styles `revoice` to `action` and `revoiceText` to
   `actionText` (two usages plus the two style keys). Then, directly after
   the Re-voice `Pressable` block (anchor: `Re-voice in ${voiceName`), add:
   ```tsx
   <Pressable onPress={confirmRegenerate} disabled={revoicing || regenerating} style={styles.action}>
     <Text style={[styles.actionText, { color: revoicing || regenerating ? palette.muted : palette.accent }]}>
       {regenerating
         ? 'Regenerating…'
         : island.complexity === 'simple'
           ? 'Regenerate with complex patterns'
           : 'Regenerate one sentence at a time'}
     </Text>
   </Pressable>
   ```
   Also pass `disabled={revoicing || regenerating}` on the Re-voice
   `Pressable` and use the same condition for its muted colour.
8. Leave the `!line` branch's Regenerate button as it is. It retries at the
   island's current complexity and is the recovery path after a failure.

Verify:
```bash
npx tsc --noEmit -p tsconfig.json
node ~/.claude/skills/slop-check/scripts/scan.js
grep -c 'waitForIsland' 'src/app/island/[id].tsx'   # 3: definition plus two callers
grep -n 'revoiceText\|styles.revoice' 'src/app/island/[id].tsx'   # expect no hits
curl -s -H "Authorization: Bearer $TOK" 127.0.0.1:8020/shadow/islands | head -c 400   # islands list still intact
```

### Task 4: FEATURES.md

Files: `FEATURES.md` only. Independent.

Remove the two bullets under Ideas (anchors: `Regenerate an island at the
other complexity` and `Delete an island from the list`). Add one bullet at
the end of Done:

```
- Island housekeeping: long press an island in the list to delete it, after
  a confirmation. A Regenerate link in the player rebuilds the island at the
  other complexity from the stored recording, shows the build stage while it
  runs, and starts over at line 1 when it lands.
```

Verify: `node ~/.claude/skills/slop-check/scripts/scan.js` and
`grep -c 'housekeeping' FEATURES.md` (1).

## Verification on the phone

1. Islands list: long press a ready island. An alert names it and offers
   Cancel and Delete. Cancel leaves it. Delete removes it at once, and it
   stays gone after pull to refresh.
2. Long press a building island: nothing happens (card is disabled).
3. Open a simple island: under Re-voice the link reads `Regenerate with
   complex patterns`. Tap, Cancel: nothing changes. Tap, Regenerate: the
   sentence and controls give way to a spinner with `Transcribing…`, then
   `Writing Japanese…`, then `Recording the voice…`.
4. Within about a minute the player is back on line 1 with longer, connected
   sentences, the link now reads `Regenerate one sentence at a time`, and
   Play highlights the new words in step with the new audio.
5. Go back to the list: the row reads `N lines · complex`.
6. Regenerate again, then back out to the list mid-build: the row shows the
   stage and a spinner and cannot be opened until it lands; opening it then
   shows the new lines.

## Risks

- Delete has no undo, and the confirmation alert is the only guard. A slip
  removes a recording for good.
- Regenerate drops the old lines the instant it starts. If generation fails,
  the island is left failed with no lines; the failed screen's Regenerate
  button is the way back, and the old lines are not recoverable.
- The backend transcribes the recording again on every regenerate although
  the transcript is stored. Real cost is 10 to 20 seconds on a long take.
  Follow-up: have the route pass the stored transcript to a variant of
  `_build_island` that skips whisper.
- The audio cache buster is in-session only. Across sessions the same line
  URL comes back with the same `v`. Native media players do not normally
  read the HTTP cache, so this has not bitten revoice either. If stale audio
  ever appears after a regenerate, add an `updated_at` column to `islands`
  (bumped in `set_ready`) and use it as `v`.
- Long press is invisible until you know it. Acceptable for a one-user app;
  a small Delete affordance on the card is a cheap follow-up if it is
  forgotten.
- Backend curl checks hit the running server, which serves the main
  checkout, not this worktree. That is fine here because the backend is
  unchanged.
