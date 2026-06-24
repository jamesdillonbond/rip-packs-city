# Handoff — wire the AllDay sales-history-backfill cron (2 min)

**Context.** The route `app/api/cron/allday-sales-history-backfill/route.ts` is live (commit `47e83e4`, READY) but **inert — no trigger wired**. It needs a low-cadence cron to drain the 2025-12-29 → 2026-04-16 window (~11.3M blocks of un-indexed AllDay native + Flowty secondary sales) into `sales` so moment pages show deep Recent Sales. Cowork shipped the monitoring queue (`allday_sales_history_backfill_targets`, 2,295 zero-sale editions) but **cannot wire the cron itself**: cron-job.org has no clone feature, so it would require typing the INGEST token into the auth field — a credential-entry action Cowork is not permitted to do. Pick either path below.

## Route behavior (so you configure it right)
- **Synchronous, `maxDuration=300`, self-budgets to ~200s** (mirrors `topshot-sales-history-backfill`, which runs 62/62 ok at ~97s avg / 280s max, ~2.6h cadence). cron-job.org's 30s client timeout WILL fire, but the Vercel function runs to completion server-side and logs `ok=true` to `pipeline_runs` — **the dashboard "timeout" is cosmetic; `pipeline_runs` is the real signal** (same as the TS-history backfill).
- Walks backward from block 148,653,524 under cursor `allday_sales_v1_backfill`; stops + reports `reached_spork_floor` at ~137,390,146 (deeper history = separate spork-proxy workstream).
- Auth: `Authorization: Bearer <INGEST_SECRET_TOKEN>` (or `?token=`). `dryRun=true` returns a sample, writes nothing. Disable via `ALLDAY_SALES_HISTORY_BACKFILL_DISABLED=1`.

## Path A — Vercel cron (PREFERRED; no secret handling, mirrors the 2026-06-21 drain-cron precedent)
1. **Route (1 line):** make the auth check also accept `CRON_SECRET` (Vercel injects `Authorization: Bearer ${CRON_SECRET}` on cron calls; the route currently accepts only `INGEST_SECRET_TOKEN`). Match the pattern other `/api/cron/*` routes use (accept either INGEST or CRON_SECRET).
2. **`vercel.json` crons:** add `{ "path": "/api/cron/allday-sales-history-backfill", "schedule": "7 */3 * * *" }` (every 3h at :07 — off the :00/:20/:40 rush). `maxDuration=300` ≤ the 800 Pro cap. The docs-only `ignoreCommand` must let this deploy register the cron (it's a code+config change, so it will).
3. Deploy → Vercel fires it automatically, no token ever typed.

## Path B — cron-job.org (operator, ~1 min in your own session)
Create a cronjob (or clone a healthy INGEST-Bearer `www.rippackscity.com/api` job if you have one):
- **URL:** `https://www.rippackscity.com/api/cron/allday-sales-history-backfill` (the `www.` host — the apex 308 strips the Authorization header).
- **Auth (Advanced tab):** `Authorization: Bearer <INGEST_SECRET_TOKEN>` — never `?token=` (leaks into history).
- **Schedule:** off-rush, ~every 2-3h. Pick an empty comma-trio from `docs/operations/cron-schedule.md` (NOT minutes 0/1/20/21/40/41).
- Expect "failed (timeout)" on the dashboard every run — that's the 30s cap vs the ~200s route; confirm success in `pipeline_runs`, not the dashboard.

## Before going live (your step #1): dry-run
`curl -H "Authorization: Bearer $INGEST_SECRET_TOKEN" "https://www.rippackscity.com/api/cron/allday-sales-history-backfill?dryRun=true"` → returns `{ found, counters, sample:[{src,nft,date,price,certain,buyer,seller}] }`. Eyeball that the sampled sales decode with `certain:true` prices before enabling the live cron.

## Verification (Cowork will run this the moment the first live tick lands)
- `pipeline_runs` for `allday-sales-history-backfill`: `ok=true`, `rows_written > 0`, cursor `allday_sales_v1_backfill` advancing downward.
- `SELECT count(*), min(sold_at), min(block_height) FROM sales WHERE collection='nfl_all_day' AND block_height < 148653524;` → rows appear, dates < 2026-04-16, block_height in [137390146, 148653524).
- `v_fmv_sanity_flags` stays 0; AllDay `allday_sales_history_backfill_targets` `zero_sales` count falls.
- **Bounded revert if anything looks wrong:** `DELETE FROM sales WHERE collection_id='dee28451-5d62-409e-a1ad-a83f763ac070' AND block_height < 148653524;` (+ same on `unmapped_sales`) — the forward indexer never wrote below that block, so this is exact.

## Guardrails
Direct to `main`, no branches/PRs. PowerShell `git`. Vercel Pro `maxDuration` cap 800s. Run smoke + confirm READY.
