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
eas env:create --environment production --name EXPO_PUBLIC_SHADOW_API_URL --value https://shadow.sean.build/shadow --visibility plaintext
eas env:create --environment production --name EXPO_PUBLIC_SHADOW_TOKEN --value "$(grep '^SHADOW_TOKEN=' ~/shadow-prod/env | cut -d= -f2-)" --visibility sensitive
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

## Update gate (after Sean accepts)

Builds 22 and newer block themselves when the backend lists a higher build.
Never run these before Sean accepts, and never as part of `release`:

- iOS: `python3 tools/asc-testflight.py publish --build N` (set `SHADOW_DATA_DIR`
  to `/home/sean/shadow-prod/data` first).
- Android: `python3 tools/set-latest-build.py --android N --url <expo.dev artifact url>`
  right before `tools/android-release-mail.py` with the same build and apk.
- Rollback: the same command with the old number.

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

## Android beta (internal APK)

An internal APK for Android friends, Google sign-in only (no Apple pill on
Android). It talks to the prod backend through the `preview` EAS environment.

### Build steps

Run from the repo root. `eas-cli` is not installed, so use `npx -y eas-cli@latest`.

1. `npx -y eas-cli@latest credentials -p android`, profile `preview`, then
   "Keystore: Manage everything needed to build your project", "Set up a new
   keystore", generate. EAS prints the SHA-1 and SHA-256. Send the SHA-1 to
   Sean at once. To read it later: expo.dev, waiter, echo-tail, Credentials,
   Android, build.sean.echotail, Keystore.
2. `npx -y eas-cli@latest build -p android --profile preview`. It reuses the
   keystore from step 1 and takes 10 to 20 minutes. The build page URL it
   prints is the install link (QR code, Install button, direct `.apk`).
3. On a first device, open the link in Chrome on an Android phone, download,
   allow "install unknown apps" for Chrome, install. Without a phone, use an
   Android Studio AVD with a Google Play system image and `adb install`.
4. Check the install on that device (cat icon on navy, onboarding shows only
   "Continue with Google", sign-in works, an island records), then send the
   link to the friends.

### Sean's checklist

1. Create an Android OAuth client: console.cloud.google.com, project
   `shadowing-app-511420`, APIs & Services, Credentials, Create credentials,
   OAuth client ID, type Android, name "Echo Tail Android (EAS keystore)",
   package `build.sean.echotail`, the SHA-1 from build step 1. Nothing from
   this client goes into the app or Supabase. Propagation can take minutes to
   a few hours.
2. Leave Supabase as is. Authentication, Providers, Google keeps the Web
   client id. Only if sign-in fails with a nonce message, turn on "Skip nonce
   checks".
3. Add every Android tester's Google email (and your own) under OAuth consent
   screen, Audience, Test users. Anyone not listed sees "Access blocked: Echo
   Tail has not completed the Google verification process".
4. Send the link with three lines: Android 7+, allow Chrome to install unknown
   apps, sign in with the Google account you gave me. Phones without Google
   Play Services cannot sign in.
5. If Play App Signing or a second keystore ever appears, add its SHA-1 as
   another Android client. The old one keeps working.
