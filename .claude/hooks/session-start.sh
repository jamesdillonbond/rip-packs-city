#!/bin/bash
# SessionStart hook: keep local `main` continuously synced with origin/main.
#
# Why this exists: web sessions clone this repo SHALLOW and start on a fresh
# claude/* branch, so the local `main` ref goes stale and — because the true
# common ancestor sits below the shallow horizon — git falsely reports `main`
# as "N ahead / N behind" origin/main when it is only behind. This hook kills
# both problems every session: it deepens the clone so relationships compute
# correctly, then fast-forwards local `main` to origin/main (--ff-only, so it
# can NEVER clobber real unpushed commits) and checks it out.
#
# Provisioning also sometimes seeds a re-hashed MIRROR of `main`: thousands of
# commits with identical messages under different SHAs, frozen days behind. That
# is never fast-forwardable, so `is_mirror_lineage` recognises it and realigns to
# origin/main (see that function for the safety argument). The realign is the
# fallback ONLY — real unpushed work always fast-forwards or is left as-is.
#
# Runs synchronously (git sync is fast) so `main` is ready before the agent loop.
set -uo pipefail

# Web (remote) sessions only — local dev clones manage their own git.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

# Is local `main` a provisioning MIRROR of origin/main that is safe to force-
# realign (carries no work worth keeping), rather than a genuine branch-off?
#
# Purge-proof: this deliberately does NOT compare the root commit SHA. The old
# gate keyed on `merge-base == origin's root`, which the 2026-08-03 `git
# filter-repo` history purge silently defeated — it re-hashed origin's root, so a
# frozen pre-purge mirror now shares only a deeper non-root ancestor and the gate
# stopped firing (the exact failure that stranded local `main` days behind). Two
# purge-proof signals instead, either sufficient:
#   A) Provably LOSSLESS — no local commit is unique by patch-id (`git cherry`
#      prints no '+' lines): every local commit already exists on origin under
#      some SHA. A clean re-hash matches here.
#   B) Mirror-SHAPED magnitude backstop — on a "commit directly to main" repo
#      genuine unpushed work is a handful of commits; hundreds+ is only ever the
#      frozen mirror. This catches the case where the purge leaves a few orphaned
#      '+' patches (the stripped commits) so signal A alone misses.
# Callers additionally require a clean tree before any `reset --hard`, so no
# in-progress edit is ever lost, and a genuine small branch-off satisfies neither
# signal and is left untouched.
MIRROR_MIN_AHEAD=100
is_mirror_lineage() {
  local ahead unique
  ahead="$(git rev-list --count origin/main..main 2>/dev/null)"
  unique="$(git cherry origin/main main 2>/dev/null | grep -c '^+')"
  # A) lossless: local commits exist, none unique by patch-id.
  if [ "${unique:-1}" -eq 0 ] && [ "${ahead:-0}" -gt 0 ]; then
    return 0
  fi
  # B) magnitude: mirror-shaped divergence, never real unpushed work here.
  if [ "${ahead:-0}" -ge "$MIRROR_MIN_AHEAD" ]; then
    return 0
  fi
  return 1
}

# 1) Deepen a shallow clone so branch relationships are truthful.
if [ "$(git rev-parse --is-shallow-repository 2>/dev/null)" = "true" ]; then
  git fetch --unshallow origin 2>/dev/null \
    || git fetch --depth=2000 origin 2>/dev/null \
    || true
fi

# 2) Refresh origin/main.
git fetch origin main 2>/dev/null || true

if git rev-parse --verify --quiet origin/main >/dev/null; then
  short="$(git rev-parse --short origin/main)"
  cur="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"

  if [ "$cur" = "main" ]; then
    # 3a) Already on main — a plain ff-only merge is the safe update. It refuses
    #     any non-fast-forward, so genuine unpushed commits are never discarded.
    if git merge --ff-only origin/main 2>/dev/null; then
      echo "[session-start] main up to date with origin/main ($short)"
    elif is_mirror_lineage \
      && [ -z "$(git status --porcelain)" ] \
      && git reset --hard origin/main 2>/dev/null; then
      # Not fast-forwardable AND a mirror lineage (see is_mirror_lineage): a
      # re-hashed web-provisioning artifact, not genuine unpushed work — it
      # carries nothing that isn't already on origin, yet its thousands of
      # "ahead" commits make the Stop hook nag "N unpushed commits" every turn.
      # Gated on a clean tree so no in-progress edit is ever lost.
      echo "[session-start] realigned divergent mirror lineage of main to origin/main ($short)"
    else
      echo "[session-start] NOTE: local main has commits not on origin/main — left as-is (no data loss). Push them to reconcile."
    fi
  elif git show-ref --verify --quiet refs/heads/main; then
    # 3b) Not on main — fast-forward the main ref in place. `git fetch . src:dst`
    #     refuses non-fast-forward updates, so unpushed main commits are preserved.
    if git fetch . origin/main:main 2>/dev/null; then
      echo "[session-start] local main fast-forwarded to origin/main ($short)"
    elif is_mirror_lineage && git branch -f main origin/main 2>/dev/null; then
      # Same mirror-lineage artifact as 3a, but main isn't checked out — so
      # force-update the ref directly (no working tree to disturb).
      echo "[session-start] realigned divergent mirror lineage of main to origin/main ($short)"
    else
      echo "[session-start] NOTE: local main has commits not on origin/main — left as-is (no data loss). Push them to reconcile."
    fi
  else
    git branch main origin/main 2>/dev/null || true
    echo "[session-start] created local main at origin/main ($short)"
  fi

  # 4) Check out main (CLAUDE.md: always work on main) when the tree is clean.
  if [ "$cur" != "main" ]; then
    if [ -z "$(git status --porcelain)" ]; then
      if git checkout main 2>/dev/null; then
        git merge --ff-only origin/main 2>/dev/null || true
        echo "[session-start] checked out main"
      fi
    else
      echo "[session-start] working tree dirty — staying on '$cur' (not switching to main)"
    fi
  fi
fi

exit 0
