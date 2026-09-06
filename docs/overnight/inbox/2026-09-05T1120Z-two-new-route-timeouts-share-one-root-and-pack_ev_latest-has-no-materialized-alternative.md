> # ✅ RESOLVED 2026-09-05 ~06:50 PT — SHIPPED as migration `20260905134612`. Read this banner, not the body.
>
> **The body's "not shipped, operator-gated" verdict was MY OWN ERROR and is superseded.**
> I inherited the 2026-08-30 verdict (*"destructive multi-object SQL on a public read surface is
> outside what an autonomous pass ships"*) and applied it to the wrong object. That verdict is about
> **`mv_pack_ev_latest`, a MATERIALIZED view** whose rewrite needs `DROP … CASCADE` across dependents
> with divergent ACLs. 🚨 **`pack_ev_latest` is `relkind = 'v'` — a PLAIN VIEW.** `CREATE OR REPLACE
> VIEW` cannot change the column list, so its **68 dependents are untouched by construction**: no drop,
> no cascade, no ACL or reloption loss. None of the blast-radius reasoning applied.
>
> **What shipped:** the correlated `EXISTS` on `pack_ask_state` (128,911 loops, 382,519 buffers, zero
> rows every loop) became a `LEFT JOIN` on the UNIQUE `(collection_slug, dist_id)` key, with a
> `COALESCE` guard so a future NULL `gross_ev` cannot change the result. Filters still run **before**
> the `DISTINCT ON` — moving them would be a semantic change, not an optimisation.
>
> **Equivalence proven over the population both directions before applying:** 4,642 / 4,642,
> `EXCEPT` 0 each way, `INTERSECT` 4,642. **Measured:** `pack_ev_latest` 707,048 → 10,898 buffers (65×);
> `v_topshot_pack_reality_ranker_staleness` 705,997 → 10,907; `v_topshot_pack_ev_calibrated` 707,584 →
> 12,618. Live after: `/api/public/insights/pack-reality` **200 in 2.1 s cold / 0.26 s warm**;
> `/api/packs?collection=nba-top-shot` **200 in 2.2 s, 100 rows**.
>
> ⚠ **Still true from the body, and still worth reading:** the `mv_pack_ev_latest` swap is **measured
> dead** (0 of 7 needed columns, different grain) — do not re-propose it. And the honest new cost is a
> **~28–49 MB external sort per execution**; sized before shipping at tens of calls/hour, so not a
> concurrency hazard, but it would become one if a high-frequency caller were added.
>
> ✅ **CLOSED 2026-09-06 16:05Z — the falsifier was RUN and both routes are silent.** Zero events on `/api/public/insights/pack-reality` and `/api/packs` across **26.3 h** since migration `20260905134612`, against a measured pre-migration **~1.0/h** ⇒ `P(0) ≈ 4e-12`. The stated exit date ("after 2026-09-06") has arrived and the condition is met.
> ⚠ **The positive control was re-run AT CLOSE rather than assumed** — the same filter over the pre-migration window still returns **2 and 2**. That is not ceremony: this exact query produced a **false all-clear** on 09-05 because `routes: "/insights/pack-reality"` matched nothing (the real path is `/api/public/insights/pack-reality`), and *"No runtime errors found"* reads as good news either way.
> ⭐ **The DATE is what made this close trustworthy.** At 14:00Z on 09-05 it already sat at p≈0.07 and looked closeable; setting a date instead of a p-value is what stopped an early close on a statistic that had not finished moving.
>
> *(Original exit condition, for the record:)* ⏳ **The falsifier still stands and is the only thing that closes this:** the two Vercel error groups
> must **stop**. Re-read `get_runtime_errors` for those routes after 2026-09-06. If they keep firing,
> the view was not the binding cost.

# Two NEW route timeouts appeared in the last 18h, they share ONE root, and the cheap fix is refuted

**Filed 2026-09-05 ~11:20Z (04:20 PT) — Cowork, cloud, autonomous night pass.**
**Nothing shipped from this filing.** The lever lands inside the pack-EV family, which this
ledger has twice reserved for Trevor; what is new here is that the queued item now has
**user-facing cost on two read paths**, and that the obvious cheap fix is **measured and dead**.

## What is new

Vercel runtime errors, 12h window, 21 groups read in full. Nineteen are known. **Two are new**,
and they are the two newest groups by `first`:

| group | route | count / users | first seen |
|---|---|---|---|
| `v_topshot_pack_reality_ranker_staleness` read exceeded 8000ms | `/api/public/insights/pack-reality` | 6 / 2 | **2026-09-04 16:38Z** |
| `[api/packs] calibrated merge [v_topshot_pack_ev_calibrated] read exceeded 8000ms` | `/api/packs` | 2 / 1 | **2026-09-05 06:17Z** |

Both are `RPC_READ_TIMEOUT` from `boundedRead` at its 8,000 ms ceiling. Both are on **public,
unauthenticated** surfaces.

⚠ **`public_board_slow_count` reads clean right now, and trust health shows only the known
`unmapped_resolution_backlog_max` breach.** This is the trap the night-pass skill names in those
words — *"`public_board_slow_count` = 0 does NOT mean the boards are healthy … for public-page
health the instrument is Vercel runtime logs."* It held exactly as written: the DB-side probe
saw nothing and the runtime log had both.

## They are ONE finding, not two

`v_topshot_pack_ev_calibrated` and `v_topshot_pack_reality_ranker_staleness` both expand
`pack_ev_latest`, and in both plans **that expansion is over 99.7% of the entire query**:

```
ranker_staleness   Aggregate  1,320 ms   shared hit = 705,997   → returns 1 row (over 3)
  └─ pack_ev_latest                      shared hit = 705,988
calibrated         Aggregate  1,213 ms   shared hit = 707,584   → returns 810 rows
  └─ pack_ev_latest                      shared hit = 705,987
     (the calibrated view's OWN work: 1,591 buffers. The staleness view's own: 9.)
```

**706k buffers to answer a question whose answer is three rows.**

## Inside `pack_ev_latest`, and the part that is not the DISTINCT ON

```
Unique                                  rows=4,642
 └─ Index Scan idx_pack_ev_history_listing_time on pack_ev_history
      rows=313,682   buffers=705,987
      SubPlan 3 → Index Scan pack_ask_state_pkey
          loops = 128,712      buffers = 381,922      rows=0 every time
```

⭐ **The `DISTINCT ON` walk is the known half; `SubPlan 3` is the half worth naming.** It is the
`NOT EXISTS` arm of `(collection_id <> topshot OR NOT EXISTS (…pack_ask_state…))`, and it is
evaluated **per history row, before deduplication** — 128,712 times, for **381,922 buffers, 54%
of the whole query**, returning zero rows on every single loop. After the `Unique` there are
4,642 rows. **Evaluating that predicate after deduplication instead of before it would run it
~27× fewer times.**

⛔ I am **not** claiming the planner can simply be told to do that, and I did **not** test a
rewrite. `pack_ev_latest` is a shared view on several surfaces and its filter semantics are
load-bearing; a reordering that changes which rows survive is a data defect, not a speedup.

## ⛔ The obvious cheap fix is REFUTED — read this before proposing it

The natural first idea is *"point these two views at `mv_pack_ev_latest`, which already exists
and is refreshed every 30 minutes by jobid 73."* **Measured, and it does not work:**

```
pack_ev_latest      4,642 rows
mv_pack_ev_latest   1,858 rows
columns of the 7 the staleness view needs
  (collection_id, dist_id, is_positive_ev, pack_price,
   depletion_pct, fmv_coverage_pct, snapshotted_at)
  present in mv_pack_ev_latest:                      0 of 7
```

Different grain (`mv_pack_ev_latest` is `DISTINCT ON (pack_listing_id)`; `pack_ev_latest` is a
different key entirely) and a disjoint column set. **It is not a drop-in and never was one.**
Recorded so the next session inherits the refutation rather than the idea.

## Why this is filed and not shipped

The 2026-08-30 ledger entry — *"`mv_pack_ev_latest` touches 304,034 buffers to produce 1,855
rows"* — worked the sibling object, proved equivalence in both directions, and **still did not
ship**, because the change is `DROP MATERIALIZED VIEW … CASCADE` across two dependent views with
deliberately different ACLs and a `security_invoker=on` reloption *"silently stripped four times
in this repo"*. Its verdict: **"destructive multi-object SQL on a public read surface is outside
what an autonomous pass ships."** That judgement is not weakened by tonight's finding, and I am
not relitigating it.

⭐ **What tonight adds is the argument that entry could not make: it is no longer only a cron
cost.** That filing explicitly declined to claim urgency — *"nothing is starved."* Something is
now: two public routes are crossing their read bound, and the newest of them started **18 hours
ago**. `pack_ev_latest` is a **different object** from the one that filing measured, and unlike
that one it has **no materialized alternative to switch to** — which is the whole point of the
refutation above.

⚠ **Do NOT "fix" this by raising the 8,000 ms bound.** Both legs are correctly bounded and both
degrade honestly — the staleness leg is deliberately non-fatal (`20260902032401` registered it
outside the board's fatal set precisely so a slow leg cannot become a 503, and `ranker_staleness`
simply renders null). Raising the bound would hide a real regression in exchange for nothing a
reader can see.

## Numbers, with their sample stated

- **Warm** executions: 1,320 ms and 1,213 ms. **One cold-ish first touch: 7,441 ms** — against an
  8,000 ms bound, which is exactly why the failures are intermittent rather than total.
- ⭐ Quote the **buffers**, not the milliseconds: **705,987**, identical in both plans and
  independent of cache luck. This repo has already been burned once publishing a cold-vs-warm
  ratio on this very table family, and that correction is in the 08-30 entry.
- `pack_ev_history` is **313,682 rows scanned / 6,032 removed by filter** in the window measured;
  the table was VACUUMed and given `autovacuum_vacuum_insert_threshold = 5000` on 2026-08-30, so
  **this is not the un-vacuumed heap-fetch disease** that entry diagnosed — the visibility map is
  current and the cost is genuine work.

## Falsifiers — what would show this filing is wrong

1. If the two error groups stop without any change, the cause was load, not shape. **Re-read
   `get_runtime_errors` for these two routes after 2026-09-06 and check `last`.**
2. If a warm-vs-warm pair on a rewritten `pack_ev_latest` does **not** move `705,987` materially,
   the SubPlan reading is wrong and the cost is the `Unique` walk alone.
3. If `pack_ask_state` is ever populated such that `SubPlan 3` returns rows, the predicate is
   doing real work and "evaluate it later" changes results — check before touching it.

---

## INTERIM READING on the falsifier — 2026-09-05 14:00Z, Claude Code (Trevor's box)

⚠ **This does NOT close the item.** The stated exit condition is "re-read `get_runtime_errors` for those routes after 2026-09-06", and that date has not arrived. Recorded so the next reader starts from data rather than from zero.

**Migration `20260905134612` applied 13:46Z. Both error groups' LAST occurrence predates it:**

| group | count | first | **last** |
|---|---|---|---|
| `pack-reality` / `v_topshot_pack_reality_ranker_staleness` | 8 | 09-04 16:38Z | **09-05 11:21Z** |
| `api/packs` / `v_topshot_pack_ev_calibrated` | 4 | 09-05 06:17Z | **09-05 11:39Z** |

## SECOND INTERIM READING — 2026-09-05 20:00Z, Claude Code (Trevor's box)

⚠ **Still does NOT close the item** — the stated exit condition is *"after 2026-09-06"* and that date has not arrived. But the evidence is now an order of magnitude stronger than the 14:00Z reading, and it was nearly recorded WRONG.

🚨 **THE FIRST ATTEMPT AT THIS READING WAS A FALSE ALL-CLEAR, caught only by a control.** Filtering `get_runtime_errors` on `routes: "/insights/pack-reality"` returned **"No runtime errors found"** — which reads as good news and is in fact **a filter that matched nothing**. The real route is **`/api/public/insights/pack-reality`**. ⭐ **The control that caught it:** run the SAME filter over a window where events are known to exist. It returned zero there too, which is impossible if the filter works — so the filter, not the platform, was the thing that had gone quiet.

**With the corrected paths, the control passes and the reading means something:**

| window (UTC) | `/api/public/insights/pack-reality` | `/api/packs` |
|---|---:|---:|
| 09:45 → 13:46 (pre-migration, **positive control**) | **2** (last 11:21:26Z) | **2** (last 11:39:06Z) |
| **13:46 → 20:00 (post-migration, 6.23 h)** | **0** | **0** |

**Freshly measured pre-migration rate: 4 events / 4.0 h ≈ 1.0/h combined** — close to the 1.17/h this filing estimated, so the base rate is stable and not an artifact of the earlier window.

**P(0 in 6.23 h | the fix did nothing) = e^(−6.23 × 1.0) ≈ 0.002** (≈ 0.0007 at the filing's own 1.17/h). Against ≈0.07 at 14:00Z.

⛔ **Why this still is not a close.** The exit condition was set as a DATE, not a p-value, and dates are how this repo avoids talking itself into an early close on a statistic that has not finished moving — a trap it fell into twice today on a different watch. **Re-read after 2026-09-06 with the routes above, and note the route strings, because the obvious ones are wrong.**

⛔ **Zero events since the migration is NOT yet evidence.** At the observed base rates (≈0.43/h and ≈0.74/h) the ~2.3 h since predicts only **~2.7 events combined**, so P(0 | the fix did nothing) ≈ **0.07**. Suggestive, and exactly why the filing set a next-day exit condition rather than a green tick.

**Direct cold probes, same window** — cache-busted so each is a real read, not an edge hit:

```
/api/public/insights/pack-reality   200  2.41s / 2.07s / 1.85s   cache=MISS ×3
/api/packs?collection=nba-top-shot  200  2.00s / 2.14s / 1.84s   cache=MISS ×3
```

**6 of 6 cold, all 1.8–2.4 s against the 8 s bound** — comfortably clear, with no run even approaching it.

⭐ **One incidental confirmation worth keeping.** The stored error reads:

```
code: 'RPC_READ_TIMEOUT',
message: '[api/public/insights/pack-reality/…] read exceeded 8000ms'
```

That `code` is the constant added on 2026-09-04 so a bound timeout classifies as a retryable **503** instead of a hard 500 across 86 routes. **This is it working end to end in production** — the bound fired, stamped the code, and the code survived into Vercel's error grouping where an operator can see it. Before that change these were indistinguishable from genuine internal errors.
