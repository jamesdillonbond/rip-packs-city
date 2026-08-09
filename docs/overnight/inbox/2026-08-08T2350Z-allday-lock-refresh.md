# Inbox 2026-08-08T23:50Z — allday-lock-refresh: the picker query, and the write-amplification loop under it

Diagnosis only. **Nothing shipped** — the remedy is a CONCURRENTLY index build on a hot 2.1M-row table and the disk-IO budget is already strained, so it wants a human at the keyboard (same call you made for the `sales_2026` index today).

---

## 1. The failure is one SELECT, and it never reaches the chain

`allday-lock-refresh` has failed 44/66 over two days (21/24 on 08-06, 9/24 on 08-07, 14/18 on 08-08) with `wallet fetch: canceling statement due to statement timeout`, `duration_ms_max` ~292–300s.

`app/api/cron/allday-lock-refresh-batch/route.ts:76` — the error fires at the **first** statement, `get_allday_lock_refresh_wallets(p_limit: 60)`. No Cadence call, no on-chain diff, no write. The pipeline dies choosing which 60 wallets to work on.

The function body:

```sql
SELECT w.wallet_address, min(w.lock_checked_at) AS oldest_check, count(*) AS row_count
FROM public.wallet_moments_cache w
WHERE w.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
GROUP BY w.wallet_address
ORDER BY min(w.lock_checked_at) ASC NULLS FIRST
LIMIT GREATEST(1, p_limit);
```

**The `LIMIT` removes no work.** Every All Day row must be grouped and every wallet's `min()` computed before the sort can name the 60 stalest. Another instance of [[a-trailing-limit-is-not-a-bound]].

`EXPLAIN` (planner only, no ANALYZE — the 60s MCP cap forbids the real thing):

```
Limit  (cost=32509.00..32509.15 rows=60)
  Sort  Sort Key: (min(lock_checked_at)) NULLS FIRST
    Finalize GroupAggregate  Group Key: wallet_address
      Gather Merge (Workers Planned: 1)
        Partial GroupAggregate  Group Key: wallet_address
          Parallel Index Only Scan using idx_wmc_lock_wallet_coll  (rows=199495)
            Index Cond: (collection_id = 'dee28451-...'::uuid)
```

⚠ **It is already an Index Only Scan, so this is NOT a missing index.** Two things are wrong instead:

- `idx_wmc_lock_wallet_coll` is `(wallet_address, collection_id, lock_checked_at NULLS FIRST)` — **`collection_id` is not the leading column**, so that `Index Cond` is a filter applied while walking the index, not a seek. It reads the whole 48 MB index across all 8 collections to find All Day's ~199k rows.
- `idx_wmc_lockcheck_order` **already exists** as `(collection_id, lock_checked_at NULLS FIRST)` and *is* seekable — but it has no `wallet_address`, so the GroupAggregate couldn't stay index-only with it. The planner correctly picks the walk over the heap fetches. Neither index fits the query.

**The index that fits** (mirrors today's `sales_2026` win — right key order, output-equivalent, index-only):

```sql
CREATE INDEX CONCURRENTLY idx_wmc_allday_lock_picker
  ON public.wallet_moments_cache (collection_id, wallet_address, lock_checked_at NULLS FIRST);
```

Leading `collection_id` seeks straight to All Day; `wallet_address` next means the GroupAggregate needs no sort and `min()` is the first entry per group; still index-only. ~50 MB. `idx_wmc_lockcheck_order` (32 MB, **3,548 lifetime scans**) becomes a near-duplicate worth reviewing for removal, so the net index footprint is roughly flat.

⚠ **CONCURRENTLY cannot run in a transaction and this build will exceed the 60s interactive-tool cap** — Supabase SQL editor, by hand, same as today. Commit a matching `supabase/migrations/` file afterwards for repo↔DB parity.

---

## 2. The finding underneath it: the pipeline bloats the index it then has to read

This is the part worth more than the index.

`pg_stat_user_tables` for `wallet_moments_cache`:

| metric | value |
|---|---|
| `n_live_tup` | 2,114,789 |
| `n_tup_upd` | **200,222,692** |
| `n_tup_hot_upd` | **3,354,109 (1.7%)** |
| `autovacuum_count` | 1,880 |
| `n_dead_tup` | 66,710 (3.1%, autovacuum ran 23:42Z) |

**98.3% of 200 million updates were non-HOT.** A HOT update can reuse the page and touch no index; a non-HOT update writes a new tuple into **every one of the table's 14 indexes**. Updates go non-HOT when an *indexed* column changes — and `lock_checked_at` is indexed twice (`idx_wmc_lock_wallet_coll`, `idx_wmc_lockcheck_order`).

So: the lock-refresh pipeline stamps `lock_checked_at` → each stamp is non-HOT → writes into all 14 indexes → bloats the very index its picker query walks → the picker gets slower → it times out. **The pipeline is the author of its own timeout.** Fixing the index shape treats the symptom; this is the mechanism, and it will keep re-inflating.

Size evidence:

| | |
|---|---|
| heap | 803 MB |
| all indexes | **1,691 MB** |
| index:heap ratio | **2.11** |

Two indexes are worth a hard look:

- **`idx_wmc_cohort_cover` — 575 MB, the single largest index on the table, 3,665 lifetime scans.** It's `(wallet_address, collection_id) INCLUDE (fmv_usd)`. `idx_wmc_wallet_collection` has the *same key columns* without the INCLUDE at **65 MB with 583,844 scans** — 9× smaller, 160× more used. So 34% of all index bytes on this table, and a 34% share of that 200M-update write amplification, serves 3,665 scans. ⚠ **Do not drop it blind** — the INCLUDE exists to make some read index-only, most likely the cohort refresh ([[wmc-cohort-refresh-perf]]); a low scan count can still be a low-frequency critical path. Worth confirming what actually plans against it before deciding.
- `idx_wmc_lockcheck_order` — 32 MB, 3,548 scans, superseded by the proposed index.

For contrast, the ones earning their keep: `idx_wmc_moment_collection_cover` (253 MB, **343.6M scans**), `wallet_moments_cache_pkey` (92 MB, 38.7M), `wallet_collection_moment_key` (267 MB, 11.2M).

**The durable lever** is the one already in memory for this table: *VACUUM helps and decays — precompute instead.* There are only ~416 All Day wallets against ~199k rows. A tiny `allday_lock_wallet_state(wallet_address, oldest_check, row_count)` table, upserted by the refresh itself (it already knows which wallet it just stamped), turns the picker into a 416-row read and removes the aggregate entirely. That's a design change, not a hotfix — flagging, not proposing.

---

## Suggested order

1. Build `idx_wmc_allday_lock_picker` by hand (SQL editor). Expect the picker to collapse from a 300s timeout to sub-second, and `allday-lock-refresh` to start completing.
2. Confirm what plans against `idx_wmc_cohort_cover` before touching it — 575 MB of write amplification is the largest single lever on this table's IO.
3. Only then consider the precompute; the index may buy enough headroom to deprioritize it.

Nothing here is urgent tonight. The pipeline has been failing this way since at least 08-06 and it fails cheaply — it dies on the first statement without doing any on-chain work.

---

# Addendum 2026-08-09T00:40Z — `idx_wmc_cohort_cover` resolved: KEEP it, but REINDEX it

(Recorded here after the fact — this addendum was delivered in chat only and never
reached the repo when the device bridge dropped mid-session.)

✅ **Instrument checked first:** `pg_stat_database.stats_reset` is **NULL** — statistics
have never been reset, so every `idx_scan` figure in this file is a genuine lifetime
total, not a short window.

**Load-bearing — do NOT drop.** `EXPLAIN` confirms `aggregate_saved_wallet_stats` (runs
after every wallet backfill / `resolve-and-associate`) plans `Index Only Scan using
idx_wmc_cohort_cover`, and the `INCLUDE (fmv_usd)` is exactly what keeps it index-only.
Drop it and each call heap-fetches ~20k rows on our most churn-heavy table.

⚠ **But ~6× bloated.** 285.1 B/row versus 32.2 B/row for `idx_wmc_wallet_collection` —
the *same two key columns* without the INCLUDE (65 MB). That is 8.8× for one added
`numeric`, which should cost ~1.3–1.5×. **~480 MB reclaimable** via
`REINDEX INDEX CONCURRENTLY public.idx_wmc_cohort_cover;`

---

# Resolution 2026-08-09 (Claude Code, interactive) — hypothesis MEASURED, rewrite SHIPPED, two corrections

The addendum asked for the INCLUDE hypothesis to be **measured, not guessed**. It has
been. The answer is **no** — and two other recommendations in this file are corrected.

## 1. ✅ The HOT hypothesis is half right, and that makes the proposed trade VOID

Controlled probe on this exact server (three scratch tables, `fillfactor=50` so page
space is never the variable; dropped afterwards). **Probe A is the positive control** —
without it a pair of "NON-HOT" readings proves nothing:

| probe | index on the updated column | result |
|---|---|---|
| A | none (plain index on another column) | **500/500 HOT** ← control: harness can detect HOT |
| B | `(k) INCLUDE (v)` | **0/500 HOT** — INCLUDE blocks HOT |
| C | `(k) WHERE v IS NULL` | **0/500 HOT** — *predicate* blocks HOT |

So the addendum's mechanism is confirmed for INCLUDE. **But C is the finding that kills
the trade:** a partial index's *predicate* column blocks HOT too — even when the
predicate's truth value does not change (v went 1.0 → 2.0, non-null both sides).

`idx_wmc_fmv_null` is `ON (collection_id, edition_key) WHERE (fmv_usd IS NULL AND
edition_key IS NOT NULL)`. Its predicate references `fmv_usd`. **Therefore dropping the
INCLUDE from `idx_wmc_cohort_cover` recovers exactly zero HOT updates** — it would
forfeit the index-only aggregate scan and buy nothing. **Verdict: KEEP the INCLUDE.**

**The 1.67% HOT rate is structural, not a fixable defect.** 10 of the 24 columns on
`wallet_moments_cache` block HOT (`wallet_address, collection_id, moment_id, edition_key,
serial_number, fmv_usd, lock_checked_at, image_url, render_id, id`) — and they are
precisely the columns the hot write paths touch. The hot-safe remainder (`tier`,
`set_name`, `player_name`, `mint_count`, `last_seen_at`, …) is exactly what the
change-detecting batch upsert already declines to write. Recovering HOT on FMV writes
would mean removing `fmv_usd` from both the INCLUDE *and* `idx_wmc_fmv_null`'s
predicate — but that index exists to *find rows where fmv_usd IS NULL*, which cannot be
expressed without naming the column. Not worth further effort.

**REINDEX is unaffected and still correct** (~480 MB) — and now unambiguous, since the
alternative it was competing with is ruled out.

## 2. ⚠ CORRECTION — do NOT drop `idx_wmc_lockcheck_order`

This file suggests it "becomes a near-duplicate worth reviewing for removal", making the
net index footprint "roughly flat". That is wrong. `get_lock_check_batch` (the generic
multi-collection lock picker behind `/api/cron/lock-check-batch`) runs
`WHERE collection_id = c.id AND (lock_checked_at IS NULL OR < now()-Nd)
ORDER BY lock_checked_at ASC NULLS FIRST LIMIT p_limit` — an ordered index scan where the
LIMIT *genuinely* bounds work. That is exactly `(collection_id, lock_checked_at)`.
Dropping it would break that cron the same way this one is broken. The new picker index
is a **net add**, not a swap — which is why it should be partial (below).

## 3. ⚠ CORRECTION — the row/wallet figures

Not ~199k rows / ~416 wallets. Live: **396,498 rows / 213 wallets**. The 199,495 in the
EXPLAIN was a *per-worker* parallel row estimate (1 worker planned), i.e. about half the
true total.

## 4. ✅ SHIPPED — the picker is now O(wallets), not O(rows)

Migration `20260809010000_audit_20260809_allday_lock_picker_skipscan.sql` (applied).
A recursive skip-scan walks the 213 distinct wallets; each wallet's `min(lock_checked_at)`
folds into `InitPlan -> Limit -> Index Only Scan`. `row_count` was dropped from the return
type — it was the entire remaining cost (~0.9s → ~19.5s) and **the sole caller reads only
`wallet_address`**, as does its test fixture; no DB object referenced the function at all.

Equivalence proven before shipping against `candy_mlb` (small enough that the original
GROUP BY completes): identical `(wallet_address, oldest_check)` sets, 395 rows each,
`EXCEPT` empty in **both** directions. Completeness cross-checked on All Day: the
skip-scan's 213 wallets account for exactly 396,498 rows.

## 5. ⚠ The index is still needed — and should be PARTIAL, not the full one proposed above

The rewrite alone is **necessary but not sufficient**. Measured A/B under an identical
live saturation window (31 backends in `IO/DataFileWrite` from a
`REFRESH MATERIALIZED VIEW CONCURRENTLY`): **old shape = timeout at 110s, new function =
76s.** Better, but not good enough.

Why — one probe, measured:

```
Index Only Scan using idx_wmc_lock_wallet_coll  (actual time=280.034 rows=1)
  Index Cond: ((wallet_address > '0x0') AND (collection_id = 'dee28451-…'))
  Heap Fetches: 0        Buffers: shared hit=4 read=42
```

**42 index pages read to return one row**, because `collection_id` is the *second* column
of that index — each hop walks through the entries of intervening wallets that hold no
All Day rows. ×213 hops is the whole runtime. (`Heap Fetches: 0` — the visibility map is
fine here; this is pure index walking, not a VACUUM problem.)

So the index recommendation stands, but **partial beats the full index in this file** —
same plan quality, ~5× smaller, and far less write amplification, since only All Day rows
pay for it. Precedent already exists on this table: `idx_wmc_candy_holder_cover`.

```sql
CREATE INDEX CONCURRENTLY idx_wmc_allday_lock_picker
  ON public.wallet_moments_cache (wallet_address, lock_checked_at NULLS FIRST)
  WHERE collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid;
```

~18 MB (vs ~50 MB for the full three-column form). With it, both the wallet hop and the
`min()` become single index descents: ~213 × ~4 pages instead of ~213 × 42.

## Revised operator order (both need the SQL editor — `CONCURRENTLY` cannot run via MCP)

1. `REINDEX INDEX CONCURRENTLY public.idx_wmc_cohort_cover;` — ~480 MB, safe, online.
   A failed run leaves an invalid `_ccnew` index that must be dropped before retrying.
2. Create the **partial** `idx_wmc_allday_lock_picker` above.
3. Do **not** drop `idx_wmc_lockcheck_order`. Do **not** drop the cohort INCLUDE.

Wait for a quiet window — as of this writing the DB is in an MV-refresh write storm
(that cluster is already queued in `2026-08-08T1717Z.md` / `1945Z.md`). The precompute
idea in the base note is now unnecessary: the rewrite plus the partial index makes the
picker O(213 descents), which does not grow with row count.
