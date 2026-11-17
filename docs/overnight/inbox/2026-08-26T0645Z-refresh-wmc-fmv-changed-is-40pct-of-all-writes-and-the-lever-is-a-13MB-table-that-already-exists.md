# 🚨 `refresh_wmc_fmv_changed` is 40% of every block this database dirties — and its lever is a 13 MB table that already exists

**Filed:** 2026-08-25 ~23:45 PT (2026-08-26 06:45Z) · **By:** Claude (Cowork cloud), interactive
**Status:** MEASURED, equivalence PROVEN over a hash sample, **NOT SHIPPED — push-gated**, see §5
**Class:** R46 · the largest single consumer on the instance in all three IO dimensions

## 1. The headline

From `pg_stat_statements`, window **14.2027 d** (reset 2026-08-12 01:34Z). ⚠ dated sample.
The function appears twice because it has **two independent callers**:

| entry | calls/d | disk GB/d | dirtied/d | WAL MB/d | s/d |
|---|---:|---:|---:|---:|---:|
| `SELECT public.refresh_wmc_fmv_changed($1,$2)` — pg_cron jobid 303 | 122.9 | 69.40 | 4,528,732 | 9,822 | 36,545 |
| `…refresh_wmc_fmv_changed(p_since_minutes, p_limit)` — PostgREST | 162.9 | 8.76 | 442,924 | 995 | 2,990 |
| **combined** | 285.8 | **78.2** | **4,971,656** | **10,817** | **39,535 (11.0 h/day)** |

Against instance totals of ~780 GB/day read, 12.38M blocks dirtied/day and 28.4 GB/day of WAL:
**10.0% of reads, 40.2% of all blocks dirtied, 37.2% of all WAL, 11 hours a day of exec time.**
It is larger, by itself, than the entire pack-sales-history cluster filed alongside this.

## 2. ⛔ The obvious lever is FALSIFIED — record it so nobody spends the afternoon

A `pg_stat_statements` sweep proposed the cause as `v_chunk constant integer := 5` in the body:
"5 editions per loop iteration, so the loop runs thousands of times; raise the chunk."

**Measured, it does not hold.** The loop's working set is `_rwfc_recent` = distinct editions with
a new non-null FMV snapshot inside the cutoff window. For the production call
(`p_since_minutes = 30`) that is **515 rows** — so the loop runs ~103 iterations, each deleting
from a 515-row temp table. That is not where 4.97M dirtied blocks come from.

⭐ **A plausible mechanism is not a measurement, and this one is a good example**: the chunk
constant is conspicuous, sits right at the top of the body, and carries a comment that invites
the conclusion. It is still not the cost.

## 3. Where the cost actually is, read from the plan

```sql
latest_fmv AS MATERIALIZED (
  SELECT e.collection_id, e.external_id,
    (SELECT f.fmv_usd
       FROM public.fmv_snapshots f
      WHERE f.edition_id = e.id AND f.fmv_usd IS NOT NULL
      ORDER BY f.computed_at DESC LIMIT 1) AS fmv_usd
  FROM popped p JOIN public.editions e ON e.id = p.edition_id
)
```

`EXPLAIN` on that correlated subquery, for **one** edition:

```
SubPlan 1
  ->  Limit  (cost=0.68..1.92)
        ->  Append  (cost=0.68..82.51 rows=66)
              ->  Index Scan using fmv_snapshots_2027_edition_id_computed_at_idx …
              ->  Index Scan using fmv_snapshots_2026_edition_id_computed_at_idx  (rows=64)
              ->  Index Scan using fmv_snapshots_2025_edition_id_computed_at_idx …
```

**It carries no partition key, so it fans out across every `fmv_snapshots` partition** (707 MB
total) and the 2026 leg alone expects to read 64 rows to return 1. This runs **once per edition**:
515 editions × 285.8 calls/day ≈ **147,000 times a day**.

## 4. ⭐ The lever already exists and is 13 MB

`public.edition_fmv_current` — a real table, **13 MB**, keyed on `edition_id`, columns
`(edition_id, collection_id, fmv_usd, floor_price_usd, confidence, computed_at, refreshed_at)`.
It is exactly the "latest FMV per edition" object R52 keeps asking for, and it is already built
and already being maintained (**3,168 rows refreshed in the last hour**, newest `computed_at`
2026-08-26 05:56Z, i.e. ~3 minutes before this measurement).

**The change is one CTE:**

```sql
latest_fmv AS MATERIALIZED (
  SELECT e.collection_id, e.external_id,
         COALESCE(efc.fmv_usd,
                  (SELECT f.fmv_usd FROM public.fmv_snapshots f
                    WHERE f.edition_id = e.id AND f.fmv_usd IS NOT NULL
                    ORDER BY f.computed_at DESC LIMIT 1)) AS fmv_usd
  FROM popped p
  JOIN public.editions e ON e.id = p.edition_id
  LEFT JOIN public.edition_fmv_current efc ON efc.edition_id = e.id
)
```

### The equivalence claim, and it was PROVEN rather than asserted

Scoping or re-sourcing an aggregate is an equivalence claim, which this repo requires be proven
over the population. Hash-sampled (`abs(hashtext(id::text)) % 100 = 7`), **274 editions**:

- **229** have a non-null latest snapshot
- **224** have a non-null `edition_fmv_current.fmv_usd`
- **disagreements where BOTH are present: 0**
- **5** where the snapshot exists and `edition_fmv_current` does not

So the two agree **exactly** on value, and differ only in **coverage**. Coverage gap, measured on
the whole population rather than the sample:

- **171** of 27,257 editions have no `edition_fmv_current` row at all (0.63%)
- of the **4,550** rows whose `fmv_usd` is NULL, a 250-row hash sample finds **4 (1.6%)** that do
  have a non-null snapshot → ~73 estate-wide
- **total gap ≈ 244 / 27,257 = 0.9%**

⭐ **This is why the recommendation is `COALESCE` and not a straight swap** — and the COALESCE
form is strictly better than what R52's note implies. A bare `LEFT JOIN` would silently skip those
244 editions (the UPDATE already filters `lf.fmv_usd IS NOT NULL`), which is under-propagation
rather than a wrong price, but it is still a silent coverage loss. `COALESCE` takes the 13 MB
path for **99.1%** and falls back to the correlated scan for **0.9%** — a ~99% cut in the
expensive lookup with **no** behaviour change at all.

⚠ **What this does NOT claim.** It removes the READ fan-out. The **write** half — the UPDATE on
`wallet_moments_cache` (2,909 MB) — is doing real work: `wmc.fmv_usd IS DISTINCT FROM lf.fmv_usd`
is already a change-detection guard, so those 4.97M dirtied blocks are genuine cache updates
scattered across a large table. **Expect the read figure to fall sharply and the dirtied/WAL
figures to fall much less.** Anyone who ships this and then quotes a 40% write saving will be
wrong.

## 5. ⛔ Why it is not shipped tonight — and this is a STRUCTURAL finding, not an excuse

`refresh_wmc_fmv_changed` carries a DB-invariant pin at `supabase/tests/refresh_wmc_fmv_changed.sql`,
which embeds a VERBATIM copy of the body. Changing the function without re-pointing the pin turns
`.github/workflows/db-pin-staleness.yml` red the next morning — and CLAUDE.md's own rule is that
**re-pointing the pin is part of shipping the change, not a follow-up chore.** Re-pointing means
committing a file, and this session has no git push.

⭐ **Generalised, because it reframes what "DB work ships without a push" means:**

> **A pinned SQL function is PUSH-GATED even though the migration itself is not.** The levers a
> no-push session actually has are: **pg_cron schedules**, **indexes**, and **brand-new objects
> that no pin describes yet.** Everything else creates a repo obligation in the same turn.

Checked against tonight's candidate list — pinned, therefore push-gated: `refresh_wmc_fmv_changed`,
`fmv_recalc_edition_page`, `roll_pack_ask_hourly_low`, `backfill_wmc_fmv_confidence`. That is why
tonight shipped an index and two cron schedules and nothing else.

## 6. Two more from the same sweep, unshipped, same gate

- ⚠ **jobid 303 and `/api/wmc-fmv-populate` drain the SAME single-row `rwfc_state` queue on two
  independent schedules.** That is the 2026-08-14 "two schedulers run the same FMV propagation"
  shape, still live. **Not acted on** — which of the two is the intended owner is a decision, and
  removing the wrong one loses propagation entirely.
- **Four `ON CONFLICT DO UPDATE`s carry no change-detection predicate** —
  `roll_pack_ask_hourly_low` (305k dirtied/d), `upsert_pack_ask_state` (385 MB WAL/day to maintain
  a **4 MB / 5,640-row** table — the worst ratio on the instance), `apply_sales_counterparty`
  (181k dirtied/d), `refresh_wmc_fmv_drift_active` (143k dirtied/d + 16.0 GB read/d). Adding
  `WHERE (t.*) IS DISTINCT FROM (EXCLUDED.*)` to each is mechanical. Two of the four are pinned.


---

## 🚨 SELF-CORRECTION, SAME SESSION — the `COALESCE` form in §4 is WRONG and would have published prices up to 59% off

**Caught by a recorded memory constraint, then MEASURED rather than deferred to.** The project
memory carries: *"`edition_fmv_current` … ⛔ **ORDERING and bulk aggregation ONLY, never a displayed
price.**"* §4 proposed sourcing `wallet_moments_cache.fmv_usd` from it — and that column **is** a
displayed price. So the recommendation contradicted a standing decision, and the honest move was to
test the decision rather than either obey or override it.

### The decisive population is not the one §4 sampled

§4 sampled editions at random and found **0 value disagreements**. That sample is real and it is
**the wrong population**. The population that matters is the one this function exists to serve:
editions whose latest FMV snapshot landed inside the cutoff window. Measured on exactly that set —
**697 editions with a snapshot in the last 30 minutes**:

| | count | share |
|---|---:|---:|
| missing from `edition_fmv_current` | 0 | 0% |
| value **matches** the latest snapshot | 664 | **95.3%** |
| value **LAGS** the latest snapshot | **33** | **4.7%** |

**Maximum lag: 610,183 s = 7.06 DAYS.** And the lag is not cosmetic:

| edition | latest snapshot | `edition_fmv_current` | error | lag |
|---|---:|---:|---:|---:|
| `0e212d43…` | **$11.00** | $4.50 | **−59%** | 168.1 h |
| `34c86349…` | **$117.00** | $163.00 | **+39%** | 168.0 h |
| `acd48ef8…` | **$74.00** | $49.00 | **−34%** | 168.0 h |

⛔ **A bare `COALESCE` would have written those into a user-visible wallet valuation, and nothing
would have caught it** — the function's `wmc.fmv_usd IS DISTINCT FROM lf.fmv_usd` guard happily
writes a stale value, because stale and correct are both "distinct from what is there".

⭐ **The general lesson, and it is the one worth keeping: an equivalence proof is only as good as
the population it was taken over.** Sampling *all* editions measured the steady state; the function
operates exclusively on the *recently changed* tail, which is precisely where a periodically-rebuilt
snapshot lags by construction. **Sample the population the code actually touches, not the table.**

### ⭐ The fix survives — it just has to be FRESHNESS-guarded, not NULL-guarded

`_rwfc_recent` already carries `(edition_id, computed_at)`, where `computed_at` is the timestamp of
the newest qualifying snapshot. And `edition_fmv_current.computed_at` is the **source snapshot's**
timestamp (verified on the lagging rows: `computed_at` reads 2026-08-19 while `refreshed_at` reads
2026-08-23 — which independently confirms the standing memory note that **`refreshed_at` means
"last CHANGED", not "last refreshed"**, and is unusable as a freshness key; `computed_at` is honest).

So the two can be compared directly:

```sql
popped AS (
  DELETE FROM _rwfc_recent
   WHERE edition_id IN (SELECT edition_id FROM _rwfc_recent ORDER BY computed_at LIMIT v_chunk)
  RETURNING edition_id, computed_at            -- ⬅ one extra column, this is the whole change
),
latest_fmv AS MATERIALIZED (
  SELECT e.collection_id, e.external_id,
         COALESCE(efc.fmv_usd,
                  (SELECT f.fmv_usd FROM public.fmv_snapshots f
                    WHERE f.edition_id = e.id AND f.fmv_usd IS NOT NULL
                    ORDER BY f.computed_at DESC LIMIT 1)) AS fmv_usd
  FROM popped p
  JOIN public.editions e ON e.id = p.edition_id
  LEFT JOIN public.edition_fmv_current efc
         ON efc.edition_id = e.id
        AND efc.computed_at >= p.computed_at   -- ⬅ take the fast path ONLY when it is at least
                                               --    as fresh as the change being propagated
)
```

**Why this is provably correct rather than merely better:** the fast path is taken only when
`edition_fmv_current` is at least as fresh as the snapshot that put this edition in the queue, so
the written value can never be older than the change being propagated. Where it is not, the join
yields NULL and the existing correlated subquery runs unchanged. **Measured share taking the fast
path: 95.3%** — so the read fan-out still falls by roughly 20x, with **no** staleness surface.

⚠ **This does NOT lift the standing "never a displayed price" rule for `edition_fmv_current`
generally.** It shows the rule has a safe exception *when the caller can prove freshness against a
timestamp it already holds*. Any other caller must make that proof itself or stay on the rule.

⭐ **And record the near-miss, because it is the transferable part: a recorded DECISION that
contradicts your measurement is not automatically stale — test it before overriding it.** This one
was right, the measurement that appeared to license overriding it was taken over the wrong
population, and obeying it blindly would ALSO have been wrong (it would have discarded a real 20x
read win). **The third option — measure what the decision was protecting — is the one that worked.**

---

## ⓘ Two candidates MEASURED AND DECLINED the same night — with numbers, because a decline without one is the shape this repo says nobody re-checks

### 1. `panini_squeeze_board` — the 26.24 GB/day headline is HISTORY, not a target

The `pg_stat_statements` sweep ranked it 5th at **26.24 GB/day of disk reads, 4,834 blocks per
call**, and proposed a partial index on `mv_panini_squeeze (fmv_usd DESC) WHERE fmv_usd IS NOT NULL`.

⛔ **Refuted by an `EXPLAIN (ANALYZE, BUFFERS)` on the live query — the current cost is 256 buffers
per call, not 4,834:**

```
Limit  Buffers: shared hit=3 read=253
  ->  Sort (top-N heapsort, 31kB)
        ->  Seq Scan on mv_panini_squeeze m  (actual rows=4703)  Buffers: shared read=253
Execution Time: 88.225 ms
```

The view was repointed onto an MV on 2026-08-22/23 — **mid-window** — while the statement text (and
therefore the `queryid`) never changed, so the 14.2-day average blends the pre-MV live-view period
with the post-MV one. **Current true cost ≈ 711 calls/day × 256 blocks = 1.4 GB/day**, already down
~19× from the headline.

⭐ **And the proposed index would not help even now:** the MV is 2.3 MB / 253 blocks, the scan
returns 4,703 of 4,708 rows (`Rows Removed by Filter: 5`), and the projected columns are not in any
candidate index — so an index scan would still visit the heap for nearly every row. **A seq scan of
253 blocks is the right plan.** Declined; no index added.

⭐ **The transferable half: a `pg_stat_statements` entry whose underlying OBJECT changed mid-window
is a blended number wearing a stable `queryid`.** Nothing in `pg_stat_statements` marks it. Check
`stats_since` against the migration log before treating any top-N entry as a live target.

### 2. jobid 16 `rpc-backfill-pack-pool` — a 100%-no-op job, and cutting its cadence is still wrong

Observed live tonight: **every tick returns `{"done":true,"mode":"pool","processed":3,"ok":0,
"fail":3,"emptyEds":3,"poolRows":0}`** — the wedged-head defect, firing 288×/day and accomplishing
nothing. The obvious lever is a cadence cut, which is a pg_cron change and therefore one of the few
things a no-push session *can* ship.

**Measured cost:** `get_topshot_pool_backfill_targets` at 178 calls/day, **2.26 GB/day of disk
reads** (1,663 blocks/call, 1,969 s/day), plus the pool insert/delete pair at ~1,690 calls/day and
0.28 GB/day. **Total ≈ 2.5 GB/day = 0.32% of the instance's ~780 GB/day.**

⛔ **Declined, and the arithmetic is the reason rather than caution.** The head is wedged by 3
unconvertible distributions; **710 rows are unconverted, 351 of them with real rips.** The moment
the ordering defect is fixed — a function change, so push-gated, plausibly this week — that backlog
drains at `limit=3` per tick: **864 items/day at the current cadence, 72/day at hourly.** So an
hourly cut trades **0.32% of the read budget** for a **12× slower drain of a 710-item backlog the
day it becomes drainable**. That is a bad trade, and it would look like a good one in a summary that
quoted only the GB.

⭐ **The pairing is the point: the same lever (a pg_cron cadence cut) was CORRECT for the pack-sales
backfills — 71.9 GB/day for ~165 rows, no backlog — and WRONG here at 2.5 GB/day with a real
backlog behind a wedge. "Cut the cadence of a wasteful job" is not a rule; the ratio of cost to
blocked work is.**
