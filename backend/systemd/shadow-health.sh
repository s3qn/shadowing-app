#!/usr/bin/env bash
# shadow-health.sh
#
# The one command to run after a reboot. Checks the whole chain a TestFlight
# phone depends on, from the bottom up: lingering, each systemd user unit, each
# service answering on localhost, nothing bound wider than 127.0.0.1, and the
# public URL the app actually calls.
#
# Exit 0 when every tester-facing part is healthy, 1 when any of them is not.
# The dev backend and the QR dashboard are reported but never fail the run:
# no tester touches either one.
set -uo pipefail

FAIL=0
# Colour only on a terminal, so piping this into a file or a log stays readable.
if [ -t 1 ]; then GREEN=$'\033[32m'; RED=$'\033[31m'; OFF=$'\033[0m';
else GREEN=""; RED=""; OFF=""; fi
ok()   { printf '  %sok%s    %s\n' "$GREEN" "$OFF" "$*"; }
bad()  { printf '  %sDOWN%s  %s\n' "$RED" "$OFF" "$*"; FAIL=1; }
note() { printf '  --    %s\n' "$*"; }

# unit_state <unit> <required 0|1>
unit_state() {
  local unit="$1" required="$2" enabled active
  enabled="$(systemctl --user is-enabled "$unit" 2>&1 || true)"
  active="$(systemctl --user is-active "$unit" 2>&1 || true)"
  local line="$unit (enabled: $enabled, active: $active)"
  if [ "$active" = "active" ]; then
    if [ "$enabled" = "enabled" ] || [ "$required" != "1" ]; then
      ok "$line"
    else
      bad "$line, running now but will not come back after a reboot"
    fi
  elif [ "$required" = "1" ]; then
    bad "$line"
  else
    note "$line"
  fi
}

# http <label> <url> <required 0|1> [expected codes, default 2xx/3xx]
http() {
  local label="$1" url="$2" required="$3" expect="${4:-}" code
  # curl writes 000 itself when it never got a response, so do not add another
  # one on the non-zero exit or the code reads 000000.
  code="$(curl -s -m 8 -o /dev/null -w '%{http_code}' "$url" 2>/dev/null)" || true
  [ -n "$code" ] || code=000
  local good=0
  if [ -n "$expect" ]; then
    case " $expect " in *" $code "*) good=1 ;; esac
  else
    case "$code" in 2??|3??) good=1 ;; esac
  fi
  if [ "$good" = "1" ]; then
    ok "$label ($code) $url"
  elif [ "$required" = "1" ]; then
    bad "$label ($code) $url"
  else
    note "$label ($code) $url"
  fi
}

echo "Boot persistence"
if [ "$(loginctl show-user "$(id -un)" --property=Linger --value 2>/dev/null || echo no)" = "yes" ]; then
  ok "lingering is on for $(id -un)"
else
  bad "lingering is OFF for $(id -un). Nothing starts at boot. Fix: loginctl enable-linger $(id -un)"
fi

echo
echo "Units"
unit_state shadow-voicevox.service 1
unit_state shadow-prod.service 1
unit_state shadow-cloudflared.service 1
unit_state shadow-dashboard.service 0
unit_state shadow-dev.service 0

echo
echo "Local endpoints"
http "VOICEVOX" http://127.0.0.1:50021/version 1
http "prod backend" http://127.0.0.1:8030/health 1
http "QR dashboard" http://127.0.0.1:4599/ 0
http "dev backend" http://127.0.0.1:8020/health 0

echo
echo "Public endpoints, through cloudflared"
http "prod, what the TestFlight app calls" https://shadow.sean.build/shadow/health 1
http "dev, what Expo Go calls" https://dev.sean.build/shadow/health 0
http "QR dashboard" https://dev.sean.build/ 0

# The release the prod backend reports, next to what the prod worktree is
# checked out at. A mismatch means the unit is running an older process than
# the last deploy.
echo
echo "Release"
RUNNING="$(curl -s -m 5 http://127.0.0.1:8030/health 2>/dev/null \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("env","?"), d.get("release","?"))' 2>/dev/null || true)"
if [ -n "$RUNNING" ]; then
  ok "prod backend reports env=${RUNNING% *} release=${RUNNING#* }"
  if [ -d /home/sean/shadow-prod/app ]; then
    DEPLOYED="$(git -C /home/sean/shadow-prod/app rev-parse --short HEAD 2>/dev/null || true)"
    if [ -n "$DEPLOYED" ] && [ "$DEPLOYED" != "${RUNNING#* }" ]; then
      bad "prod worktree is at $DEPLOYED but the running process reports ${RUNNING#* }. Restart: systemctl --user restart shadow-prod"
    fi
  fi
else
  bad "prod backend did not report a release"
fi

# This machine has a public IP and no NAT. Every one of these ports must be on
# 127.0.0.1 and reachable only through cloudflared.
echo
echo "Bind addresses"
WIDE="$(ss -ltnH 2>/dev/null | awk '{print $4}' \
  | grep -E ':(8020|8030|4599|50021)$' | grep -v '^127\.0\.0\.1:' || true)"
if [ -n "$WIDE" ]; then
  bad "a shadowing app port is listening beyond localhost:"
  printf '        %s\n' $WIDE
else
  ok "8020, 8030, 4599 and 50021 are all on 127.0.0.1 or not listening"
fi

echo
if [ "$FAIL" = "0" ]; then
  echo "Chain is healthy."
else
  echo "Something above is down. Logs: journalctl --user -u <unit> -n 50 --no-pager"
fi
exit "$FAIL"
