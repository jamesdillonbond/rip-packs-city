# `fmv-recalc` is NOT wedged mid-catalogue — page 0 can no longer COMPLETE, and the trust board has been breaching for 20 h unread

**Filed:** 2026-08-23 ~13:00 PT (20:00Z) · **By:** Claude Code, interactive · **Status:** MEASURED. Nothing shipped — FMV route logic + a migration, and R52's decision context applies.

🚨 **THE TITLE IS FALSIFIED — READ THE RE-TEST AT THE BOTTOM FIRST.** Page 0 completed at 20:28:06Z and
the arm self-cleared (its FIFTH). Severity is DOWN; the mechanism is unchanged. A second claim in this file,
the quiet-database control, is retracted mid-document.

## The live state

| trust-board metric | value | breach_at |
|---|---:|---:|
| `fmv_sweep_wedge_hours` | **20.07** | 3 |
| `fmv_sweep_stall_pct_24h` | 68.4 | 50 |
| `fmv_stale_touch_hours` | **21.1** | **36** ← the consequence to watch |

- **Cursor last advanced: `2026-08-22 23:33:47Z`.** 57 runs in the 24 h since; the cursor has not moved.
- Every recent run: `cursor_before = "0"`, `cursor_after = "0"`, `rows_written = 0`,
  `sales_refetch_failed: 1 chunk fetch errors (saturation-class)`.
- ⚠ **The metric's own baseline:** healthy p50 **0.20 h**, p95 0.55 h, and the 2026-08-05 saturation incident
  peaked at **6.00 h**. **20.07 h is 3.3× the worst previously recorded.**

## 🚨 The mechanism is NOT what the metric's name implies

`fmv_sweep_wedge_hours` was built to catch a **mid-catalogue wedge** — the sweep stuck at some offset on a
poisoned page. **That is not what is happening.** The cursor is pinned at **offset 0**, and page 0 is not
poisoned by data — it simply cannot be completed on this instance any more. Measured on a **quiet** database
(`4 active · 1 IO waiter · longest query 1.9 s`):

| step | measured |
|---|---:|
| `fmv_recalc_edition_page(90d, …, 500, 0)` — **cold** | **25,422 ms** |
| the same call — **warm** (immediately after) | **10,352 ms** |
| page-0 RPC **+ the FIRST 1000-row sales page** for its 500 editions | **> 55,000 ms (timed out)** |

So the sales re-fetch alone is **> 45 s for its first page** — and the route's own comment records that a hot
page carries **5k–12k in-window sales**, i.e. **5–12 such pages** before that ONE catalogue page is done.

⚠ **Therefore `(saturation-class)` in the error string is a MISATTRIBUTION.** Several of the failing runs
(17:48, 18:28, 18:44, 18:49Z) landed while the database was measurably quiet. The label is inherited from the
code path, not measured — and it makes the failure read as weather when it is cost.

> 🚨 **RETRACTED ~14:45 PT, same day — this paragraph's evidence does not hold.** The quiet reading
> (`4 active · 1 IO waiter`) was taken at **~19:50Z**, and I applied it backwards to failures at
> **17:48–18:49Z**. The daytime monitor's positive control at **~18:10Z** reads
> `io_wait=12 / active=11 / total=46` with `rpc_ops_snapshot()` timing out — a **saturation spell was ACTIVE
> across exactly that window** ([1812Z filing](2026-08-23T1812Z-daytime-monitor-saturation-spell-symptoms.md)).
> So `(saturation-class)` on those four runs may well be accurate, and **"the DB was quiet when they failed"
> is withdrawn.** ⚠ This is the repo's own rule biting: *a snapshot is not a distribution*, and a control must
> be contemporaneous with the thing it controls.
>
> **What the retraction does NOT touch — and it is the load-bearing half.** The structural claim is from
> `EXPLAIN`, not from timings: `ORDER BY MAX(s.sold_at)` forces the whole 90-day aggregate before `LIMIT`
> applies, so page 0's cost does not fall with offset. Since re-measured in **buffers**, which load cannot
> move: one 30-day page of `fmv_recalc_edition_page` reads **97,669 buffers**, and the same page reads
> **48,494** when the index it was built for is made reachable
> ([2130Z](2026-08-23T2130Z-postgres-17-makes-partial-indexes-with-is-not-null-predicates-unreachable.md)).
> **Page 0 is expensive because of its plan; saturation is what turns expensive into failed.** Both are true,
> and only the second is weather.

⚠ **And it is not the 2026-08-16 incident recurring.** That one was 14 of 17 runs over **12.4 h**, fixed by
adding retries (`queryWithRetry`, 3 attempts). The retries are still there and are still running; they cannot
help, because **nothing here is transient**.

## What is NOT broken, so the severity stays honest

**FMV freshness is fine and is being carried by other pipelines** (73 h):

| pipeline | rows written |
|---|---:|
| `refresh_wmc_fmv_changed` | 264,661 |
| `wmc-fmv-populate` | 127,364 |
| `populate-pinnacle-wmc-fmv` | 41,101 |
| `fmv-recalc` | 39,947 ← **earned BEFORE the wedge; 0 in the last 20 h** |

`topshot_fmv_stale_hours` 0.2 · `allday_fmv_stale_hours` 0.2 · `*_fmv_pct_stale_30d` 0.0 — all OK.
**So this is not a user-visible pricing outage today.** ⚠ **The clock that matters is
`fmv_stale_touch_hours` = 21.1 against a 36 breach — roughly 15 h away** if the sweep does not resume.

## The proposal, and why it is not shipped

The RPC is:

```sql
SELECT s.edition_id FROM sales s
WHERE s.sold_at >= p_window_start AND s.price_usd > 0
  AND s.collection_id <> p_pinnacle_collection_id AND s.edition_id IS NOT NULL
GROUP BY s.edition_id
ORDER BY MAX(s.sold_at) DESC NULLS LAST
LIMIT p_limit OFFSET p_offset
```

⚠ **`ORDER BY MAX(sold_at)` forces the FULL 90-day aggregate before `LIMIT` can apply** — the exact
"**a LIMIT bounds a query's OUTPUT, not its COST**" trap CLAUDE.md records for `drain_fmv_cold_tail`.
`EXPLAIN` confirms it: `Finalize GroupAggregate` over a `Parallel Index Scan` of **213,171** estimated rows,
then a Sort, then the Limit. **Every page pays for the whole window**, so the cost does not fall with offset —
which is why this is not a "bad page".

**Candidate levers, all needing a judgement this filing does not make:**
1. **Drop the recency ordering** (or order by `edition_id`) so the aggregate can stream and `OFFSET` gets
   cheap. ⚠ Changes WHICH editions are priced first — a product decision, not a mechanical one.
2. The precomputed latest-FMV-per-edition object (**R6 / R49 / R50**), already parked with Trevor under
   **R52** because the binding constraint is the disk.
3. **Advance the cursor after N consecutive failures at the same offset** so one uncompletable page cannot
   hold the whole catalogue. ⚠ Trades completeness for progress — also a judgement.

⛔ **Not shipped:** this is FMV route logic (explicitly off-limits to autonomous shipping) plus a migration
(**~10–20 s of user-facing `PGRST002` 500s**), and R52 has already parked the family of fixes with Trevor.

⚠ **Re-measure before acting** — all timings above are a dated sample taken in a window whose load I did
NOT positively control at the time (see the retraction above; prefer **buffers**, which load cannot move), and the
cold/warm spread (25.4 s → 10.4 s) shows how much the buffer cache moves them.

---

## 🚨 THE HEADLINE IS FALSIFIED — re-tested 2026-08-23 ~15:00 PT (22:00Z). Page 0 completed at 20:28:06Z, and the arm self-cleared.

**This filing's title says page 0 "can no longer COMPLETE". That is now measurably false**, and the test was
the one this repo insists on: *re-TEST a stated exit condition, never re-read it.*

`fmv_sweep_wedge_hours` is **no longer in the breach set** (the board now reads four:
`fmv_sweep_stall_pct_24h` 58.3, the two `999` board-liveness sentinels, and
`unmapped_resolution_backlog_max` 346). The cursor tells the same story directly:

| started_at (Z) | cursor_before → after | rows_written |
|---|---|---:|
| 19:42:20 | 0 → 0 | 0 (`sales_refetch_failed … (saturation-class)`) |
| **20:28:06** | **0 → 500** | **1,532** ← the unwedge |
| 20:35 / 20:48 | 500 → 1000 → 1500 | 500 / 498 |
| 20:59 & 21:08 | 1500 → 1500 | 0 (`fmv_recalc_edition_page timed out after ~27,300 ms`) |
| 21:28 → 21:55 | 1500 → 2000 → 2500 → 3000 → 3500 → **4000** | ~497 each |

**Page 0 completed roughly 38 minutes after this filing was written.** What I measured was real — it did not
complete inside my window — but *"cannot"* was the wrong tense, and stating it in the title is the part that
would have misled the next reader.

⚠ **AND IT IS THE FIFTH RECORDED SELF-CLEAR OF THIS EXACT ARM.**
[trust-board-and-safety.md](../../reference/trust-board-and-safety.md) already says
`fmv_sweep_wedge_hours` has cleared unaided four times and that it must be judged by **the gap distribution
and 24 h `rows_written`, never by hours-since-advance at one instant**. **This filing did precisely the thing
that doc warns against**, and the doc was right. On its prescribed instrument the pipeline is inside its
documented band: **60 runs / 21 ok / 11,493 rows in 24 h**, against CLAUDE.md's recorded characterization of
72.7% wall-kills and ~13,835 editions/day. **Wasteful, not broken — exactly the 2026-08-17
re-characterization, which I should have re-derived before filing.**

## What SURVIVES, and it is now better evidenced than when I filed it

The structural claim never depended on the wedge, and a **second, independent instrument** has since
corroborated it: the two failures at cursor 1500 are the route's own
`rpc fmv_recalc_edition_page timed out after 27,256 ms / 27,308 ms` — measured by the caller, not by my
`EXPLAIN`, and landing in the same range as the 25.4 s cold / 17.4 s reachable figures. **The page read is the
cost, and it is the cost whether or not the sweep is moving.** The reachability repair
([2130Z](2026-08-23T2130Z-postgres-17-makes-partial-indexes-with-is-not-null-predicates-unreachable.md))
addresses exactly that, and its case is unaffected by this retraction — it was always about buffers per page,
never about a wedge.

**Net: severity DOWN, mechanism UNCHANGED.** Treat this filing as *"page 0 is expensive enough to fail often"*,
not *"the sweep is stuck"*. ⚠ **Two of this filing's three headline claims have now been retracted in under
two hours** (the quiet-database control, and this). The measurements were fine; the tense and the severity
were not. **A one-instant reading justifies a MEASUREMENT, never a CHARACTERIZATION.**
