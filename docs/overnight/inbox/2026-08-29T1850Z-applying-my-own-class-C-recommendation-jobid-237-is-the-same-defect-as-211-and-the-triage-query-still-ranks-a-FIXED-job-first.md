# Applying my own Class C recommendation: jobid 237 is the SAME defect as 211 (right index, missing payload) — and #42's triage query still ranks the already-FIXED jobid 211 first

**2026-08-29 11:5x PT / 18:5xZ · Claude Code (Trevor's box)**
**Follow-on to [2026-08-29T1815Z](2026-08-29T1815Z-CORRECTION-my-own-jobid-211-dosimeter-filing-is-superseded-an-index-fixed-it-and-42s-class-C-signature-is-wrong.md), which recommended re-testing Class C members for a missing index. This is that test, run rather than left as a filing.**
⛔ **Nothing measured under load was turned into a cost.** This filing was written as a PREDICTION at
18:5xZ while the band was active (`io_wait 13 / active 13 of 48`) — **and then §4b measured it at
18:5xZ as the band lifted to `6 / 6 of 47`.** ✅ **The prediction is CONFIRMED by a controlled pair
(the projection is the only variable) — see §4b.** ✅ **And then §4c measured it properly at `io_wait 0 / active 1 of 42`: the full MV query is 77,514 ms in a completely idle window, and the base scan is 99.66% of it.** The sections are left in the order they were written, because the order is the method.

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

⚠ **This section was written BEFORE §4b and is superseded on its first three bullets — kept, not
edited away, because the sequence is the point: the claim started as a shape match and only became a
measurement when the band lifted.**

- ~~**No `EXPLAIN` was run.**~~ ✅ **Superseded by §4b** — plans obtained, and the projection is a
  clean discriminator. The original caution was right at the time: the band was active.
- ~~A bounded `count(*)` timed out at 25 s and is **not** evidence.~~ ⚠ **Still true as written** —
  that first timeout remains spell collateral. **What made §4b evidence is not the timeout, it is the
  CONTROL that completed beside it under the same conditions.** A timeout alone never became proof.
- ~~**The 60-day row count is unknown.**~~ ✅ **Now measured: 88,576**, against a planner estimate of
  21,960 — so the window is 4× larger than the planner believes and the fix is not unsized.
- ~~**STILL open: no `BUFFERS` or `Heap Fetches` count.**~~ ✅ **Closed by §4c once the band cleared:**
  control 13,155 buffers / **3** reads / 36 ms against payload 45,164 buffers / **18,540** reads / 7,022 ms,
  and the full MV query 77,514 ms with **99.66% in the base scan**.
- jobid **4** (`rpc-ccm-step2`, ratio **3%** — 10 s success vs 300 s failure) is the most extreme
  bimodality on the board and **was not investigated at all here.** ⓘ Note its command uses the
  working two-statement form (`SET statement_timeout = '300s'; SELECT …`), so unlike #43's population
  its ceiling is real. **n = 7 runs; classify before rating.**

## 4b. ✅ MEASURED AT 18:5xZ AS THE BAND LIFTED — the prediction is CONFIRMED by a controlled pair

Load had fallen to `io_wait 6 / active 6 of 47` (from 41 active at 18:06Z), so a bounded probe became
defensible. ⭐ **The discriminator is the PROJECTION, and nothing else: same table, same predicate,
same index, same `Index Cond`, same row estimate.**

| projection | plan | planner cost | behaviour |
|---|---|---:|---|
| `count(*)` only | **Index Only Scan** using `idx_pack_rips_collection_time` | **616.64** | **completed — 88,576 rows** |
| `count(*) FILTER (WHERE pull_value_usd IS NULL), count(*)` | **Index Scan** (same index, heap access) | **13,374.49** | **timed out at 45 s, twice** |

⭐⭐ **Adding one column to the SELECT list flips Index Only Scan → Index Scan on the same index and
multiplies the planner's cost 21.7×.** That column is `pull_value_usd` — exactly the payload the index
does not carry, and exactly the column the MV's CTE projects
(`SELECT COALESCE(pull_value_usd, 0) AS pv FROM pack_rips WHERE <this predicate>`). **My probe's
payload variant IS that CTE's base scan.**

🚨 **And the real cost is worse than the plan says: the planner estimates 21,960 rows; the actual count
is 88,576 — a 4× underestimate**, so the true number of heap visits is ~88.5k random fetches into a
756 MB table, not ~22k. Against the tier's 22 MB/s floor that is comfortably the difference between a
303 s success and a 602 s kill.

**This is the same defect as jobid 211, confirmed rather than asserted**: correct leading columns,
missing payload, heap fetch per row, bimodal outcome.

⛔ **What is still NOT measured — the honest boundary:**
- **No `BUFFERS`/`Heap Fetches` figure.** `EXPLAIN (ANALYZE, BUFFERS)` on the control **itself timed
  out at 45 s** moments after the bare count completed — ⚠ **two runs of the same query, opposite
  outcomes**, which is the contention confound this repo already documents. **So the evidence here is
  PLAN + BEHAVIOUR, not a buffer count.**
- ⚠ **Planner cost is an ESTIMATE, not a measurement.** The 21.7× is a cost ratio, not a speedup.
- ⛔ **Not proven that the fix takes jobid 237 under its ceiling** — only that the mechanism is present
  and is the one that was fixed on 211. **Predicted, not demonstrated.**

## 4c. ✅✅ THE QUIET-WINDOW MEASUREMENT — taken at `io_wait 0 / active 1 of 42`, and it is stronger than §4b

The band cleared completely at ~19:16Z. **All three numbers below are from that window, so none of them is spell collateral.**

**(i) The real MV defining query — the full CTE + six `UNION ALL` branches, exactly as `pg_matviews` stores it:**

```
Append  (actual time=77399.680..77509.350 rows=6)
  CTE rips
    -> Index Scan using idx_pack_rips_collection_time  (actual time=16.610..77250.934 rows=88553)
         Buffers: shared hit=26142 read=19017 written=571
  -> Aggregate (actual time=77399.679..77399.681)      <- first branch, pulls the CTE
  -> Aggregate (actual time=24.816..24.817)            <- branches 2..6, ~21-25 ms each
Execution Time: 77513.627 ms
```

⭐⭐ **The base scan is 77,251 ms of 77,514 ms — 99.66% of the query. The six aggregate branches together
are ~130 ms, 0.17%.** ⭐ **This is an INTRA-PLAN attribution, which is the robust kind** — it does not
depend on comparing two runs, and it is exactly the reading this repo endorsed on 2026-08-29 (*"within one
plan, total buffers ranks legs by work"*).

**(ii) The controlled pair, same predicate, same index, same window — the projection is the only variable:**

| leg | plan | buffers | disk reads | time |
|---|---|---:|---:|---:|
| `count(*)` only | **Index Only Scan** (Heap Fetches 10,332) | 13,155 | **3** | **35.98 ms** |
| `+ pull_value_usd` | **Index Scan** (heap) | 45,164 | **18,540** | **7,021.76 ms** |

**195× on time, 6,180× on disk reads, from adding one column to the SELECT list.**

## 👉 What this means, sized

**jobid 237's query costs 77.5 s in a COMPLETELY IDLE window, and ~99.7% of that is a scan whose entire
expense is fetching `pull_value_usd` from the heap.** Against a 303 s best observed success and a 602 s
ceiling, that is a job with **~4× headroom on an idle instance and none at all under load** — precisely the
bimodality, now with a number under it.

⚠ **Do NOT quote "77.5 s → 36 ms" as the expected fix.** The 36 ms control *counts*; it does not materialise
88,553 `numeric` values into the CTE's tuplestore, which the real query must do regardless of the index.
**The honest prediction is that the fix removes the heap access — 99.66% of the query's time — leaving
scan-plus-materialise, which is seconds at most, not 77.**

⚠ **One thing I could not explain and am not hiding: the same payload scan measured 7,022 ms in (ii) and
77,251 ms in (i), both in the quiet window, at near-identical read counts (18,540 vs 19,017).** The queries
differ — (ii) aggregates in place, (i) materialises a `numeric` CTE — so they are not a contradiction, but
**the 11× is unexplained and I did not isolate it.** ⭐ **The conclusion does not rest on it:** the
intra-plan 99.66% and the 3-vs-18,540 disk-read pair are each sufficient on their own.

## 5. 👉 The measurement that would still add something

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
