# Handoff 2026-07-07 — Activate + verify the conversational bot concierge (env flag, local sync, stale token)

## Context

All code is ALREADY SHIPPED AND LIVE by Cowork today — commits `d07ed2f` (conversational concierge over Telegram + Discord DM) and `a30c790` (trusted-bot header accepts CRON_SECRET), both deploys READY on prod; Discord `/ask` registered globally (`["link","soldpacks","alerts","ask"]`). The trusted-bot path was smoke-verified end-to-end on prod (session `tg:cowork-smoke-2`: identity + cross-message memory both confirmed; rows flagged `is_smoke_test`). Ledger entry: `docs/overnight/ledger.md` § "2026-07-07 (Cowork interactive) — conversational concierge over Telegram + Discord DM".

This handoff is ONLY the local-environment items Cowork can't reach: one Vercel env flag, local working-copy sync, and a stale local secret file. No route/`.tsx` code changes are in scope.

Claude Code's direct file inspection wins over this doc and over `project_knowledge_search` on any disagreement — adapt to the actual file shape.

## Item 1 (the only blocker) — set `ALERTS_BOT_CONCIERGE=1` in Vercel prod + redeploy

- **Why:** Both the Telegram free-text branch (`app/api/bots/telegram/route.ts`, `conciergeEnabled()` gate) and Discord `/ask` (`app/api/bots/discord/route.ts`) no-op unless `ALERTS_BOT_CONCIERGE === "1"` (`lib/alerts/concierge-bridge.ts`). The 2026-06-17 ledger entry records it as "inert until ALERTS_BOT_CONCIERGE=1" and nothing since records setting it — verify first; it is very likely unset.
- **How:** Vercel MCP tools are READ-ONLY for env vars. Check whether it exists, then write via PowerShell `Invoke-WebRequest` (NOT curl in Git Bash — fails silently):

```powershell
$h = @{ Authorization = "Bearer $env:VERCEL_TOKEN" }
# create (POST v10) — target production
Invoke-WebRequest -Method POST -Headers $h -ContentType "application/json" `
  -Uri "https://api.vercel.com/v10/projects/prj_YBJ6Utl32GfyBOIzbsp3kbshJh96/env?teamId=team_YWGCVToPBJSS60NgVh8jiCFV" `
  -Body '{"key":"ALERTS_BOT_CONCIERGE","value":"1","type":"encrypted","target":["production"]}'
```

- **Then REDEPLOY** — env changes don't take effect until a fresh build (dashboard "Redeploy" reuses cache; use the REST deployments POST with gitSource ref `main`, per CLAUDE.md "Vercel tool behavior").
- **Revert:** DELETE the env var via the same API + redeploy.
- **Verify:** DM the Telegram bot free text (expect a conversational reply + "typing…" indicator, and a follow-up message that references the first — that's the new server-side memory). In Discord, `/ask question: what's my best moment worth?` from the linked account (expect a personalized deferred reply). `/help` on Telegram should now include the "Just type a question…" line (it's conditional on the gate).

## Item 2 — sync the local working copy

The working tree already contains the pushed file contents (Cowork edited locally AND pushed the same bytes from a sandbox clone), so `git status` shows modified files whose content equals `origin/main`. Sync:

```powershell
git fetch origin
git checkout -- app/api/support-chat/route.ts app/api/bots/telegram/route.ts app/api/bots/discord/route.ts lib/alerts/concierge-bridge.ts lib/alerts/discord-commands.ts
git pull origin main
git rev-list --count origin/main..HEAD   # expect 0
```

Safe because the discarded local edits are byte-identical to what the pull brings back (verified: every patch hunk applied to the clone matched the local file content exactly once).

## Item 3 — refresh the stale local `.env.production` INGEST token

- **Finding (verified live):** `.env.production` line 9 `INGEST_SECRET_TOKEN` (file dated May 12) no longer matches the live Vercel `INGEST_SECRET_TOKEN` — it 401s on the INGEST-only route `/api/admin/prune-pipeline-runs` but passes `/api/bots/discord/register` and the proxy bypass, meaning it now equals live `CRON_SECRET`. Any local script sourcing this file and hitting an INGEST-only route will 401 confusingly.
- **Fix:** copy the current INGEST value from wherever you keep it (it's Sensitive in Vercel, so not readable back via API/dashboard) into `.env.production` (and check `.env.local` line 13 while at it). No commit — both files are gitignored.
- **This is why `a30c790` exists:** the trusted-bot check originally accepted INGEST only and the smoke probe (keyed by this stale=CRON token) exposed the single-secret brittleness; it now accepts either, matching the register/cron/proxy convention.

## Item 4 (optional, when convenient) — commit this handoff

This file is untracked locally; commit it to `main` after the pull in Item 2 so the record lands in the repo (docs-only commits auto-CANCEL the Vercel build via the ignoreCommand — expected, not an error).

## Guardrails

- Direct-to-`main`, no branches, no PRs. If a `claude/*` branch is pre-checked-out, switch to `main` first.
- Commit via PowerShell `git` (Git Bash `git commit` can silently no-op); re-verify with `git rev-list --count origin/main..HEAD` (expect 0).
- `curl` fails silently in Git Bash for Vercel REST — PowerShell `Invoke-WebRequest` only.
- No `maxDuration` changes in scope (the routes were set to 60, far under the 800s Pro cap).
- Never echo secret values into logs/output while doing Items 1/3.

## End state

`ALERTS_BOT_CONCIERGE=1` live in prod + redeployed (deploy READY); a Telegram DM and a Discord `/ask` each return a personalized, memory-aware conversational reply; local working copy clean at `origin/main`; local `.env.production` INGEST token matches live.

---

## Resolution (2026-07-07, Claude Code)

- **Item 1 (env flag) — ALREADY DONE, no action taken.** `ALERTS_BOT_CONCIERGE` was already `=1` in Vercel production, set **2026-06-18 00:12 UTC** (weeks ago, not unset as the handoff assumed). The current READY production deployment `6dfdac4` (built 2026-07-07 22:54 UTC) is newer than both the flag and the concierge commits (`a30c790`), so the flag is baked into live production. No env write and no redeploy were required. (The 22:58 UTC `8424901` deploy is CANCELED — a docs-only commit auto-cancelled by the ignoreCommand — so it did not supersede `6dfdac4`.)
- **Item 2 (local sync) — DONE.** Working tree reset to `origin/main`; `git rev-list --count origin/main..HEAD` = 0. Confirmed the 4 big files were byte-identical to origin before the reset (`git diff --numstat origin/main` empty); the only local delta was a reworded comment in `telegram/route.ts`, discarded. Tree clean apart from the two expected untracked docs.
- **Item 3 (stale local INGEST token) — CONFIRMED, operator-only.** Verified `.env.production` `INGEST_SECRET_TOKEN` currently equals the live `CRON_SECRET` (stale). `INGEST_SECRET_TOKEN` is a **sensitive** Vercel var (unreadable via API), so the true value can't be self-fetched — Trevor must paste the current INGEST value into `.env.production`. Local-dev convenience only; zero production impact. `.env.local` does not carry an INGEST token (matches the "blank locally" memory).
- **Remaining human verification:** DM the Telegram bot free text and run Discord `/ask` from the linked account to confirm the personalized, memory-aware replies — these require Trevor's own Telegram/Discord accounts and can't be driven from here. Cowork already smoke-verified the trusted-bot path on prod.
