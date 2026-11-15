# `candy_sales_stale_hours` BREACH is not clearing — the legacy-collections census is an ONGOING backfill source, not the one-time batch the overnight/04:10Z disposition assumed

Filed 2026-11-15 ~16:04Z (≈08:04 AM PT, first daytime tick) by the daytime health monitor. Read-only sense-and-log; nothing changed. NOT a saturation spell: `rpc_ops_snapshot()` and every probe returned fast, no IO-wait majority — causal reasoning is admissible here.

## The state change vs the two prior dispositions

- The 04:10Z filing (RESOLVED by Claude Code 11-14 ~8:20 PM PT) traced the breach to **1,175** historical Candy sales parked 7:47–7:51 PM PT by one collection's first full-feed Magic Eden walk, and predicted it would **drain ~300/tick and clear ~8 AM PT 11-15**, with the falsifier: *"if still at breach_at 0 by 11-15 noon PT, the drain is not keeping up; read `candy_sales_unresolved` attempts."*
- The overnight pass (`metrics-latest.json`, 09:05Z) carried that forward as "clears ~noon PT," with `candy_sales_unresolved` 6444 total / 2634 queued-walk.
- **Read now (16:04Z): the backlog GREW, it did not drain.** `candy_sales_unresolved` total 8,897 (resolved_at NULL = 3,974); `candy_sales_stale_hours` value 14.7 → **21.7h**, still breach_at 0.
  - By `skip_reason` (unresolved only): **`queued_collections_walk` 3,898** (ALL first_seen today 03:47Z→15:49Z, attempts=1), `unresolvable_serial` 61 (max_att 54, all 11-09 — genuinely stuck), `edition_not_ingested` 15.
  - The 3,898 queued-walk rows are a **fresh** batch the rotating legacy-collections census produced today, not the drained 1,175. Parked queued-walk rose 2,634 (09:05Z) → 3,898 (16:04Z). The census (hourly, 396 legacy collections) discovers historical sales faster than the 300/tick ~3-hourly drain clears them within the 48h window the arm reads.

## Why it matters (and why it is NOT "broken")

- **Live capture is fine.** `candy-sales-indexer` is 8/8 ok (last 15:20Z), `detect_stalled_pipelines()` []. The parked rows are historical backfill (sales 07-26 → 11-14) from the legacy-collections census, not a live-market capture failure. The drain works (≈4,900 rows resolved). Revival arm is 0/10 (re-dated `silent_since_2026_11_14`).
- **But the "transient, self-clears" framing is wrong.** As long as the census keeps walking legacy collections, >50 historical sales will keep landing in `candy_sales_unresolved` per 48h, so the indexer-health branch (breach_at 0 = ">50 parked in 48h") stays permanently lit. That is the exact "permanently red arm teaches the operator to skim the board" anti-pattern the UFC 08-08 / Candy 10-28 redesigns fought.

## Candidate 1 — disposition the sticky breach (LOW risk, monitor-accuracy)

- Source: `v_rpc_trust_health.candy_sales_stale_hours` (breach_at-0 indexer-unhealthy branch); `candy_sales_unresolved`.
- Suggested action (night pass / Trevor): re-measure after noon PT (20:00Z) to confirm it is census churn, not the live indexer. If confirmed, consider excluding in-flight backfill reasons (`queued_collections_walk`, and freshly-seen `edition_not_ingested` awaiting census) from the "indexer unhealthy" 48h-parked count, so the arm reflects **live-market** freshness while the legacy backfill runs — same spirit as the 10-28 silent_since re-point, not a raised threshold. Leave `unresolvable_serial` (61, max_att 54) in; those are a real max-attempts tail to drop at `MAX_PARK_ATTEMPTS`. Re-measure, do not assume it self-clears.

## Candidate 2 — `hybrid_custody_backfill` failure-rate (LOW, not in ledger/focus)

- Source: `rpc_ops_snapshot().pipeline_alerts` — severity **medium**, "2/5 runs failed (40%) over last 3 days. Last error: `build_candidates: get_hybrid_custody_candidates: canceling statement due to statement timeout`." upstream:0; also 2 in `pipeline_fails_24h`. Not found in `ledger.md` or `focus.md`.
- Risk read: LOW (chronic, self-recovering, no data-loss signal). Suggested action (night pass): read `get_hybrid_custody_candidates` cost (pgss BUFFERS / mean) and give it a bounded read budget or a covering index if the candidate scan is growing — same pattern as the `fmv_backfill_candidates` / `topshot-map-atlas-reconcile` perf work.

## Everything else GREEN this tick

security [] all 4 arms (snapshot) · stalled [] · pg_cron fails [] · sentinel TS-48h 0 · ts_uuid_dupes 0 · cross_collection_mat_staleness [] (both ccm steps fresh) · 13/13 dashboard queries' objects resolve (16 source files = 13 live + 3 retired, no new file) · Vercel prod READY, 0 ERROR (CANCELED = superseded builds) · db 51,232 MB (no runaway) · public_board_slow_count recovered 1→0 since overnight.

## Follow-up — Claude Code cloud, 2026-11-15 ~8:40 AM PT

- **Candidate 1:** note for the noon-PT re-measure — at 8:15–8:20 AM PT Claude Code parked **2,529 more** `queued_collections_walk` rows on purpose (the validated ME files, inbox 0500Z step 6; block times 07-20 → 10-09). Expect ~6,400 open queued-walk rows and the breach to stay lit for ~3 days of drain (300 per 3-hourly tick) whatever the census does.
- **Candidate 2:** staged by another session as `2026-11-15T1635Z` §2 (90 s function timeout); a cross-check note is on that filing.
