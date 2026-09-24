#!/usr/bin/env bash
# Vercel "Ignored Build Step" — exit 0 IGNORES the build, exit 1 PROCEEDS.
#
# ⛔ THIS LIVES IN A FILE BECAUSE `vercel.json`'s `ignoreCommand` IS CAPPED AT
# 256 CHARACTERS and the inline version of this logic is longer. The cap is a
# schema validation error, not a warning: an over-long `ignoreCommand` makes
# Vercel reject the WHOLE file — `crons` included — and every deployment errors
# until it is fixed. Measured 2026-09-12 (#97). Keep the logic here; keep
# `ignoreCommand` a one-liner that calls it.
#
# ── WHY THE BASE IS NOT `HEAD^` ─────────────────────────────────────────────
# Vercel builds the PUSH, not each commit, so this runs once against the tip.
# With `HEAD^`, a docs-only tip skipped the build AND TOOK EVERY CODE COMMIT
# UNDERNEATH IT DOWN WITH IT — green CI, a real deployment row, nothing live.
# That bit three times (CLAUDE.md records the first two; #97 the third, which
# ate a sentinel change).
#
# `VERCEL_GIT_PREVIOUS_SHA` is the sha of the LAST SUCCESSFUL DEPLOYMENT, and is
# exposed precisely when an Ignored Build Step is configured. Using it asks the
# question this gate always meant to ask — *has anything non-docs changed since
# what is actually live* — which is push-shape-independent and also correct for a
# skipped build, a reverted deployment, or several pushes landing between builds.
#
# ⚠ A long red streak WIDENS the window rather than narrowing it, because the
# base stays at the last SUCCESSFUL deploy. That is the safe direction; a large
# post-outage build is not a bug.
#
# ⛔ UNKNOWN BASE ⇒ FALL BACK TO `HEAD^`, NEVER TO "SKIP". The variable is empty
# on a first deployment and the sha can be missing from Vercel's shallow clone.
# The cost of guessing wrong here is shipping nothing, silently.
#
# ⚠ The exclusions below are pinned against CI's classifier by
# __tests__/deploy-and-ci-agree-on-what-docs-means.test.ts. If CI's set is WIDER,
# a push skips its code jobs and still deploys — untested code in production.
# Change both or neither.
#
# ── THE THREE NON-DEPLOYABLE SUBTREES (#61, decided 2026-09-23) ──────────────
# `supabase/migrations/**`, `supabase/tests/**` and `.github/**` are excluded
# HERE BUT NOT IN CI, on purpose. None of them is part of the Next.js build:
# every file in them is .sql/.yml (no .ts for tsc or the bundler), and nothing
# in app/, lib/, components/ or proxy.ts imports them (only comments name them).
# A migration is applied to the DB by `apply_migration`, never by a Vercel build;
# a workflow runs on GitHub. So a push touching only these changes NOTHING that
# Vercel would ship — the rebuild was pure build-minutes.
# ⭐ This is only safe BECAUSE the base is VERCEL_GIT_PREVIOUS_SHA: the next
# push that does touch deployable code diffs against what is actually live, so
# nothing underneath a skipped push is ever lost (the HEAD^ trap above).
# CI must still RUN its code jobs on these paths (parity, DB-invariant suite,
# workflow lint) — hence the asymmetry, which the agreement test pins by name.
set -u

# Dependabot previews are not worth a build.
if [ "${VERCEL_ENV:-}" = "preview" ]; then
  case "${VERCEL_GIT_COMMIT_REF:-}" in
    dependabot/*) exit 0 ;;
  esac
fi

base="${VERCEL_GIT_PREVIOUS_SHA:-}"
if [ -z "$base" ] || ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
  base="HEAD^"
fi

git diff --quiet "$base" HEAD -- . ':(exclude)docs/**' ':(exclude)*.md' ':(exclude)*.mdx' \
  ':(exclude)supabase/migrations/**' ':(exclude)supabase/tests/**' ':(exclude).github/**'
