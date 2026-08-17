# `match-topshot-players` — failing every daily run since 08-14, and its declared 300 s budget is INERT

Filed 2026-08-16 19:00 PT / 2026-08-17 02:00Z (Claude Code, interactive). **QUEUED — nothing shipped.** The fix is a DB-function change on a heavy `wallet_moments_cache` aggregation; the cheap-looking version costs write amplification on the hottest table on the platform.

Found by sweeping `pipeline_runs_daily` for sustained-zero-output pipelines, not by an alert. **Nothing watches this pipeline** — it is on no `pipeline_cadence_watchlist` arm and its failure is silent.

---

## ⚠ Read this first: "0 rows written" is CORRECT here and is NOT the bug

`rows_written` has been **0 on every single run for 18+ days**, and that is the designed steady state — do not chase it. `rows_written` maps to `auto_aliased`, and the function only auto-aliases a name with **exactly one** `nba_players` candidate at `similarity >= 0.85`. Those were all inserted long ago (`ON CONFLICT (alias_normalized) DO NOTHING`), so the residual **1,417** unresolved names are by construction the `candidate_count <> 1` set — 0 or ≥2 candidates — which is exactly what the function's `needs_review` output exists to hand a human. **A pipeline correctly reporting "nothing is auto-resolvable" looks identical to a broken one on this metric.**

## The actual regression

| day | result | duration |
|---|---|---|
| 07-30 → 08-13 | **ok**, found 1,413–1,417, written 0 | 12.8 s – 113.4 s (wildly variable) |
| **08-14** | **FAIL** `rpc_failed: upstream request timeout` | 125.7 s |
| **08-15** | **FAIL** same | 126.1 s |
| **08-16** | **FAIL** same | 126.1 s |

100% failure since 08-14, and the whole `pipeline_runs` retention window contains only failures — so **the rollup is the only place the healthy history survives**.

## Why 125.7 s, and why the declared budget does not save it

`match_topshot_players_run()` declares `SET statement_timeout TO '300s'`. ⚠ **That is INERT** — CLAUDE.md records this proven twice (`8918307c`, and the trust-precompute legs): **a function-level `SET statement_timeout` does not bind the statements inside that function.** The binding budget is the **global `statement_timeout` = 120000 ms** (`pg_settings`, source = configuration file). The observed 125.7 s is 120 s plus the documented overshoot under IO throttle — the identical signature to `drain-conflated-subeditions` dying at ~125 s.

**So raising the declared 300 s to anything at all will change nothing.** The lever is the work.

## Measured: one statement eats the whole budget

The function's first statement (`_cache_names`) alone, `EXPLAIN (ANALYZE, BUFFERS)` at only moderate saturation:

```
GroupAggregate (actual rows=1417)
  Buffers: shared hit=4082 read=105799 dirtied=8521, temp read=17700 written=17725
  -> Sort (actual rows=1669699)
       Sort Method: external merge  Disk: 70832kB
       -> Seq Scan on wallet_moments_cache (actual rows=1669699)
            Rows Removed by Filter: 563324
Execution Time: 32704.997 ms
```

- **Seq scan of 1.67 M rows**, 563 k discarded by filter
- **105,799 buffer reads ≈ 827 MB off disk** on the IO-budgeted instance
- **External merge sort spilling 70 MB to temp**
- **32.7 s for ONE of several statements** inside a 120 s ceiling

⚠ The planner is also badly off — it estimates 558,814 rows against an actual **1,669,699** (3×), and 3,000 groups against 1,417.

That is why duration swung 12.8 s → 113.4 s across healthy days: it was always near the edge, and tracked whatever else was competing for IO. **It did not "break" on 08-14; it crossed a line it had been approaching for weeks.** Expect it to stay failing, because `wallet_moments_cache` only grows.

## Fix options (NOT taken — the obvious one has a real cost)

1. **Restructure the function (preferred).** `owners` is a `COUNT(DISTINCT wallet_address)` computed for **every** distinct player name, but it is only ever consumed for the `needs_review` ordering and its `owners >= 5` filter. Get the distinct-name list cheaply, resolve against `nba_players`/`nba_player_aliases` first, and compute owner counts **only for the small unresolved remainder**. No schema change, no write cost.
2. **Index `wallet_moments_cache (collection_id, player_name, wallet_address)`.** Would remove both the seq scan and the disk sort. ⚠ **But wmc already carries 14 indexes over ~1.6 GB and is the most write-heavy table on the platform** — CLAUDE.md records `fmv_confidence` being left deliberately unindexed for exactly this reason. This buys a read win with a write tax on the hot path.
3. ⛔ **Do NOT raise the declared `statement_timeout`** — proven inert above.

## Impact, stated honestly

Low and slow, not urgent. Because `auto_aliased` was already 0, the timeout costs no auto-aliases *today*. What it does cost: **a new Top Shot player name that becomes uniquely matchable can no longer be auto-aliased**, and the `needs_review` report — the only surface listing high-owner unmatched players — is no longer produced at all. Player matching feeds the player entity pages and Fast Break, so this degrades quietly over weeks.

⚠ Note this is a **Supabase edge function** (`supabase/functions/match-topshot-players`), so any redeploy carries the documented `import_map` boot-fail trap — but **the fix above is in the DB function, not the edge function**, so no redeploy is required.
