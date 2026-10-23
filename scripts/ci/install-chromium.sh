#!/usr/bin/env bash
# scripts/ci/install-chromium.sh — install Playwright's Chromium + its OS packages on a
# GitHub runner, BOUNDED and genuinely RETRIED.
#
# WHY (2026-10-23). `npx playwright install --with-deps chromium` apt-installs OS packages
# from the runner's Azure Ubuntu mirror, and that download can STALL with no timeout of
# its own: four E2E DOM Smoke runs on 10-23 (5:10, 6:39, 10:48 AM and 2:41 PM PT) sat on
# `Get: fonts-wqy-zenhei` / `xvfb` from azure.archive.ubuntu.com. The 11:35 AM fix wrapped
# the install in `timeout 240` and looped three times — and the 2:41 PM run showed why that
# was not a retry: `timeout` kills `npx`, not the `sudo apt-get` it spawned, so the orphaned
# apt-get kept /var/lib/dpkg/lock-frontend and attempts 2 and 3 failed in 2 s each on the
# lock ("held by process 2654"). Three attempts, one real.
#
# WHAT THIS DOES, per attempt (3 by default):
#   1. runs the install under `timeout -k 15 <secs>`;
#   2. on failure or expiry, kills any apt-get / dpkg left behind (they are the only ones on
#      a runner), waits — bounded — for the dpkg lock to be released, and repairs dpkg;
#   3. from the second attempt on, switches apt from the Azure mirror to archive.ubuntu.com,
#      because four stalls in one day on one mirror are the mirror, not the network.
# It exits 0 the moment an attempt succeeds and 1 after the last one fails, with a
# ::warning:: per failed attempt and a ::error:: at the end — never a silent `cancelled`.
#
# Knobs (for the self-test and for a workflow that wants a longer bound):
#   PW_INSTALL_CMD        the install command (default: npx playwright install --with-deps chromium)
#   INSTALL_TIMEOUT_SECS  per-attempt bound (default 240)
#   INSTALL_ATTEMPTS      attempts (default 3)
#   CI_INSTALL_NO_MIRROR_SWITCH=1  keep the mirror as it is (the self-test)
#
# ⚠ `set -e` is deliberately OFF: every fallible step here is a probe whose failure is the
# point (CLAUDE.md, "CI run: is bash -e: a fallible ASSIGNMENT aborts the step").
set -uo pipefail

PW_INSTALL_CMD="${PW_INSTALL_CMD:-npx playwright install --with-deps chromium}"
LIMIT="${INSTALL_TIMEOUT_SECS:-240}"
ATTEMPTS="${INSTALL_ATTEMPTS:-3}"
SUDO=""
if [ "$(id -u)" != "0" ] && command -v sudo >/dev/null 2>&1; then SUDO="sudo"; fi

# apt gives up on a stalled transfer after 30 s and retries it, instead of hanging.
if [ -d /etc/apt/apt.conf.d ] && [ -w /etc/apt/apt.conf.d -o -n "$SUDO" ]; then
  echo 'Acquire::Retries "5"; Acquire::http::Timeout "30"; Acquire::https::Timeout "30";' \
    | $SUDO tee /etc/apt/apt.conf.d/80-rpc-ci-retries >/dev/null 2>&1 || true
fi

release_dpkg_lock() {
  # Kill what the expired attempt left behind, then wait (bounded) for the lock to go.
  $SUDO pkill -TERM -x apt-get 2>/dev/null || true
  $SUDO pkill -TERM -x dpkg 2>/dev/null || true
  sleep 3
  $SUDO pkill -KILL -x apt-get 2>/dev/null || true
  $SUDO pkill -KILL -x dpkg 2>/dev/null || true
  local waited=0
  while [ "$waited" -lt 60 ] && [ -e /var/lib/dpkg/lock-frontend ] \
        && $SUDO fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; do
    sleep 2; waited=$((waited + 2))
  done
  if [ "$waited" -ge 60 ]; then
    echo "::warning::dpkg lock still held after 60 s; the next attempt will likely fail on it"
  fi
  $SUDO dpkg --configure -a >/dev/null 2>&1 || true
}

switch_mirror() {
  [ "${CI_INSTALL_NO_MIRROR_SWITCH:-0}" = "1" ] && return 0
  local f changed=0
  for f in /etc/apt/sources.list /etc/apt/sources.list.d/ubuntu.sources; do
    if [ -f "$f" ] && grep -q 'azure.archive.ubuntu.com' "$f" 2>/dev/null; then
      $SUDO sed -i 's#azure\.archive\.ubuntu\.com#archive.ubuntu.com#g' "$f" && changed=1
    fi
  done
  if [ "$changed" = "1" ]; then
    echo "::warning::apt mirror switched from azure.archive.ubuntu.com to archive.ubuntu.com for the retry"
  fi
}

attempt=1
while [ "$attempt" -le "$ATTEMPTS" ]; do
  if [ "$attempt" -gt 1 ]; then switch_mirror; fi
  echo "install-chromium: attempt $attempt of $ATTEMPTS (bound ${LIMIT}s): $PW_INSTALL_CMD"
  # shellcheck disable=SC2086
  timeout -k 15 "$LIMIT" $PW_INSTALL_CMD
  rc=$?
  if [ "$rc" = "0" ]; then
    echo "install-chromium: ok on attempt $attempt"
    exit 0
  fi
  if [ "$rc" = "124" ] || [ "$rc" = "137" ]; then
    echo "::warning::playwright install attempt $attempt exceeded ${LIMIT}s (stalled apt download?); cleaning up and retrying"
  else
    echo "::warning::playwright install attempt $attempt failed (exit $rc); cleaning up and retrying"
  fi
  release_dpkg_lock
  attempt=$((attempt + 1))
done
echo "::error::playwright install failed $ATTEMPTS times"
exit 1
