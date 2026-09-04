#!/bin/bash
# OpenMuse self-update worker.
#
# Launched detached from the app server (spawn + unref), so it outlives the
# app itself: it rebuilds the desktop bundle from a local repo checkout,
# then quits the running app, swaps /Applications/OpenMuse.app, and
# relaunches. Every step is logged; machine-readable progress goes to the
# status file the UI polls.
#
# Required env: REPO (repo checkout), NPM_BIN (npm binary),
# STATUS_FILE (json), LOG_FILE (text). Optional: PORT (default 3101).
set -u

APP_NAME="OpenMuse"
PORT="${PORT:-3101}"

phase() {
  printf '{"phase":"%s","ok":false,"repo":"%s"}\n' "$1" "$REPO" >"$STATUS_FILE"
  echo "== $1 ==" >>"$LOG_FILE"
}

jesc() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr '\n' ' '
}

fail() {
  printf '{"phase":"failed","ok":false,"error":"%s"}\n' "$(jesc "$1")" >"$STATUS_FILE"
  echo "FAILED: $1" >>"$LOG_FILE"
  exit 1
}

note_done() {
  printf '{"phase":"done","ok":true,"note":"%s"}\n' "$(jesc "$1")" >"$STATUS_FILE"
  echo "DONE: $1" >>"$LOG_FILE"
  exit 0
}

[ -n "${REPO:-}" ] || { echo "REPO unset" >"$STATUS_FILE"; exit 1; }
[ -n "${NPM_BIN:-}" ] || fail "npm binary unset"
[ -n "${STATUS_FILE:-}" ] || exit 1
[ -n "${LOG_FILE:-}" ] || exit 1

exec >>"$LOG_FILE" 2>&1
echo "self-update started: repo=$REPO npm=$NPM_BIN"

# NOTE: never replace PATH wholesale here. This script is launched from the
# app server, whose PATH provably resolves the `muse` binary — and `open -a`
# below propagates our environment to the relaunched app. Clobbering PATH
# would leave the new app unable to spawn `muse` (ENOENT). Keep the inherited
# PATH and only prepend the usual user/machine locations as fallback.
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:$PATH:/usr/bin:/bin:/usr/sbin:/sbin"
[ -x "$NPM_BIN" ] || fail "npm not executable: $NPM_BIN"
cd "$REPO" || fail "cannot cd to repo: $REPO"
[ -f package.json ] || fail "no package.json in $REPO"

phase "install-deps"
for d in server web electron; do
  if [ ! -d "$d/node_modules" ]; then
    echo "installing $d dependencies…"
    "$NPM_BIN" --prefix "$d" install --no-audit --no-fund || fail "dependency install failed in $d"
  fi
done

phase "build"
"$NPM_BIN" run dist || fail "build failed"

DMG="$REPO/electron/dist/OpenMuse-0.1.0-arm64.dmg"
[ -f "$DMG" ] || DMG="$REPO/electron/dist/OpenMuse-0.1.0.dmg"
[ -f "$DMG" ] || fail "build produced no dmg"

APP_RUNNING=0
if pgrep -f "OpenMuse.app/Contents" >/dev/null 2>&1; then
  APP_RUNNING=1
  phase "quit-app"
  osascript -e 'quit app "OpenMuse"' 2>/dev/null || true
  for _ in $(seq 1 30); do
    pgrep -f "OpenMuse.app/Contents" >/dev/null 2>&1 || break
    sleep 1
  done
  pkill -f "OpenMuse.app/Contents" 2>/dev/null || true
  sleep 1
fi

phase "swap"
MNT="$(mktemp -d /tmp/openmuse-upd.XXXXXX)" || fail "cannot make temp dir"
hdiutil attach "$DMG" -nobrowse -mountpoint "$MNT" || fail "could not mount installer"
rm -rf "/Applications/$APP_NAME.app" || { hdiutil detach "$MNT" 2>/dev/null || true; fail "could not remove old app"; }
ditto "$MNT/$APP_NAME.app" "/Applications/$APP_NAME.app" || { hdiutil detach "$MNT" 2>/dev/null || true; fail "copy failed"; }
hdiutil detach "$MNT" 2>/dev/null || true
rmdir "$MNT" 2>/dev/null || true
test ! -e "/Applications/$APP_NAME.app/$APP_NAME.app" || fail "nested copy detected, install aborted"

if [ "$APP_RUNNING" = "1" ]; then
  phase "relaunch"
  open -a "$APP_NAME" || fail "relaunch failed"
  note_done "app rebuilt, reinstalled, and relaunched"
else
  note_done "bundle swapped (app was not running, so it was not relaunched)"
fi
