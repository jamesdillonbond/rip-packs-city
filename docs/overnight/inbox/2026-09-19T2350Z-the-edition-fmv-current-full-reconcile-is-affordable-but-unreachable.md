# RPC — candidate filing: the `edition_fmv_current` full reconcile is AFFORDABLE — and UNREACHABLE. The fix its own column comment names cannot be invoked.

**Run:** 2026-09-19 4:50 PM PT (23:50Z) · Claude Code, Windows box · **READ-ONLY, nothing shipped, nothing scheduled.**
**Why this matters beyond itself:** `edition_fmv_current` is the table whose staleness bug **blocks R50's board swaps (eleven public insight boards)** and which `2026-09-19T2324Z` had to refuse as the obvious fix for jobid 506. Its column comment asks for exactly one thing before the fix can be considered — *"needs a cost measurement on this IO-bound instance first"*. **This is that measurement**, plus a blocker the comment does not mention.

## 1 — 🚨 THE DOCUMENTED FIX CANNOT BE INVOKED. The full-rebuild branch is dead code in production.

The column comment offers: *"a periodic FULL reconcile (the function already has a full-rebuild branch…)"*. The branch exists. **It is gated so that it can never run:**

```
SELECT max(computed_at) INTO v_watermark FROM edition_fmv_current;
v_full := v_watermark IS NULL;          -- ⇐ only true when the table is EMPTY
```

📏 **Measured live:** `edition_fmv_current` holds **21,424 rows** with watermark **2026-09-19 22:56:27Z**, so `v_watermark IS NULL` is **false**, so `v_full` is **false**, **on every call, always.** ⇒ *"schedule the full reconcile"* is **not a scheduling change** — there is no way to reach that code without first **TRUNCATE**ing a table that eleven live boards read. ⛔ **Anyone acting on the comment as written would either discover this after writing the migration, or blank the cache to trigger it.**

⭐ **A SECOND CONSEQUENCE NOBODY HAS NAMED: the prune is in the same dead branch.** `DELETE FROM edition_fmv_current WHERE refreshed_at < v_stamp` runs **only** in the full path, so **rows whose editions stop receiving snapshots are never removed.** Evidence in the table itself: **`min(refreshed_at)` = 2026-09-13 01:59Z — six days stale — while `max(refreshed_at)` = 2026-09-19 22:59Z, three minutes old.** The incremental path touches only rows with a newer snapshot; everything else sits untouched and unpruned forever.

## 2 — The cost, measured: affordable, with one honest caveat

The expensive half of the full branch, run as a bare `SELECT` so nothing was written (`EXPLAIN ANALYZE, BUFFERS`):

| | value |
|---|---|
| rows scanned → distinct editions | **1,589,670 → 21,424** (74:1) |
| **total buffers** | **1,557,074** (hit 1,514,551 · read 42,523) |
| execution | **27,061 ms** |

⇒ **~27 s and ~1.56 M buffers for a complete reconcile.** Against `cron_heavy`'s **600 s** budget that is **~4.5% of the ceiling** — comfortably affordable as a **once-daily** job, and roughly the cost of two of the confidence precompute's 4-hourly runs.

⚠ **THE CAVEAT, AND IT IS THE WHOLE RELIABILITY OF THE NUMBER: THIS READING IS WARM-BIASED AND IS A LOWER BOUND.** 42,523 physical reads out of 1,557,074 buffers is a **97.3% hit rate**, because I had just scanned the two largest collections for an unrelated measurement minutes earlier. **The column comment's *"minutes when cold"* is NOT refuted by this** — it is simply a different case, and it remains unmeasured. 👉 **Before scheduling, re-measure at the hour it would actually run.**

⭐ **And the shape of the cost is worth recording, because it explains why this is the expensive one.** The plan uses `fmv_snapshots_2026_edition_id_computed_at_idx` as a plain **Index Scan, not Index Only** — that index carries `(edition_id, computed_at)` but none of the projected value columns (`fmv_usd`, `floor_price_usd`, `collection_id`, `confidence`), so **every one of the 1.59 M rows takes a heap fetch**: ~1 buffer per row. ⚠ **Contrast, and do NOT read it as an apples-to-apples win:** the per-collection confidence query in `2026-09-19T2324Z` touched only 63,753 buffers for 1.09 M rows — but it projected **`confidence` alone**, which the covering `…coll_ed_ct_fmv_conf_idx` contains, so it went Index Only. **The full reconcile needs the value columns and therefore cannot use that index.** A covering index that included them would collapse this cost; on 1.59 M rows that is a large index to carry for one daily job, and it is not obviously worth it.

## 3 — What this unblocks, and what it does not

✅ **Unblocks, if fixed:** the `edition_fmv_current` staleness class (**162 of 14,016 Top Shot editions — 1.16% — publishing a value their own source contradicts, skewed HIGH, +$46,060 net**), which is what currently forbids R50's swap of eleven boards onto this table.
⛔ **Does NOT by itself fix jobid 506.** Even a correct `edition_fmv_current` only helps the confidence precompute if that precompute is re-pointed at it, which is a separate change — and `2026-09-19T2346Z` shows the precompute has a **coverage** defect too (Candy absent, Pinnacle sourced from the wrong table). **Three filings, one function family; they must be sequenced, not batched.**

## 4 — Suggested action (SUPERVISED; ⛔ nothing auto-shippable — this table sets prices users read)

1. **Make the full branch reachable** — add `p_full boolean DEFAULT false` and branch on `v_full := p_full OR v_watermark IS NULL`. ⚠ **This is a function-body change, so it is PUSH-GATED** (a pinned SQL function reds `migration-parity` until its file is committed) — it is not a no-push lever.
2. **Re-measure cold** at the intended hour (§2 caveat) before choosing a schedule.
3. **Schedule it daily under `cron_heavy`**, not `postgres` — and ⚠ **verify `has_function_privilege('cron_heavy', …)` FIRST**: the sibling filing `2026-09-19T2324Z` found that exact grant **missing** for `refresh_fmv_confidence_precompute()`, where it would have failed as pure silence. Do not assume it is present here.
4. 📏 **Falsifier, already runnable today:** re-run the audit behind the column comment — of 14,016 Top Shot rows, the 527 that name a `(edition_id, computed_at)` pair which no longer exists, and the 26 that disagree on `fmv_usd`, **should both go to ~0** after one full reconcile. If they do not, the drift has a second mechanism and the watermark was never the whole story.

⚠ **Not attempted, deliberately:** I did **not** run the full reconcile for real. It writes to a table eleven boards read, the prune in that branch would delete rows on a table whose pruning has never run, and **a first-ever prune is exactly the operation that should not happen unsupervised.**
