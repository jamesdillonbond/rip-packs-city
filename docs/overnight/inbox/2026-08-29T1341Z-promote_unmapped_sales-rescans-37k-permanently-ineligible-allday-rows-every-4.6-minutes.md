# `promote_unmapped_sales` re-scans ~37,000 AllDay rows every 4.6 minutes to promote **~1.5 sales an hour** — about four hours of database time a day

**Filed 2026-08-29 (PT) by Claude Code, autonomous pass.** The half of the `promote_unmapped_sales` finding that migration `20260829134500` deliberately does NOT fix. That migration removes the duplicated quarter (74 same-collection self-overlaps a day); this is the other three quarters, and it needs a decision rather than a diagnosis.

---

## The numbers

Measured 24 h to 2026-08-29 13:25Z from `pipeline_runs`, and against `unmapped_sales` directly:

| | |
|---|---:|
| AllDay rows with `resolved_at IS NULL` | **104,913** |
| …of which `price_usd` is 0 or NULL | **67,540 (64.4%)** |
| …therefore actually scanned each run (`price_usd > 0`) | **~37,373** |
| runs per hour (AllDay) | ~10 |
| avg duration | **65,864 ms** (p95 196,353 · max 297,164) |
| `promoted` per hour | **~1.5** |
| `still_unresolved` movement over 13 hours | **104,933 → 104,913** (20 rows) |
| oldest / newest unresolved `sold_at` | 2025-12-29 → 2026-08-28 |

**Roughly four hours of database time a day, on an instance whose binding constraint is disk IO, to move twenty rows in thirteen hours.**

⚠ **And it reports healthy every single time.** The honest-signal guard is `IF v_eligible > 0 AND v_promoted = 0 AND … THEN v_ok := false`. With `eligible` at 0 or 1 on essentially every run, **that condition cannot fire**, so `ok = true` throughout. ⭐ **This is the `rows_written = 0` problem in a new costume: a pipeline doing four hours of work a day for almost no output, with no arm anywhere that can say so.**

## Where the cost actually is — and it is NOT the missing index

⛔ **The obvious fix is already in place.** `idx_unmapped_sales_tail_resolver_targets` is `(collection_id, last_onchain_attempt_at NULLS FIRST, sold_at DESC) WHERE resolved_at IS NULL AND price_usd > 0` — its partial predicate matches the candidate filter's first two conditions exactly. **Adding an index is not the lever; one that fits was already built.**

⭐ **The cost is the four `EXISTS` probes per surviving row.** For each of ~37,373 candidates the CTE asks: is there a `nft_edition_map` row? an `editions` row for the `edition_id` hint? one for `set_id_onchain:play_id_onchain`? a `wallet_moments_cache` row for this `nft_id`? That is ~150,000 index probes per run, ~10 runs an hour, to find one or two rows that changed.

🚨 **And nothing remembers the answer.** The only negative marker is `promote_recheck_after`, and it is written *only* for the `insert_vanished` class — **36 rows carry it out of 104,913**. A row that fails the candidate filter is never classified at all, so it is re-probed on every run, forever. ⚠ Note the same table already establishes the pattern for a different resolver: `last_onchain_attempt_at`, with its own partial index.

## 👉 Options, and why none of them is a same-day change

1. **A negative-attempt marker** (`promote_attempt_at` + horizon) on rows that fail the candidate filter, mirroring `last_onchain_attempt_at`. ⛔ **The hazard is real and specific: a row becomes resolvable the moment `nft_edition_map` or `wallet_moments_cache` gains an entry — and pg_cron jobid 215 runs `backfill_nft_edition_map_from_sales` hourly IMMEDIATELY BEFORE calling this function.** A marker with the wrong horizon strands sales that the very next backfill would have resolved. Any horizon must either be short or be invalidated by those writers.
2. **Cut the cadence.** `allday-sales-indexer` calls this from its `finally` on every tick (~10/hour) while jobid 215 already calls it hourly. ⚠ **Enumerate every caller first** — there are eight RPC call sites plus jobid 215, and this repo has a recorded incident where a gate silently no-op'd a GitHub-Actions backstop because the sweep stopped at cron-job.org. At ~1.5 promotions an hour against a backlog eight months deep, hourly is very unlikely to be user-visible, **but that is an argument, not a measurement.**
3. **Deal with the 64%.** 67,540 rows can never pass `price_usd > 0` until a price is recovered. `idx_unmapped_allday_price_recover_targets` and `/api/admin/recover-v1-budget-exhausted` exist for exactly this class. **Whether that recovery is still running, and what its ceiling is, is not established here.**

## ⛔ Not established

- **Whether the ~1.5 promotions/hour are worth four hours of IO.** That is a product judgement about AllDay sales freshness, not a performance question, and it decides between options 1–3.
- **Why 67,540 rows have no price.** The `v1_tx_decode_budget_exhausted` hint exists and has its own index and recovery route; nobody checked whether that route still runs or has stalled.
- **Whether the four `EXISTS` probes are individually expensive.** ⚠ **No `EXPLAIN (ANALYZE, BUFFERS)` was taken** — the instance was at 30 of 36 backends in IO wait when this was measured, and three unrelated probes timed out at 60 s under that load. **Any plan captured then would have measured the saturation, not the query.** Take it in a quiet window (roughly 20:00–00:00Z), and read the `hit`/`read` split rather than the total.
- ⚠ **All duration figures here predate `20260829134500`**, which removes the self-overlap. **Re-measure after it applies before sizing anything else** — a quarter of the recorded cost is about to disappear for an unrelated reason.
