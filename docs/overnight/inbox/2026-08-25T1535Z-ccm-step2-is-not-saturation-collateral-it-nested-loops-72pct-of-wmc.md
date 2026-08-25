# `rpc-ccm-step2` is NOT saturation collateral — it nested-loops 220 whale wallets holding **72% of the Top Shot partition**, and the planner underestimates that join by 2.05×

**Filed 2026-08-25 ~08:35 PT (15:35Z), Claude Code interactive on Trevor's Windows box.
MEASURED against the live DB. The A/B is NOT yet run — see §6. This SUPERSEDES the root-cause attribution in
[the 00:11Z filing](2026-08-25T0011Z-cross-collection-overlap-mat-is-51h-stale-and-no-standing-metric-watches-it.md).**

---

## 1. ⛔ THE FILED ROOT CAUSE IS WRONG, AND IT CARRIED A BAR ON RE-INVESTIGATING IT

The 00:11Z candidate says, verbatim:

> *"The step2 statement-timeout is a disk-IO saturation symptom. It is already filed … and focus.md PRIORITY 3
> explicitly bars opening new investigations into pg_cron statement-timeouts as they share one root."*

Three measurements contradict the shared-root attribution for **this** job:

| | |
|---|---|
| **It is 8-for-8, not intermittent.** | `rpc-ccm-step2` (jobid 4) has failed on **every scheduled run since 2026-08-18**: 08-18, 19, 20, 21, 22 (04:25Z), 22 (23:25Z), 23, 24. Last success **2026-08-17 04:25Z**. A saturation spell is a spell; **eight consecutive nightly failures across two different clock windows is a property of the query.** |
| **The durations are bimodal with nothing between.** | Successes: **9.2 s · 9.7 s · 13.1 s**. Failures: **300.0 · 300.0 · 300.0 · 300.1 · 300.1 · 300.3 · 303.2 s** — i.e. the timeout, exactly. Contention makes a 10 s query take 40 s, then 90 s. **It does not take it from 13 s to >300 s and hold it there for eight days.** |
| **The monitor's own control says not-saturated.** | The 00:11Z filing records `io_wait=0, active=0` at read time — 46 minutes after that night's step2 died. It printed the positive control that refutes its own attribution. |

⚠ **AND THE BAR WAS STATED WITH NO NUMBER IN IT** — which is exactly the tell CLAUDE.md names for a filed
decision-not-to-act. The bar's own stated lever is *"cutting the query's work, never raising the timeout"*.
**This filing is that lever, so it complies with PRIORITY 3 rather than violating it.**

## 2. ✅ WHAT THE QUERY ACTUALLY DOES

`refresh_cross_collection_cohort_step2()` builds one temp table:

```sql
FROM cross_collection_cohort_mat c
JOIN wallet_moments_cache w  ON w.wallet_address = c.wallet_address
                            AND w.collection_id = '<nba_top_shot>'
JOIN editions e              ON e.external_id::text = w.edition_key
                            AND e.collection_id    = w.collection_id
GROUP BY e.set_id
```

Live plan (`EXPLAIN`, no ANALYZE):

```
Hash Join (rows=384129)
  -> Nested Loop (rows=664888)
       -> Seq Scan on cross_collection_cohort_mat  (rows=220)
       -> Index Scan using idx_wmc_lock_wallet_coll on wallet_moments_cache (rows=3022)
```

**220 separate index scans into a 927 MB table.**

## 3. 🚨 THE NUMBER THAT SETTLES IT — THE COHORT *IS* THE TABLE

`cross_collection_cohort_mat` already carries `ts_moments` per wallet, so this cost **nothing** to measure — no
scan of `wallet_moments_cache` required:

| | rows |
|---|---:|
| TS rows held by the 220 cohort wallets (`sum(ts_moments)`) | **1,363,128** |
| TS rows in `wallet_moments_cache` **in total** | **1,888,824** |
| **cohort share of the partition** | **72.2 %** |
| planner's estimate for the same join | **664,888** |
| **underestimate** | **2.05 ×** |

The cohort is *by construction* the multi-collection whales: **avg 6,196** TS moments per wallet, **median 2,936**,
**max 153,544**. So the planner sees "220 rows × 3,022" and picks a nested loop, when the truth is
**"fetch 72 % of the table, in random order, 220 times over"**.

⚠ **A single-wallet `EXPLAIN (ANALYZE, BUFFERS)` confirms the estimate is wrong at the row level too**: the
first cohort wallet returns **20,559 rows** against the planner's 3,022 (**6.8×**), for **5,327 buffers**
(2,532 hit + 2,795 read) with **3,632 heap fetches** despite an Index-Only Scan.

## 4. The alternative plan, and why it should be much cheaper

Under `SET LOCAL enable_nestloop = off` the planner produces:

```
Hash Join
  -> Hash Join
       -> Seq Scan on wallet_moments_cache  (cost=0.00..149940.70, rows=1907019)
       -> Hash -> Seq Scan on cross_collection_cohort_mat (rows=220)
```

**One sequential pass over the table** (~118,656 pages / 927 MB) instead of 220 random-order index descents that
collectively touch most of it. The planner rates the two within **1.4 %** of each other (158,756 vs 161,048)
**only because it believes the 664,888 figure** — correct the cardinality and the nested loop is not close.

ⓘ On this instance the *sequential-vs-random* half may matter more than the buffer ratio: R46 says the binding
constraint is disk IO, and a 22 MB/s burst floor is spent very differently on one 927 MB stream than on ~1 M
scattered 8 KB reads.

## 5. ✅ REFUTED ALONG THE WAY — worth recording so nobody re-runs them

- **Not vacuum/bloat.** `wallet_moments_cache`: **0.3 % dead** (7,186 dead / 2,503,416 live), last autovacuum
  **7 minutes** before the read, 417 autovacuums lifetime. The instrument works; the hypothesis is dead.
- **Not cohort growth in the failing window.** The overlap mat still holds the 2026-08-22 result:
  `sum(moments_in_cohort)` = **1,363,936** then vs **1,363,128** today — **0.06 % apart**. The workload has been
  stable across the failures. ⛔ *I could NOT check further back: there is no history table, only the single-row
  `cross_collection_cohort_stats` snapshot. Whether the cohort jumped before 08-18 is **unknown**.*
- **Moving the schedule did not help.** The job was moved from `25 4 * * *` to `25 23 * * *` (visible in the run
  history on 08-22). It failed at 300 s in **both** windows.

## 6. ⛔ WHAT IS NOT MEASURED, AND WHY I STOPPED

**The A/B has not been run.** Three probes today died at 60–90 s — including a bare `count(*)` over just the
wmc leg, and one over **20 wallets** — and `pg_stat_activity` then showed **9 of 9 active backends waiting on
`IO / DataFileRead`**, with `refresh_wmc_fmv_changed(30, 200000)` at 238 s and `backfill_pinnacle_mint_acquisitions(50000)`
at 118 s. **Those three timings measured the saturation spell, not the query** — the exact confound CLAUDE.md
warns confounds timings *both ways* — and adding a 927 MB scan to a saturated instance to satisfy my own
curiosity is not a defensible thing to do to production. **They are reported here as classification only, never
as the cost.**

➡ **To close this, at a quiet hour (`io_wait=0`), run both shapes and compare BUFFERS, warm-vs-warm:**

```sql
EXPLAIN (ANALYZE, BUFFERS, TIMING OFF) <the step2 SELECT>;                       -- nested loop, as shipped
SET LOCAL enable_nestloop = off; EXPLAIN (ANALYZE, BUFFERS, TIMING OFF) <same>;  -- hash join
```

⚠ **Buffers, not seconds** — seconds are the number that lied all morning.

## 7. The proposed fix, if the A/B holds

One statement inside `refresh_cross_collection_cohort_step2()`, before the `CREATE TEMP TABLE`:

```sql
SET LOCAL enable_nestloop = off;
```

- **Zero behaviour change**: identical rows, identical output, identical `computed_at` contract.
- **Transaction-scoped**, so it cannot leak past the pg_cron job's own transaction. ⚠ *Unlike a function-level
  `SET` in `proconfig`, which CLAUDE.md records as INERT — this is a statement in the body, which is not.*
- **Revert is one `CREATE OR REPLACE FUNCTION`.** ⚠ It is a plain function, not a view, so the
  `security_invoker`/reloptions trap does not apply.

⛔ **NOT shipped tonight, for one reason only: the A/B is unmeasured.** Shipping a plan hint on the strength of
a plan *estimate* would be exactly the "plausible mechanism is not a measurement" error. The cardinality facts
in §3 are measured; the *improvement* is not, yet.

## 8. What this does to the 00:11Z candidate's actual ask

Its proposal — an additive `cross_collection_overlap_stale_hours` arm on `v_rpc_trust_health` — **still stands
and is unaffected by any of this.** Two notes for whoever takes it:

1. ⚠ **`v_rpc_trust_health` already times out at 60 s** (CLAUDE.md, trust-board section). An additive arm is not
   free on a view that is already at its ceiling. **Measure the view's cost before adding to it** — read the
   sentinel's `Trust Health` check rather than the doc's arm count, which drifts.
2. ✅ **The surface half is now shipped** (commit `7c45b4ef`, ledger 2026-08-25): `/insights/cross-collection`
   was rendering ONE freshness stamp — step1's, **15.7 h** — above a table sourced from this mat at **66.2 h**,
   understating a public board by ~50 hours, with `computed_at` **not even selected**. The board now carries a
   per-table stamp. **A monitor is easier to justify once the surface itself has stopped disagreeing with it.**
