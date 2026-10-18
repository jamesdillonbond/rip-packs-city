#!/bin/bash
# UserPromptSubmit hook: tell the session when origin/main has moved under it.
#
# Why this exists: session-start.sh syncs once, at the start. Sessions here run
# for hours while cloud sessions, Cowork and the night pass keep pushing to main,
# so by mid-afternoon a session is re-deriving or contradicting work that already
# shipped (2026-10-17: a local session opened 34 commits behind). This hook does a
# THROTTLED fetch (at most once per 10 min, 8 s cap) and, when origin/main is ahead
# of HEAD, prints the incoming commit subjects into the session's context.
#
# It NOTIFIES only — it never merges, so it cannot change files under an edit in
# progress. Pulling is the session's call. Never fails the prompt.
set -uo pipefail
cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0

stamp="$(git rev-parse --git-dir 2>/dev/null)/rpc-origin-drift-stamp"
now="$(date +%s)"
last="$(cat "$stamp" 2>/dev/null || echo 0)"
if [ $((now - ${last:-0})) -ge 600 ]; then
  echo "$now" > "$stamp" 2>/dev/null || true
  timeout 8 git fetch --quiet origin main 2>/dev/null || true
fi

behind="$(git rev-list --count HEAD..origin/main 2>/dev/null || echo 0)"
if [ "${behind:-0}" -gt 0 ]; then
  echo "[origin-drift] origin/main is $behind commit(s) ahead of this checkout — other sessions shipped while this one ran. Read them (and pull with 'git merge --ff-only origin/main' once your own edits are committed) before acting on anything they touch:"
  git log --format='  %h %ad %s' --date=format-local:'%m-%d %H:%M PT' HEAD..origin/main | head -15
fi
exit 0
