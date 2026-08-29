# Applying my own Class C recommendation: jobid 237 is the SAME defect as 211 (right index, missing payload) — and #42's triage query still ranks the already-FIXED jobid 211 first

**2026-08-29 11:5x PT / 18:5xZ · Claude Code (Trevor's box)**
**Follow-on to [2026-08-29T1815Z](2026-08-29T1815Z-CORRECTION-my-own-jobid-211-dosimeter-filing-is-superseded-an-index-fixed-it-and-42s-class-C-signature-is-wrong.md), which recommended re-testing Class C members for a missing index. This is that test, run rather than left as a filing.**
⛔ **NOTHING MEASURED UNDER LOAD WAS TURNED INTO A COST — the daytime IO band was still active (`io_wait 13 / active 13 of 48` at 18:44Z, i.e. 100% of active sessions in IO wait). This files a prediction and the exact query that settles it, not a result.**

---

## 1. 🚨 FIRST, THE METHODOLOGICAL CATCH — the triage query still ranks a FIXED job first

Re-running #42's Class C triage (`max(success) ÷ median(failure)`) over a 7-day window, today:

| jobid | job | runs | ok | bad | max_ok | med_fail | **wasted 7d** | ratio |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| **211** | `rpc-refresh-allday-pack-realized` | 27 | 10 | 17 | 74 s | 600 s | **10,214 s** | **12%** |
| 237 | `rpc-refresh-pack-reality-dist` | 83 | 79 | 4 | 303 s | 602 s | 2,430 s | 50% |
| 325 | `rpc-thp-leg-fmv-coverage` | 28 | 25 | 3 | 411 s | 600 s | 1,801 s | 69% |
| 4 | `rpc-ccm-step2` | 7 | 4 | 3 | 10 s | 300 s | 900 s | **3%** |

⛔ **jobid 211 is still the worst entry on this table by a factor of four — and it was FIXED yesterday.**
All four of its ticks today succeeded (2 s · 2 s · 2 s · 40 s). The 7-day window straddles the index,
so **the ranking is measuring the defect's ABSENCE and reading it as its presence.**

⭐ **This is CLAUDE.md's *"a rate POOLED ACROSS A FIX measures the fix's ABSENCE and reads as its
FAILURE"* landing on the triage instrument itself.** Anyone re-running #42's own query today is
pointed straight at an already-solved job — **and 10,214 s of "reclaimable waste" that no longer
exists.** 👉 **#42's triage must split on the change point, or at minimum exclude any job whose
recent tail is clean.** A 7-day rate is not a current state.

## 2. ⭐ THE PREDICTION — jobid 237 is structurally the same defect as 211

`rpc-refresh-pack-reality-dist` is `REFRESH MATERIALIZED VIEW CONCURRENTLY
public.mv_topshot_pack_reality_dist`, bimodal at 303 s success / 602 s failure. Its defining query
reads **the same table jobid 211 did**:

```sql
WITH rips AS (
  SELECT COALESCE(pull_value_usd, 0) AS pv
  FROM pack_rips
  WHERE collection_id = '95f28a17-…'::uuid
    AND sealed_at >= now() - '60 days'::interval
)  -- then 6 UNION ALL branches + a total, all scanning `rips`
```

**The index for that predicate already exists — and it is missing exactly the payload column:**

```
idx_pack_rips_collection_time  btree (collection_id, sealed_at DESC)   144 MB, 421 scans
```

⭐ **Right leading columns, no `INCLUDE`.** So every row matching the 60-day window must be
heap-fetched to read `pull_value_usd` — **the identical shape that made jobid 211 bimodal**, where
`idx_pack_rips_dist_id` had the right key and no payload and the plan heap-fetched ~2.7M rows.

⛔ **The 08-28 index does NOT help here.** `idx_pack_rips_dist_agg` is
`(collection_id, dist_id) INCLUDE (pull_value_usd) WHERE dist_id IS NOT NULL` — wrong second key for
a `sealed_at` predicate, **and its partial clause excludes precisely the unattributed rows this MV
must count.**

**Candidate fix — a REPLACE, not an ADD:**
`idx_pack_rips_collection_time` → `(collection_id, sealed_at DESC) INCLUDE (pull_value_usd)`.
Leading columns are unchanged, so **every one of its current 421 scans survives.**

## 3. ⚠ The cost, stated rather than buried — and it is the SECOND time on this column

The 08-28 migration already recorded the trade-off it accepted: **`INCLUDE` and predicate columns
BLOCK HOT UPDATES, and `pull_value_usd` is exactly what the valuation backfill writes**
(`idx_pack_rips_stale_valued` exists to find rows needing it). ⛔ **This proposal puts
`pull_value_usd` into a SECOND index on the same hot table**, so the write-amplification cost is paid
again and is additive. `pack_rips` is 3,596,789 rows / 756 MB with **ten** indexes already.

👉 **That makes this Trevor's call, not a free win** — the same call he made once on 08-28 with the
numbers in front of him. **It should not ship on this filing's evidence alone**, which is structural.

## 4. ⛔ What is NOT established

- **No `EXPLAIN` was run.** The band was active and this repo's own rule is not to measure a cost
  inside a spell. **The claim is a SHAPE match, not a measurement.**
- A bounded `count(*)` over that exact 60-day window **timed out at 25 s** during the band. ⚠ **That
  is consistent with the prediction and is NOT evidence for it** — a timeout inside a spell is
  spell collateral, and this repo has a standing rule against reading one as a cost.
- **The 60-day window's row count is therefore unknown**, so the fix is unsized. If the window is
  small the heap fetches are cheap and the whole prediction is wrong.
- jobid **4** (`rpc-ccm-step2`, ratio **3%** — 10 s success vs 300 s failure) is the most extreme
  bimodality on the board and **was not investigated at all here.** ⓘ Note its command uses the
  working two-statement form (`SET statement_timeout = '300s'; SELECT …`), so unlike #43's population
  its ceiling is real. **n = 7 runs; classify before rating.**

## 5. 👉 The measurement that settles it — one query, quiet window (≥ 20:00Z)

```sql
EXPLAIN (ANALYZE, BUFFERS)
WITH rips AS (
  SELECT COALESCE(pull_value_usd, 0) AS pv
  FROM public.pack_rips
  WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
    AND sealed_at >= now() - '60 days'::interval
) SELECT count(*) FILTER (WHERE pv = 0), count(*) FROM rips;
```

**Read `Heap Fetches` / the Bitmap-Heap-Scan buffer share, not the wall clock.** Large relative to
rows returned ⇒ the prediction holds and the `INCLUDE` is the fix. Small ⇒ **this filing is wrong and
jobid 237 needs a different explanation** — which is the outcome worth having either way.

⚠ Use an **age-matched control** rather than a bare before/after: same query, an older 60-day slice
with a comparable row count. A hot-window before/after is confounded by contention.
