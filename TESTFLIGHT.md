# TestFlight build

Commands Sean runs himself, in order, from the repo root. Needs a paid Apple
Developer account (App Store Connect access) and an Expo account.

## App identity

The app is named Echo Tail (`app.json` slug `echo-tail`, iOS bundle
identifier `build.sean.echotail`, URL scheme `echotail`).

## One-time setup

```bash
npm i -g eas-cli
eas login
eas init
```

`eas init` links this project to an EAS project and writes
`extra.eas.projectId` into `app.json` on first run. Commit that change when it
appears, it is expected.

## Environment variables for the production profile

The production build profile in `eas.json` sets `"environment": "production"`,
so EAS injects these from EAS Environment Variables at build time instead of
reading the local `.env` file. The API URL is the production backend. The
token is the `SHADOW_TOKEN` line of `~/shadow-prod/env` (not the dev token in
`backend/.env`), read straight from that file so it never lands in shell
history or in this doc:

```bash
eas env:create --environment production --name EXPO_PUBLIC_SHADOW_API_URL --value https://shadow.sean.build/shadow --visibility plain
eas env:create --environment production --name EXPO_PUBLIC_SHADOW_TOKEN --value "$(grep '^SHADOW_TOKEN=' ~/shadow-prod/env | cut -d= -f2-)" --visibility secret
```

## Smoke test first: preview build

Run a preview build before spending a production build and submit cycle. This
confirms the native modules (expo-audio background playback, expo-symbols,
expo-blur, expo-glass-effect, react-native-skia, reanimated, gesture-handler,
haptics) still compile and run correctly outside Expo Go, since a compiled
build behaves differently from Expo Go's fixed native runtime.

```bash
eas build -p ios --profile preview
```

1. Install the build from the EAS build page's ad hoc link or QR code on an
   iPhone.
2. Confirm mic recording and playback work, and that the settings screen
   opens without the Prism lab row visible.

## Production build and submit

Only after the preview build checks out:

```bash
eas build -p ios --profile production
eas submit -p ios --latest
```

## App Store Connect

1. Create an internal testing group containing only Sean, add the build to it.
2. Create a separate external group with a public TestFlight link for friends
   and family.
3. The first external build triggers Apple's Beta App Review. It asks for:
   - an app description
   - "what to test" notes
   - a demo account note: write "no login required"
   - contact email: sean@larch-networks.com

## Pushing an update later

Bump `version` in `app.json` only for a user-visible version number change.
For every other update, just rerun the build and submit commands, `buildNumber`
auto-increments on its own because `eas.json` sets `appVersionSource: "remote"`
and `autoIncrement: true` on the production profile:

```bash
eas build -p ios --profile production
eas submit -p ios --latest
```

## Known loose end

`src/app/(tabs)/settings.tsx` hides the "Prism lab" row behind `__DEV__`, so
it is false and hidden in a production build. The route file itself,
`src/app/prism-lab.tsx`, still ships in the bundle (Metro cannot tree-shake a
route) and stays reachable at `echotail://prism-lab` by deep link. This is an
acceptable, undocumented internal debug route for now. Removing or gating it
further is out of scope for this build setup.

## App icon

The app icon stays the cat art (`assets/images/cat_icon_app.png`) until Sean
draws the tail mark.
