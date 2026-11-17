# 📏 `backfill_wmc_metadata_from_editions` had 152 rows of work left, they are now filled, and its partial index is a **100% false positive**

**Filed 2026-09-01 ~19:1x PT (2026-09-02 ~02:1xZ) by Claude Code from Trevor's Windows box.**
Found by ranking `ops_pgss_delta` on **total time** rather than buffers — it is the largest *time*
consumer on the instance and appears nowhere in the buffer-ranked lists everyone has been reading.

## The reading (127-minute window)

| fn | calls | buffers | buffers/call | ms/call | **total DB seconds** |
|---|---:|---:|---:|---:|---:|
| `query_sql` | 153 | 16,078,985 | 105,091 | 2,616 | 400 |
| `refresh_seeded_wallet_stats` | 130 | 6,133,218 | 47,179 | 4,814 | 626 |
| **`backfill_wmc_metadata_from_editions`** | **337** | 970,115 | **2,879** | **3,069** | **1,034** |

⭐ **It is last by buffers and first by time.** ~337 calls / 2 h ≈ **4,000/day ≈ 3.4 hours of DB time
daily.** A buffer-ranked view — which is how every recent saturation pass has ranked — puts it near the
bottom and never surfaces it.

## What work was actually left: 152 rows, in 5 wallets

The function's `WHERE` admits a row only if a wmc column is NULL **and** the joined edition has a value
to supply (the right-hand `IS NOT NULL` guard added 2026-08-30 to stop it rewriting identical values).
Measured across the whole table:

| | rows |
|---|---:|
| matching the partial index's predicate | **63,435** |
| **actually fillable** (edition has a value) | **152** |
| …spread across | **5 wallets, all `nba_top_shot`** |

**99.76% of what the index admits could never be filled.**

## ✅ ACTIONED — the remaining work is done

```sql
select public.backfill_wmc_metadata_from_editions(null, null);  -- => 152
```

`fillable_now` is now **0**. This is the function's own designed operation, run once unscoped instead of
waiting for those 5 wallets to be refreshed individually; the same 152 rows would have been filled by the
next refresh of each. It only ever writes a NULL column from a non-NULL edition value (`COALESCE` keeps
anything already present), so it cannot overwrite data.

⚠ **REVERT: none, and none is wanted — stated plainly rather than left implied.** I did not snapshot the
prior state, and the prior state was 152 NULLs this function exists to remove. Reverting would mean
re-introducing them. This is a forward-only fill, idempotent, and identical to what runs ~4,000×/day.

## 🚨 The finding that outlives the fix: the index is now 100% false-positive

`idx_wmc_metadata_fillable` (built 2026-08-31, `20260901111157`) is partial on
`(edition_key IS NOT NULL) AND (tier IS NULL OR player_name IS NULL OR …)`.

**It tests only the LEFT side of the fill.** It cannot test whether the *edition* has anything to supply,
because a partial index cannot reference another table. So after the drain:

```
index_still_admits: 63,283      actually fillable: 0
```

Those 63,283 rows have NULLs whose editions are **also** NULL there — permanently unfillable by this
function. The index will keep offering all of them on every call, forever, and yield nothing until a new
NULL-bearing row arrives whose edition happens to have values.

The live plan shows the cost of that: a `BitmapAnd` of **68,166** entries from `idx_wmc_metadata_fillable`
and **68,620** from `idx_wmc_lock_wallet_coll`, reduced to **27** heap rows, all 27 then rejected by the
editions join. For a per-wallet call the wallet index alone does the real work; the partial index
contributes ~185 buffers of scan and no selectivity.

## ⚠ The 3,069 ms/call is NOT the query's own work — and I am flagging the confound

Isolated, for a typical wallet: **20.9 ms, 504 buffers.** Production: **3,069 ms, 2,879 buffers.**
**146× the time for 5.7× the buffers.** Time that does not track buffers is not scan time.

**HYPOTHESIS, not a measurement:** lock contention on `wallet_moments_cache`, which is among the hottest
tables on the instance (the `lock_checked_at` UPDATEs alone ran 210 times in the same window, plus
`wmc-fmv-populate`, `refresh_wmc_fmv_changed` and the wallet-backfill family).

⛔ **The confound, stated rather than buried: my isolation test was a `SELECT`; production runs an
`UPDATE`, which takes row locks.** So 20.9 ms bounds the *read* half only, and some of the gap is
legitimately the write. The gap is too large to be only that, but I have not separated them. **The next
measurement is `pg_stat_activity.wait_event_type` sampled during a live call, or
`log_lock_waits`** — not another EXPLAIN.

## Suggested action — caller-side, not SQL

With zero addressable work, ~4,000 calls/day is pure overhead. The lever is **the caller**: stop invoking
this on every wallet refresh, or gate it behind a cheap "has this wallet gained NULL metadata since we
last checked" test. That is route code, so it needs a push and a decision about whether the backfill is
still load-bearing at all.

⚠ **Do NOT simply drop `idx_wmc_metadata_fillable` on the strength of this filing.** It is 100% false
positive *for this function*, but it was built a day ago and I have not enumerated its other callers.
**EXIT / next measurement:** re-run the two counts in a week. If `fillable` is still 0, nothing
regenerates and the per-refresh call is retirable outright. If it climbs, something upstream is writing
wmc rows with NULLs that editions *can* fill, and the real defect is there instead.

---

## 🔁 EXIT MEASUREMENT TAKEN EARLY — 2026-09-01 ~23:1x PT (Claude Code cloud session), ~4 h after the drain

The exit condition above says *"re-run the two counts in a week. If `fillable` is still 0, nothing
regenerates and the per-refresh call is retirable outright. If it climbs, something upstream is writing
wmc rows with NULLs that editions **can** fill."* **It has already climbed, and the second branch is the
live one — so the retire-it option is off the table.**

```
index_admits: 63,312      fillable_now: 29        (~4 h after fillable hit 0)
```

**All 29 are `nba_top_shot`, in 2 wallets, and 29 of 29 need `tier`** (5 also need `mint_count`, 5
`team_name`; none need `player_name` or `set_name`).

⭐ **And the regeneration is on the EDITIONS side, not the wmc side — which the filing's wording did not
anticipate.** The wmc rows are OLD: `created_at` **2026-04-05**, one exception at 2026-09-02 02:54Z. What
is new is the *edition*: every one of them has `editions.updated_at` in the **06:05:4x–06:05:52Z**
window, i.e. minutes before this read. **An edition gaining a value flips a long-standing wmc row from
unfillable to fillable without anything touching wallet_moments_cache at all.** That is the mechanism,
and it means the population will keep regenerating for as long as the editions catalogue keeps being
enriched — at roughly **29 per 4 h ≈ 175/day**, against ~4,000 calls/day.

⚠ **What this does NOT establish.** `editions.updated_at` moving does not prove `tier` was the column
that changed — a write that touched any column bumps it. So *"the editions ingest is filling tiers"* is
the plausible reading, not a measured one; the falsifiable version needs the ingest's own diff, not a
timestamp. **Recorded as a mechanism hypothesis with its evidence, so the next session does not inherit
it as fact.**

👉 **Consequence for the suggested action.** "Stop invoking this on every wallet refresh" is still the
right lever — ~4,000 calls/day for ~175 rows is a 23:1 waste ratio — but the gate must not be "never
call it", and it cannot key on wmc write activity either, because **the trigger is an editions write on
rows the refresh never touched**. A gate that only fires when the refresh inserted new wmc rows would
have missed all 29 of these.

⛔ **The index advice stands unchanged: do NOT drop `idx_wmc_metadata_fillable` on the strength of either
reading.** Its callers have still not been enumerated.

