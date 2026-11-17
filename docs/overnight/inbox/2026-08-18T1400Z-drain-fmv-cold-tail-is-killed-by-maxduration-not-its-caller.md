# `drain-fmv-cold-tail`: the caller is healthy — the `after()` work is killed at `maxDuration`, and has been since June

**Filed 2026-08-18T1400Z (07:00 PT) · Cowork cloud · READ-ONLY · route code ⇒ HANDOFF, not shippable from here**

## Both prior hypotheses are refuted, including mine

| hypothesis | verdict |
|---|---|
| cron-job.org's 30 s cap killed the caller (mine) | ⛔ **refuted** — drawn from a 4-run window; over the full window it was the 18th of 111 runs to cross 30 s |
| caller disabled/deleted, or auth/quota failure at the caller | ⛔ **refuted** — the caller is firing on cadence |

**Measured, 14 h window:** `/api/admin/drain-fmv-cold-tail` took **28 invocations** — ~2/hour, exactly
its 30-minute schedule — while `pipeline_runs` recorded only **9** rows. All 28 returned **202**.

## The mechanism, named

`get_runtime_errors`, route-scoped:

```
Vercel Runtime Timeout Error: Task timed out after 60 seconds
count=21  routes=/api/admin/drain-fmv-cold-tail
first=2026-06-16T13:24:05Z   last=2026-08-18T13:17:12Z
```

`export const maxDuration = 60` in the route — the error matches it exactly. **The 202 is returned
before the work starts**, so the caller sees success and never disables the job; the drain loop *and*
the `pipeline_runs` insert both run inside `after()`, and the platform kills the function mid-loop.
**A killed tick writes no row, logs no `ok=false`, and looks identical to a cron that never fired.**

⚠ **This is CLAUDE.md's own documented trap, live and unmitigated on this route:** *"Any `after()`
route needs an invocation heartbeat under a separate `<pipeline>-heartbeat` name, or a killed tick is
indistinguishable from a cron that never fired."* No heartbeat exists here.

### The route already tried to guarantee this and the guard has a hole

Comment at the `after()` block, dated 2026-06-11:

> *per-slug RPC wrapped in try/catch so a THROW … no longer rejects the whole `after()` before the
> `pipeline_runs` insert below — **every run must produce a row even when a slug fails hard**.*

⛔ **That promise cannot survive a platform timeout.** `try/catch` catches throws *inside* the loop; the
60-second kill terminates the whole function, insert included. **First recorded timeout is
2026-06-16 — five days after the hardening that was supposed to guarantee a row.** The guard closed
the failure mode its author was looking at and left the one outside the language.

### Why now, when the design was fine in June

The header states the sizing assumption: *"4 collections × ~200 = ~800 editions/tick at
~ms-per-edition cost. maxDuration=60 gives slack for pool contention."* Per-edition cost has since
grown — durations on the rows that *did* land crept from **4–11 s** (08-17 20:47–23:47) to **19–40 s**
(08-18 06:47–11:47). **The assumption expired; nothing told anyone, because the failures are silent.**

## Corrected status

Not a permanent stall — **intermittent tick loss**. Gaps since 08-17 20:47Z: `30 ×5, 120, 30, 240, 60,
30, 150, 30, 30`, now 119 min and counting. It **resumed on its own** ~9 h after the stall I filed, so
the earlier "has stopped" framing was too strong: it never stopped, it loses roughly two ticks in
three. ✅ And the backlog is **draining, not growing** — `rows_found` is now `18, 7, 8, 5, 1, 1`, down
from `214, 206, 118, 102`.

## Recommended fix — route code, needs Claude Code

⛔ **Do not raise `maxDuration`.** The documented lever for this instance is cutting work, never
raising a timeout, and 60 s already exceeds the caller's own 30 s cap.

1. **Move the `pipeline_runs` insert (or a `drain-fmv-cold-tail-heartbeat` row) to BEFORE the drain
   loop.** Then a killed tick is visible instead of absent. This is the single change that would have
   surfaced this in June, and it is worth doing independently of the fix.
2. **Cut work per tick** — the default `limit=200 × 4 collections` no longer fits. Either lower the
   default or drain **one collection per tick**, round-robin, so cost per invocation is a quarter.
3. Only then wire the derivation alarm. With ticks landing reliably its threshold means something;
   right now a 2.5×-median rule would fire on a pipeline that is *working, slowly*.

⚠ **A restart would not have fixed this** — the un-diagnosed-restart caution was right, for a reason
neither of us had yet: there is nothing to restart. The job never stopped.

## Sample bounds

14 h log window; 30 h `pipeline_runs` window; the error group spans 2026-06-16 → 2026-08-18 and is
route-scoped. ⚠ **One anomaly left unexplained:** a run at 08-17 21:17 recorded `duration_ms = 96,714`
with `ok = true` — above the 60 s limit that kills the others. Not investigated; flagged rather than
explained away, since any story about it would be the same kind of guess this note just retracted.

---

## ⚠ FOLLOW-UP, 2026-08-18 08:00 PT (Claude Code, Trevor's box) — recommendation 2 is REFUTED on measurement; 1 and 3 stand

**Shipped: the heartbeat (1), plus a deadline guard and slug rotation in place of (2).** See the
ledger entry of the same date.

⛔ **"Lower the default limit" cannot work, because `p_limit` does not bound the cost.**
`drain_fmv_cold_tail`'s candidate query opens with an **unscoped**
`SELECT edition_id, MAX(computed_at) FROM fmv_snapshots GROUP BY edition_id` — it aggregates the
**whole 1.16M-row table once per collection per tick**, then joins that to the collection's editions
and only then applies `LIMIT p_limit`. `p_limit` bounds the OUTPUT of a scan that has already run.

**Measured with `EXPLAIN (ANALYZE, BUFFERS)` 2026-08-18 ~07:45 PT:**

| variant | collection | editions | candidates returned | buffers | time |
|---|---|---|---|---|---|
| **as deployed** (unscoped `MAX` over all of `fmv_snapshots`) | `ufc_strike` | 518 | **0** | 86,275 | **32.9 s** |
| rewrite A: per-edition correlated `MAX` | `nba_top_shot` | 13,230 | 0 | 156,314 | 59.3 s |
| rewrite B: aggregate scoped by `collection_id` | `nba_top_shot` | 13,230 | 0 | 68,315 | 60.1 s |

⚠ **These three rows are NOT a before/after pair — two different collections, and every timing is
inflated by a live disk-IO throttling spell.** Rewrite B reads *fewer* buffers than the deployed
shape and still timed worse, which is the signature of ambient saturation, not of the rewrite.
**Buffers are the load-independent number; read those, not the seconds.** Rewrite A is a recorded
dead end for a reason worth keeping: the planner flattened the subquery and evaluated it **twice per
row** (once for `IS NULL`, once for the `<` comparison), so it costs more than the thing it replaced.

The load-bearing figure needs none of that comparison: **32.9 s of work to return zero rows for a
518-edition collection** is the finding, and four of those per tick cannot fit in 60 s no matter what
`limit` says.

**So the per-tick lever is FEWER COLLECTIONS, not a smaller limit** — which is what shipped:
a 45 s budget that stops starting slugs it cannot afford, plus a deterministic 30-minute rotation so
the guard starves nobody (without it `nba_top_shot` is both first in the list and the most expensive,
and would be the only collection ever drained).

⚠ **`maxDuration` was left at 60 as this note directs** — but the direction rests on one argument
that does not hold: *"60 s already exceeds the caller's own 30 s cap."* The caller never waits; the
route returns 202 before the work starts, which is the same fact that hid the kills. The real
question is whether the work legitimately needs more than 60 s, and the measurement above says **one
slug alone can**. Not changed unilaterally; flagged for Trevor with the number attached.

**The durable fix is DB-side and is NOT shipped:** scope that aggregate (or replace it with a
per-edition probe against `fmv_snapshots_2026_edition_id_computed_at_idx`). It was not attempted here
because every timing available right now is confounded by the saturation spell, and rewriting a
SECDEF FMV function on confounded numbers is how the last three `fmv-recalc` characterizations went
wrong. **Re-measure at a quiet hour, compare BUFFERS, and keep the candidate ORDER BY identical.**

---

## ✅ RESOLVED 2026-08-25 (Claude Code, interactive) — the DB-side fix shipped, exactly as this note specified

**This filing's own exit condition was met literally:** *"re-measure at a quiet hour, compare BUFFERS, and
keep the candidate ORDER BY identical."* Done, in that order, at io_wait 8 / active 11.

**The change:** one `WHERE collection_id = v_collection_id` inside the `latest` CTE. The `ORDER BY` is
byte-identical, no pricing branch moved, no index was created (migration
`20260826043000_audit_20260826_cold_tail_drain_scope_latest_cte_to_collection.sql`, applied as version
`20260826041837`).

| `ufc_strike`, EXPLAIN (ANALYZE, BUFFERS) | buffers | rows grouped | time | result |
|---|---:|---:|---:|---|
| as-written | 66,499 | ~1,281,000 | 38,615 ms | 0 rows |
| scoped | 741 | 4,391 | 173 ms | 0 rows |

Both plans remove the same 518 rows by filter. Served by the **existing**
`fmv_snapshots_2026_collection_id_edition_id_computed_at_idx`.

⭐ **Equivalence proven over the population before applying, not argued from the plan:** 1,281,003 snapshots
joined to editions, **0** with a `collection_id` differing from their edition's, **0** NULL.

🚨 **AND THIS NOTE UNDERSTATED THE COST — the defect's real output was SKIPPED COLLECTIONS, not slowness.**
Measured across the whole retention window strictly before the migration: **134 ticks, 42 `deadline_hit`
(31.3%), 121 of 536 collection-slots SKIPPED (22.6%)** — every one of them under `ok: true`. The note's own
observation that *"one slug alone can"* exceed the budget was the whole story and was filed as an aside.
➡ **When a note says a single arm can exhaust a fan-out's budget, go count how often it does before
proposing anything else.**

⛔ **The `maxDuration` question this note flagged for Trevor is UNCHANGED and now probably moot** — with the
aggregate gone the per-slug cost is ~0.2 s, so the 45 s budget should stop binding at all. **That is a
prediction, and its falsifier is the `deadline_hit` rate over the next day's ticks**, not the timing of any
one manual run.

### ✅ First post-migration SCHEDULED tick — the falsifier ran and did not falsify (n=1, stated as such)

**04:47:12Z, the first tick whose `started_at` is after the apply (`20260826041837` = 04:18:37Z):**
`ok: true`, `error: null`, **`deadline_hit: false`, `slugs_attempted: 4`, `skipped: 0`**, duration
**16,835 ms**, 14 rows. All four collections drained in one tick, under the production caller.

⚠ **What this DOES establish:** the rewritten body runs correctly when pg_cron/Vercel calls it — not merely
when invoked by hand — and returns the right shape with no error. That was the thing a manual run could not
prove, and it is now proven.

⛔ **What it does NOT establish, and must not be written up as if it did: n = 1 is not a rate.** The
pre-migration baseline was **31.3%** deadline hits, so a single clean tick had a ~69% chance of occurring
under the OLD body too. **The `deadline_hit` rate over the next day's ~48 ticks is the real reading**, and it
should be taken then rather than inferred now. ⓘ Weak corroboration only: `pg_stat_activity` read
**io_wait 18 / active 22** in the same window — elevated, not quiet — and it still finished all four slugs
in 16.8 s.
