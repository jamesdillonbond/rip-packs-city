# Handoff 2026-06-19 — SECURITY: rotate INGEST_SECRET_TOKEN (exposed in a Cowork session)

Plain text. Priority/security item + a couple of small remaining threads.

## What happened

While editing the buyer-backfill cron schedule in the cron-job.org console, a DOM inspection on the job EDIT page (`querySelectorAll('input')`) read ALL inputs — including the Advanced-tab "Authorization" header field, which holds `Bearer <INGEST_SECRET_TOKEN>`. Even though the Advanced tab was never opened/clicked, its fields are present in the DOM, so the token VALUE surfaced in the Cowork tool output and is now in this session's context/logs.

Scope of exposure: the value appeared in an AI session transcript + harness logs. NOT posted publicly, NOT committed to the repo. But a secret that has left its vault should be treated as compromised.

## Recommendation: rotate INGEST_SECRET_TOKEN

It is the shared ingest/cron auth bearer, so the blast radius is wide. Everywhere it must change:
- Vercel env var `INGEST_SECRET_TOKEN` (ingest / cron / admin routes validate it) + redeploy. (Env writes via PowerShell Invoke-WebRequest per CLAUDE.md.)
- Supabase edge-function secret `INGEST_SECRET_TOKEN` (`supabase secrets set ...` — project-wide; every edge fn reads it, incl. the alerts/backfill/resolver fns).
- GitHub Actions repo secret `INGEST_SECRET_TOKEN` (rpc-pipeline.yml + the other ingest workflows source it).
- The `hybrid-custody-proxy` Cloudflare worker (`wrangler secret put INGEST_SECRET_TOKEN`) — it Bearer-auths with this token (worker auth surface (b) in CLAUDE.md).
- ALL cron-job.org entries whose Authorization header is `Bearer <INGEST_SECRET_TOKEN>` (~most of the ~69 entries). This is the biggest manual surface.

Note CRON_SECRET is a separate token (some routes accept either) — only INGEST_SECRET_TOKEN was exposed; CRON_SECRET does NOT need rotation unless you choose to.

### Zero-downtime sequence (recommended)

1. Generate a new strong token.
2. Code (CC): make the route/edge-fn/worker validators accept EITHER the old or the new token transitionally (add an `INGEST_SECRET_TOKEN_NEXT` env and check both). Deploy. Now both tokens work.
3. Update every CALLER to send the new token: cron-job.org Authorization headers, GHA repo secret, any internal callers.
4. Once all callers send the new token and pipeline_runs shows no 401s, remove the old token (drop the dual-accept, set `INGEST_SECRET_TOKEN` = new everywhere, delete `_NEXT`).
5. Verify: pipeline_runs keep logging ok (no auth 401 wave), /api/health 200, a smoke run passes.

If you accept a brief blip instead, you can swap the value everywhere within a short window and tolerate a few minutes of 401s on crons mid-update — simpler but noisier (the monitor will flag a 401 wave; that's expected during the cutover, not an incident).

## Prevention (skill note — I can't edit the read-only skill)

The rpc-cron-ops HARD RULE is "never OPEN the Advanced tab." That's insufficient: a broad DOM query reads the Advanced fields even when the tab isn't active. Extend the rule: on a job edit page, scope DOM reads to the schedule controls only (the crontab input + the minutes `<select>` with 60 options), and NEVER `querySelectorAll('input')` broadly. The safe schedule-edit recipe (focus the crontab input -> select() -> execCommand insertText -> verify the minutes grid -> click Save) does not require reading any other field.

## Other remaining threads (smaller)

- buyer-backfill cron: SLOWED to `4,34 * * * *` (every 30 min, off-rush) this session — verified persisted on a fresh load; ends the overlapping-run contention that was creeping toward the 800s cap. Optional defense-in-depth (CC): also cap rows-per-invocation in app/api/admin/backfill-topshot-buyers/route.ts so a single run can't run long regardless of cadence. Lower priority now.
- AllDay floor-serial backfill: the function is correct (request byte-identical to the working resolver) but blocked by the external AllDay consumer-GQL Cloudflare 1009 (datacenter-IP/region WAF ban). Fold into the open `allday-consumer-gql-403` infra item (region-resilient/residential egress fixes the resolver too). Leave the cron for opportunistic fills. LOW priority.
- Ledger: log this session's Cowork DB changes in docs/overnight/ledger.md with revert paths — `audit_20260618_pinnacle_editions_fix_double_encoded_mojibake`, `audit_20260618_allday_floor_ask_carry_listing_ids`, and the `alert_subscriptions` test row (id 1bbb8a0d-9373-49bc-aad0-4f9b2d37c5fa) — none were entered from Cowork (large-file truncation hazard).
- Test alert sub: still broad/instant (Trevor's preference to tune or delete at /alerts).

## Guardrails

main only; PowerShell git; env writes via PowerShell Invoke-WebRequest; never echo the token in commits/logs; sequence the rotation to avoid an auth-gap.
