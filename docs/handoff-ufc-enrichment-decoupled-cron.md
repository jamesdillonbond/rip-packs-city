# Handoff — Decouple UFC wmc enrichment into its own cron drain (UFC-WMC-NULLKEY FAIL follow-up)

**Date:** 2026-06-12 (autonomous verify task `ufc-wmc-nullkey-verify`)
**Status:** DRAFT — pre-written by the verify task. Route/cron code is NO-PUSH from Cowork; needs Trevor/Claude Code.
**Prior fix:** `b28a22f` (maxDuration 60→300 on `wallet-backfill-ufc` + `ufc-wallet-scan` nextStart pagination fix). **It did not work.**

## Verified FAIL evidence (2026-06-12, ~2 days / multiple 6h seed cycles post-deploy)

- `null edition_key` UFC wmc rows: **3,150 → 3,563** (total 4,584). Up, not down. `null_key == null_key_and_serial` exactly (3,563) — still the binary unenriched class.
- Fully-null wallets: **85 → 97** of 117 (fully enriched: 19).
- Backfills ARE running: `wallet-backfill-ufc` 101/101 ok in 24h, last 12:58Z 06-12.
- Decisive: rows touched by `last_seen_at` on 06-12 = 2,114, of which **2,085 (98.6%) still null**. The ID-walk re-walks wallets and writes/refreshes rows, but enrichment never lands on them — even at `maxDuration=300`.
- `seed-wallet-refresh` and `ufc-wallet-scan` logged **zero** `pipeline_runs` rows in 24h (only `wallet-backfill-ufc` appears). The enricher (`enrich-ufc-wallet` / `triggerUfcEnrichmentChain`) logs nothing to `pipeline_runs` at all — per-wallet GQL/upsert failures are invisible. That blind spot is itself a finding.

## Causes to rule out (in order)

(a) **Lambda reclaim even at maxDuration=300.** The Cadence ID-walk runs 83–93s inside `after()`; if the chain (walk → enrichment per wallet) exceeds the budget or the platform reclaims the lambda after the response anyway (cf. the `ec307dc` Cloudflare `ctx.waitUntil` kill — same class), enrichment dies mid-chain with no trace. Check Vercel runtime logs for the route around recent ticks; check whether `b28a22f`'s deploy actually carries maxDuration=300 in the built config.

(b) **`enrich-ufc-wallet` erroring silently.** It logs no `pipeline_runs`, so a per-wallet GQL failure (topshot-proxy auth, UFC GQL shape change, upsert constraint error) fails 100% invisibly. The 19 fully-enriched wallets may predate a breakage. Probe one null wallet's enrichment path manually and watch the error.

## The agreed fix (NOT another maxDuration bump, NOT re-flagging the symptom)

Decouple enrichment from the backfill lambda into its own cron drain:

1. **Selector:** pick wallets with NULL-`edition_key` UFC wmc rows — `SELECT wallet_address, count(*) FROM wallet_moments_cache WHERE collection_id='9b4824a8-736d-4a96-b450-8dcc0c46b023' AND edition_key IS NULL GROUP BY 1 ORDER BY 2 DESC LIMIT <batch>`.
2. **Worker:** new route (e.g. `/api/cron/ufc-enrichment-drain`) that runs the existing on-chain enricher per wallet in its OWN lambda — small batch per tick (2–4 wallets), 202+`after()` per the CRON-30S pattern, in-request enrichment work (not a nested fire-and-forget — that's how it died here).
3. **Observability (non-negotiable):** the drain logs its OWN `log_pipeline_run(pipeline='ufc-enrichment-drain')` with per-wallet ok/fail counts in `extra`, so we are never blind again. Add a `pipeline_cadence_watchlist` row only after a verified cadence (per the BUYERBF lesson: measure observed cadence first).
4. **Cron:** cron-job.org entry per the rpc-cron-ops recipe — off the :00 rush, Bearer header auth, www host, expect 202.

UFC has NO DB nft→edition mapping; the on-chain enricher is the only source of `edition_key`/serial/tier/set — a SQL JOIN-denorm cannot fix this. Once the drain populates `edition_key`, `backfill_wmc_metadata_from_editions` fills tier/set on the normal path.

**Done-when:** UFC null_key trending to <100; fully-null wallets → 0; `ufc-enrichment-drain` visible in `pipeline_runs` with ok=true.

**Revert path:** delete the new route + cron entry + watchlist row; no DB schema changes involved.
