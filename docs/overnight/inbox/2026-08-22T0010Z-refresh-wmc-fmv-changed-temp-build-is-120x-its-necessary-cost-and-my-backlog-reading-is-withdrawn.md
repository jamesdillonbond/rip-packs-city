# `refresh_wmc_fmv_changed`'s temp-table build costs 120× what it needs to — and my own "permanently backlogged" reading of that function is WITHDRAWN

**Filed 2026-08-21 ~17:10 PT (2026-08-22 00:10Z), Claude Code interactive. MEASURED — warm-vs-warm, both
sides re-run, output sets compared. NOT shipped: FMV logic is off-limits for autonomous shipping.**

Amends the 23:15Z filing, which named this function as the estate's largest single reader
(**8.06% of all `shared_blks_read`, 69,954 blocks ≈ 546 MB per call, 6 calls/hour**) and described it as
running "a permanent backlog at a ~61% duty cycle". The cost figures stand. **The backlog reading does
not, and I am withdrawing it before anyone acts on it.**

---

## 1. ⚠ WITHDRAWN: "permanently backlogged"

I inferred a backlog from one fact — its p50 sits pinned at **364–377 s for 19 consecutive hours**
against a budget of `statement_timeout × 0.6` ≈ 366 s — i.e. it always spends its whole allowance.
**That is consistent with a backlog and does not establish one.** Two measurements made today cut
against it:

- The queue is **small**. At a 6-minute-old cutoff the temp-table build returns **897 distinct
  editions**, not tens of thousands.
- FMV production is **near zero for 19 hours a day** (23:15Z filing: 1–466 snapshots/hour across
  01:00–19:00Z vs ~2,800–4,100/hour in 20:00–00:00Z). During the band there is almost nothing new for
  this function to consume, so a queue that grows without bound is not the obvious story.

**What is actually established: it spends its full budget. WHY is unresolved.** ⚠ And it is not
decomposable from here — `pg_stat_statements` runs with `track = top`, so the loop's inner statements
never appear as rows, exactly as CLAUDE.md warns. Do not treat the 61%-duty-cycle number as a diagnosis.

## 2. What IS established: the temp-table build reads ~120× more than it needs to

`refresh_wmc_fmv_changed` opens by building `_rwfc_recent`:

```sql
SELECT DISTINCT ON (fs.edition_id) fs.edition_id, fs.computed_at
FROM public.fmv_snapshots fs
WHERE fs.computed_at > v_cutoff AND fs.fmv_usd IS NOT NULL
ORDER BY fs.edition_id, fs.computed_at DESC;
```

`EXPLAIN (ANALYZE, BUFFERS)`, same cutoff, same 897 output rows:

| plan | buffers | exec |
|---|---:|---:|
| **as written** (planner picks `fmv_snapshots_2026_edition_id_computed_at_idx`) | **8,720**, then **9,003** on a second warm run | 2.87 s → **4.63 s** |
| **filter in a `MATERIALIZED` CTE** (planner picks `idx_fmv_snapshots_2026_computed_at_desc`, then sorts) | **74** | **3.8 ms** |

⚠ **The incumbent is NOT suffering a cold cache, and I checked rather than assumed** — CLAUDE.md's
warm-vs-warm rule. Re-run warm it got *more* expensive (8,720 → 9,003 buffers), which is what a scan
larger than the cache budget does. It cannot get cheaper: the chosen index leads on `edition_id` while
the predicate is on `computed_at`, so there is no range to seek and the whole 2026 index is walked.

**Why the planner picks the bad one:** `DISTINCT ON` requires `ORDER BY edition_id, computed_at DESC`,
and that index supplies the ordering for free, avoiding a sort. It makes that trade on a **418×
overestimate** — `rows=374,991` estimated against `rows=897` actual. Materialising the filter first
removes the ordering incentive; the sort it then pays for is `quicksort Memory: 60kB`.

⚠ **Equivalence checked as a SET, not a count** (CLAUDE.md: diff the set): `EXCEPT` both directions —
897 vs 897, **0 rows only-in-incumbent, 0 rows only-in-candidate**.

## 2b. ⚠ STRONGER, added after four samples: THE COST DOES NOT TRACK THE OUTPUT AT ALL

The cron advanced the cutoff between my measurements, which handed me the decisive control for free.
Same statement, same session, four runs over ~25 minutes as the queue drained and refilled:

| output rows | buffers | exec |
|---:|---:|---:|
| 897 | 8,720 | 2.87 s |
| 897 | 9,003 | 4.63 s |
| **0** | **7,877** | **3.36 s** |
| 490 | 8,323 | 1.95 s |

**It costs ~8,000–9,000 buffers to return 897 rows, 490 rows, or NOTHING.** The floor is a full walk of
the 2026 index, paid on every call whether or not anything qualifies — the predicate bounds the OUTPUT,
not the COST. That is CLAUDE.md's own recorded rule, and the same family as `drain_fmv_cold_tail`
burning 86,275 buffers / 32.9 s to return **zero** candidates.

⚠ **The zero-row run needed a positive control and has one:** the identical predicate returned 897
before and 490 after, tracking `rwfc_state.last_cutoff` as the real cron moved it. The zero was a
genuine empty window right after a tick, not a broken query.

**This partly answers the question §1 leaves open.** It does not explain 366 s, but it establishes the
shape: the function pays a fixed per-call floor six times an hour, all day, *including through the 19
hours when FMV produces almost nothing for it to do*. Under the band's measured 3–18× that floor alone
is ~10–60 s per call for an empty queue. **"It has nothing to do" and "it is cheap" are not the same
statement here, and I assumed they were when I called it backlogged.**

## 3. ⚠ The lever is real but BOUNDED, and the arithmetic says so

**~9,000 of 69,954 blocks/call is ~13%.** So this rewrite removes roughly an eighth of the function's
reads — about **1% of the estate's total `shared_blks_read`** — and leaves ~61,000 blocks/call in the
loop unexplained. **It is not a fix for the 20-hour band.** Presenting it as one would repeat the error
the 23:15Z filing corrected in the deals filing: a real optimisation on a component that is not the
driver.

The remaining ~87% is the `LOOP`, which pops `v_chunk := 5` editions per iteration and per chunk runs a
correlated `ORDER BY computed_at DESC LIMIT 1` against `fmv_snapshots` plus an `UPDATE … FROM` join
against `wallet_moments_cache` (2.49M live rows). **That is where to look next, and it is unmeasured.**

## 4. Recommended, not done

1. **Wrap the filter in a `MATERIALIZED` CTE** inside `refresh_wmc_fmv_changed`. Two lines, no semantic
   change, no new index, set-verified above. ⛔ FMV logic — Trevor's call, and it should land in a
   low-traffic window because `apply_migration` costs a ~10–20 s burst of user-facing `PGRST002` 500s.
2. **Do NOT add an index.** `idx_fmv_snapshots_2026_computed_at_desc` already exists and is the one the
   candidate plan uses — this is a plan-choice problem, not a missing-index problem. (I expected a
   missing index and was wrong; recorded so the next person does not create a duplicate.)
3. **Measure the loop before touching `v_chunk`.** Its comment says the 5 is "sized to fit the SMALLEST
   caller budget (service_role 30s), never scaled up" — a deliberate constraint, so raising it is a
   decision with a stated reason behind it, not a free win.
