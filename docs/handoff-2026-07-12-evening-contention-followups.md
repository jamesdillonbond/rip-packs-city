# Handoff — evening HTTP-pipeline contention (follow-ups; 2026-07-12, Cowork)

Separate from the pg_cron fix (done — `cron_heavy` role). This is the chronic HTTP-pipeline timeout cluster in the **21:00–00:00 UTC peak** (service-role, cron-job.org-triggered pipelines). I investigated every failing pipeline live.

**Root cause is NOT a missing index.** `sales` is already thoroughly indexed (13 indexes on `sales_2026` incl. `(collection_id, sold_at)`, `(edition_id, sold_at)`, `(edition_id, price_usd)`, a covering `(sold_at) INCLUDE (edition_id, collection_id)`, plus buyer/seller/nft/moment/tx). There is no safe DB index to add. The failures are **peak concurrency + connection-pool exhaustion + structural query shapes + external-API timeouts**. Everything below is code/operator work — none was safely shippable DB-only this session (and the sandbox git is down regardless).

## Mechanism note (corrects an earlier in-session claim)
`statement_timeout` behaves three different ways here — worth internalizing:
- **pg_cron**: function proconfig is INERT (the job command is one simple-query batch; the timer arms once at the 120s cluster default). This is what `cron_heavy` fixed.
- **PostgREST RPC** (`supabaseAdmin.rpc(fn, ...)`): function proconfig DOES apply — e.g. `wallet_usernames_unresolved` runs to its 60s proconfig, past the 30s `service_role` default. Nothing to "fix" here; my earlier "inert on the RPC path too" was wrong.
- **PostgREST inline query** (`supabaseAdmin.from(...).select()`): NO proconfig → gets the `service_role` 30s default. This is exactly why the deal-board read caps at 30s (see #2).

## 1. run-insider-detectors — the 185s pool hog (highest value; REVIEW-GATED)
`run_all_insider_detectors` runs 5 detectors/collection and holds a connection ~185s+ every 30 min (the route gives up with "upstream request timeout") — a major peak pool drain. Fixing it frees capacity for *every* other peak pipeline. Two structural query shapes dominate (indexes already exist — this is a rewrite, not an index):
- **`detect_new_edition_early_buyers`**: `edition_first_sale` computes `MIN(sold_at)` per edition over ALL collection history, then `HAVING MIN(sold_at) > now()-7d`. Rewrite result-identically by first restricting to editions that have any sale in the last 7 days (or join `editions.first_minted_at`/`created_at`), so it stops scanning years of history to find recently-first-sold editions.
- **`detect_unusual_edition_volume`**: `per_edition_baseline` runs a correlated 14-day `sales` COUNT **per qualifying edition**. Replace with a single set-based aggregate (one scan grouped by `edition_id`) joined to `per_edition_24h`.

REVIEW-GATED: these functions INSERT insider-signal alerts (a product differentiator), so verify old-vs-new output is identical (same alerts, same rows) before shipping. Each is a `CREATE OR REPLACE FUNCTION` migration — DB-only once reviewed.

## 2. deal-board read (topshot-deal-floor-serials, 30s cap) — cheap win
`app/api/cron/topshot-deal-floor-serials/route.ts` does an inline `supabaseAdmin.from("topshot_deals_vs_fmv").select("external_id").limit(5000)` → hits the 30s `service_role` ceiling. The view itself is cheap normally (plan cost ~9k) but starves in the peak. Wrap it in a SECDEF RPC (e.g. `get_topshot_deal_external_ids()` with `SET statement_timeout='90s'`) and call that instead — the RPC's proconfig survives the contention spike (unlike the inline query). One migration + one line in the route.

## 3. wallet-username-resolver (60s) — low priority
`wallet_usernames_unresolved` re-scans 21 days of `sales`+`pack_purchases` (~190k rows, grouped by `lower(address)`) every run to find a handful of unresolved wallets. Correct but wasteful. Either (a) track newly-seen wallets incrementally, or (b) accept it — it's username display and self-recovers off-peak. Do NOT add a covering index on the hot `sales` ingest path for this — the write overhead outweighs the benefit for a non-critical job.

## 4. lock-check-batch (125s) — external, not DB
Its timeout is the external lock-check API (upstream), not a DB query. Not fixable from the DB.

## 5. De-peak the 21:00–00:00 window (operator, cron-job.org)
All the peak pipelines are cron-job.org-triggered (none are in `vercel.json`), clustered in the same few minutes each hour. In the cron-job.org console, spread the heavy ones (insider-detectors, wallet-username-resolver, lock-check-batch, deal-floor-serials, the pack-EV computes) across the hour so they don't all fire together — the same concurrency-reduction that helped the pg_cron cluster. Secret-bearing console = operator-only.

## What NOT to do
- Don't add more `sales` indexes — the hot partition is already 13-deep and the needed ones exist.
- Don't raise `service_role` `statement_timeout` globally — it would remove the 30s guard on every user-facing API read.
- Don't grow the connection pool as the first move (cost) — the #1 rewrite (insider-detectors) frees the most capacity for free.

## Severity
Chronic, mostly benign: these pipelines are cursor-based and recover off-peak (no data loss). This is an efficiency/noise-reduction effort, not an outage. Prioritize #1 (frees pool capacity) and #2 (cheap, user-facing deal board) if/when picked up.
