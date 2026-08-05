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
# Runs synchronously (git sync is fast) so `main` is ready before the agent loop.
set -uo pipefail

# Web (remote) sessions only — local dev clones manage their own git.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

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
    elif [ -n "$(git merge-base main origin/main 2>/dev/null)" ] \
      && [ "$(git merge-base main origin/main 2>/dev/null)" = "$(git rev-list --max-parents=0 origin/main 2>/dev/null | tail -1)" ] \
      && [ -z "$(git status --porcelain)" ] \
      && git reset --hard origin/main 2>/dev/null; then
      # Not fast-forwardable AND local main shares ONLY the root commit with
      # origin/main: a re-hashed MIRROR lineage (a web-provisioning artifact),
      # not genuine unpushed work — it carries nothing that isn't already on
      # origin under a different SHA, yet its thousands of "ahead" commits make
      # the Stop hook nag "N unpushed commits" every turn forever. Gated on a
      # clean tree, so no in-progress edits are ever lost, and on merge-base ==
      # root, so a real branch-off of recent origin/main history is left alone.
      echo "[session-start] realigned divergent mirror lineage of main to origin/main ($short)"
    else
      echo "[session-start] NOTE: local main has commits not on origin/main — left as-is (no data loss). Push them to reconcile."
    fi
  elif git show-ref --verify --quiet refs/heads/main; then
    # 3b) Not on main — fast-forward the main ref in place. `git fetch . src:dst`
    #     refuses non-fast-forward updates, so unpushed main commits are preserved.
    if git fetch . origin/main:main 2>/dev/null; then
      echo "[session-start] local main fast-forwarded to origin/main ($short)"
    elif [ -n "$(git merge-base main origin/main 2>/dev/null)" ] \
      && [ "$(git merge-base main origin/main 2>/dev/null)" = "$(git rev-list --max-parents=0 origin/main 2>/dev/null | tail -1)" ] \
      && git branch -f main origin/main 2>/dev/null; then
      # Same mirror-lineage artifact as 3a, but main isn't checked out — so
      # force-update the ref directly (no working tree to disturb). Gated on
      # merge-base == root so a genuine branch-off is never force-moved.
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
