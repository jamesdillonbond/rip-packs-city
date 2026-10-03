#!/usr/bin/env bash
# scripts/ci/page-via-github-issue.sh — page the repo owner from a GitHub Actions
# runner using NOTHING but the workflow's own GITHUB_TOKEN (register R77,
# 2026-10-03).
#
# WHY. The runner-side Telegram pages in pipeline-sentinel.yml and
# site-availability-alarm.yml need TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID as
# GitHub secrets. They are not set (the bot token lives only in Vercel env, the
# plane that disappears in the outage), the Actions secrets API is closed to
# the autonomous sessions, and a token must never pass through a transcript —
# so until a human adds them, "page from the runner" was a warning in a log
# nobody reads. GitHub itself is a pager that needs no new secret: an issue
# that @-mentions the repository owner is delivered by GitHub's own
# notification plane (email / app), independent of Vercel and Supabase.
#
# CONTRACT
#   env PAGE_TITLE   exact issue title; the dedupe key (one OPEN issue per title)
#   env PAGE_BODY    bounded text composed by the caller — only digits, markers
#                    and this repo's own strings; never a span of an upstream
#                    error page (same rule as the Telegram steps)
#   env PAGE_LABEL   optional, default "pager"
#   env GH_TOKEN     the workflow's GITHUB_TOKEN (needs `issues: write`)
#   env GITHUB_REPOSITORY, GITHUB_REPOSITORY_OWNER, GITHUB_SERVER_URL, GITHUB_RUN_ID
#
#   An OPEN issue with exactly PAGE_TITLE and the label → a new COMMENT on it
#   (the thread stays one issue per condition; each tick is a dated comment).
#   None → a new issue. The body always @-mentions the owner so GitHub notifies
#   even if the repo is not watched.
#
# ⛔ NEVER CHANGES THE JOB'S RESULT. The job is red (or not) for its own
# reason; a pager failing must not mask or replace that. Every command is
# guarded and the script exits 0 on every path, saying what it did or could
# not do with ::warning::.
set -u

if [ -z "${PAGE_TITLE:-}" ] || [ -z "${PAGE_BODY:-}" ]; then
  echo "::warning::page-via-github-issue: PAGE_TITLE / PAGE_BODY not set — nothing paged."
  exit 0
fi
if [ -z "${GH_TOKEN:-}" ]; then
  echo "::warning::page-via-github-issue: GH_TOKEN not set — nothing paged."
  exit 0
fi

LABEL="${PAGE_LABEL:-pager}"
REPO="${GITHUB_REPOSITORY:-}"
OWNER="${GITHUB_REPOSITORY_OWNER:-}"
RUN_URL="${GITHUB_SERVER_URL:-https://github.com}/${REPO}/actions/runs/${GITHUB_RUN_ID:-0}"
WHEN=$(TZ=America/Los_Angeles date '+%b %-d %-I:%M %p PT') || WHEN="unknown time"

MENTION=""
if [ -n "$OWNER" ]; then MENTION="@${OWNER} "; fi
BODY="${MENTION}${PAGE_BODY}

${WHEN} · sent from GitHub Actions with the workflow's own token — independent of Vercel and Supabase. Run: ${RUN_URL}"

# The label may not exist yet; creating it is idempotent and its failure is not ours to surface loudly.
gh label create "$LABEL" --repo "$REPO" --color B60205 --description "Runner-side page (register R77): the estate's own alarms could not run" >/dev/null 2>&1 || true

# Exact-title match among OPEN issues carrying the label. `--search` is fuzzy, so the title is re-checked here.
EXISTING=$(gh issue list --repo "$REPO" --state open --label "$LABEL" --limit 50 --json number,title \
  --jq --arg t "$PAGE_TITLE" '[.[] | select(.title == $t)] | .[0].number // empty' 2>/dev/null) || EXISTING=""

if [ -n "$EXISTING" ]; then
  if gh issue comment "$EXISTING" --repo "$REPO" --body "$BODY" >/dev/null 2>&1; then
    echo "paged via GitHub issue #${EXISTING} (comment)"
  else
    echo "::warning::page-via-github-issue: could not comment on issue #${EXISTING} — the page is in this log only."
  fi
  exit 0
fi

if URL=$(gh issue create --repo "$REPO" --title "$PAGE_TITLE" --body "$BODY" --label "$LABEL" 2>/dev/null); then
  echo "paged via new GitHub issue ${URL}"
else
  echo "::warning::page-via-github-issue: could not create the issue (does the workflow grant issues: write?) — the page is in this log only."
fi
exit 0
