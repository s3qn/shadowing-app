# serve-config.sh  (copy this file to .claude/serve-config.sh and edit)
#
# Tells serve.sh how to start THIS app's dev server. serve.sh handles the ngrok
# tunnel, port picking, state and QR; it knows nothing about the stack.
#
# Available to the command: $PORT (the port serve.sh picked, already exported).
#
#   DEV_START_CMD   the command to exec. MUST bind $PORT and stay in foreground.
#   DEV_PROXY_ENV   name of the env var that receives the public https URL, so
#                   the bundler advertises the tunnel host instead of localhost.
#                   Leave empty for stacks that do not need it.
#   DEV_READY_RE    grep -E pattern that appears in the dev server's log once it
#                   is actually serving. serve.sh waits for this.
#   DEV_FAIL_RE     pattern that means it failed to start. Optional.
#   DEV_SCAN_SCHEME scheme for the URL put in front of the user. "exp" makes an
#                   exp:// link for Expo Go; "https" for anything opened in a
#                   browser.

# --- Expo / React Native (scan with Expo Go) ---------------------------------
DEV_START_CMD='npx expo start --port $PORT'
DEV_PROXY_ENV='EXPO_PACKAGER_PROXY_URL'
DEV_READY_RE='logs for your project|waiting on'
DEV_FAIL_RE='Skipping dev server|Input is required'
DEV_SCAN_SCHEME='exp'

# --- Vite (open in the phone browser) ----------------------------------------
# DEV_START_CMD='npx vite --host 0.0.0.0 --port $PORT'
# DEV_PROXY_ENV=''
# DEV_READY_RE='ready in|Local:'
# DEV_SCAN_SCHEME='https'

# --- Next.js -----------------------------------------------------------------
# DEV_START_CMD='npx next dev -H 0.0.0.0 -p $PORT'
# DEV_PROXY_ENV=''
# DEV_READY_RE='Ready in|started server on'
# DEV_SCAN_SCHEME='https'

# --- Python / FastAPI --------------------------------------------------------
# DEV_START_CMD='uvicorn main:app --host 0.0.0.0 --port $PORT --reload'
# DEV_PROXY_ENV=''
# DEV_READY_RE='Application startup complete|Uvicorn running'
# DEV_SCAN_SCHEME='https'
