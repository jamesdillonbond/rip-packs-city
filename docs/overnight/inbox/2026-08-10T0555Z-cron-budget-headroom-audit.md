# Queued — cron budget headroom audit, the post-ship closes, and the next MV lever

Source: Cowork cloud nightly pass 2026-08-09d, continuation (22:20–22:55 PT). **Read-only measurement
only — nothing was applied in this continuation.** The two migrations from earlier in the pass
(`20260810040308`, `20260810045029`) are already live and committed.

---

## ✅ CLOSED — post-ship watch owed by handoff 2026-08-09c: the `ed_med` split worked

That handoff asked for jobid 236 `rpc-refresh-perfect-mint-premiums`'s **real production figure**,
and correctly refused to claim a win off the one 43.4s run it had.

**Five runs now, spanning 8 hours (2026-08-09 20:17Z → 08-10 04:00Z):**

| | pre-split (08-02 → 08-09 20:06Z) | post-split |
|---|---|---|
| runs | 182 | **5** |
| failures | **30 (16.5%)** | **0** |
| p50 | 71.9 s | — |
| **p90** | **600.0 s** | — |
| max | 1058.0 s | **57.6 s** |

Durations: 43.4 · 49.3 · 57.6 · 41.0 · **21.6** s.

⚠ **The strongest single point is the 21.6 s run at 04:00Z** — it landed in the most contended
window of the night (six `CONCURRENTLY` index builds plus three `cron_heavy` jobs sitting at their
full 600 s). Pre-split, that is precisely the condition that produced the 600 s kills. The refutation
condition — *durations stay bimodal with a 600 s mode* — did not occur.

⚠ **Sample is 5.** And the p90 600.0 → max 57.6 comparison is the honest one; do not quote p50 71.9 →
~43 as the headline, because the pre-split distribution was bimodal and the mean is meaningless on it.

### The two 08-09 levers separate cleanly, and each did only what it claimed

The `ed_med` split (20:06Z) and the 2-hourly cadence cut (20:31Z) landed 25 minutes apart. **Cadence
cannot change per-run duration**, so the duration win is attributable to `ed_med` alone. Cadence
halves the *number of attempts*, i.e. the wasted worker-seconds. Confirmed across the cohort:

| job | 7d before: runs / fails / p90 | after: runs / fails / max |
|---|---|---|
| `rpc-refresh-perfect-mint-premiums` | 165 / **28** / 600.0 s | 4 / **0** / **57.6 s** |
| `rpc-refresh-pack-reality-dist` | 164 / 5 / 210.1 s | 5 / 0 / 147.7 s |
| `rpc-refresh-pack-reality-stats` | 165 / 6 / 281.0 s | 5 / 0 / 285.3 s |
| `rpc-refresh-pack-reality-top-ev` | 168 / 1 / 96.2 s | 5 / 0 / 125.4 s |
| **`rpc-refresh-market-index-daily`** | 165 / **13** / **509.4 s** | 4 / **1 (600.5 s kill)** / 600.5 s |

Note `pack-reality-stats` and `-top-ev` post-change maxima (285.3, 125.4) *exceed* their pre-change
p90 — durations did not improve, exactly as expected. **Do not read the cadence cut as a speed fix.**

---

## 🔴 `rpc-refresh-market-index-daily` (jobid 235) is now the worst remaining MV refresh

It is the one cohort member the cadence cut did not help, and it is the same shape perfect-mint had
*before* its fix: p90 **509.4 s** against a 600 s budget, **13 failures / 165** pre-change, and
**1 of 4** post-change runs already died at 600.5 s.

### Planner-only `EXPLAIN` of `mv_topshot_market_index_daily` — total cost **225,354.59**

```
Append                                            225,354.59
  CTE s  (materialised once, 392,347 rows)        107,995.31
    Hash Join
      Index Scan idx_sales_2026_pulse_window       44,546.08   (collection, sold_at >= CURRENT_DATE-120)
      Hash -> Seq Scan on editions                  2,874.75   (27,075 rows, for `tier`)
  GroupAggregate (d, tier)                          61,277.13   <- Sort 52,155 over 392,347 rows
  GroupAggregate (d)  -- the 'ALL' rollup           55,884.97   <- Sort 49,012 over the SAME 392,347 rows
```

⚠ **There is NO single dominant node here — this is not another `ed_med`.** That fix worked because
78,886 of 176,993 sat in one restrictable CTE. Here the cost is spread: 48% CTE scan/join, 45% two
sorts of the same 392k rows, and the sorts are the price of `percentile_cont`.

**What is and isn't foldable.** The `'ALL'` branch re-sorts all 392,347 rows to recompute what the
per-tier branch already touched. Four of its seven outputs are exactly derivable from the per-tier
result — `sales` = Σ, `volume_usd` = Σ, `max_px` = max of maxes, `avg_px` = Σvolume/Σsales.
**`median_px` is NOT** derivable from per-tier medians, so the second pass cannot be removed, only
narrowed. Ceiling on that refactor is roughly the 22% the second sort costs, and it buys a
correctness-review burden on a public board. **Low value; do not start here.**

### ⛔ The obvious big lever is UNSAFE in this repo — read this before proposing it

The natural fix is *incremental*: the MV recomputes **120 days** every 2 hours, so keep historical
days and recompute only the last day or two — a ~60× reduction.

**That is wrong here, and quietly so.** Historical days are not immutable in this database. The
studio-platform deep-history backfills land rows with old `sold_at` continuously (~200 rows/24 h into
historical partitions), and the 08-09 UFC finding measured **485 rows arriving in a single burst, all
with `sold_at` a month or more in the past**. An incremental-by-`sold_at`-day design would silently
freeze those days at their pre-backfill values — a fabricated-history defect of exactly the class
this repo keeps closing.

**The safe variant** is incremental keyed on **ingest time** (or a dirty-day set maintained by the
writers), plus a periodic full rebuild to catch anything missed. That is a design decision on a
public board's backing MV, needs the build-verify-rename pattern, and is **not an autonomous ship.**

---

## 🟡 Cron budget headroom audit — and ⚠ the instrument is partly untrustworthy

I re-ran the analysis with the criterion I should have used in the first place. The 08-09d migration
selected jobs by **"the function declares more than the effective budget."** That is the wrong test —
it describes an author's intent, not a risk. The right test is **observed runtime vs. the budget that
actually binds**, and it produces an almost entirely different set.

Effective budget = in-command `SET statement_timeout` → else role `cron_heavy` 600 s → else global 120 s.

### ⚠ FIRST: five jobs show *successful* runs LONGER than their own budget

That is impossible if the model and the measurement are both right, so one of them isn't.

| job | budget | max **ok** | explanation |
|---|---|---|---|
| `rpc-allday-nem-from-sales-backfill` (215) | 600 s | 938.7 s | ✅ **two statements** — each gets its own 600 s |
| `rpc-remap-misattributed-sales` (62) | 600 s | 701.0 s | ✅ **two statements** |
| `rpc-backfill-pinnacle-mint-acquisitions` (218) | 600 s | **762.0 s** | ❌ **single statement, no EXCEPTION block — unexplained** |
| `rpc-refresh-allday-pack-sales-agg` (210) | 600 s | **701.8 s** | ❌ **single statement, no EXCEPTION block — unexplained** |

I checked the obvious culprit and **ruled it out**: a plpgsql `EXCEPTION` handler catching
`query_canceled` would swallow the cancel and let the function run on unbounded (the timer does not
re-arm). Neither function has an `EXCEPTION` block at all. Remaining candidates: `statement_timeout`
is only enforced at interrupt checkpoints, so a backend stalled in IO on this disk-IO-budget-bound
instance can overrun; or pg_cron's `end_time` bookkeeping lags under worker-slot pressure.

**Consequence — do not skip this when using the table below.** `cron.job_run_details` duration
**overstates statement time under saturation**, by ~17–27% in the two measured cases. The audit's
*ordering* is sound; the absolute `% of budget` is soft above ~90%. **Do not size a budget from these
numbers alone.**

### The jobs actually at risk (global-120 s cohort, ranked)

| jobid | job | budget | max ok | % | timeouts / runs | note |
|---|---|---|---|---|---|---|
| **261** | `rpc-refresh-unmapped-backlog-growth` | 120 s | **299.9 s** | **250%** | 0 / 3 | ⚠ **the alert path.** Only survived because 08-09d's temporary role raise was still active |
| **78** | `rpc-backfill-pinnacle-acquisitions` | 120 s | 119.5 s | **100%** | **4 / 113** | already biting, repeatedly, unconfounded |
| 231 | `rpc-golazos-badge-low-ask-refresh` | 120 s | 109.4 s | 91% | 0 / 739 (+8 startup) | |
| 11 | `rpc-refresh-new-collectors` | 120 s | 109.1 s | 91% | 1 / 31 | |
| 87 | `rpc-refresh-challenge-costs` | 120 s | 104.3 s | 87% | 0 / 28 | |
| 40 | `rpc-refresh-rookie-collector-lb` | 120 s | 93.9 s | 78% | 0 / 31 | |

⚠ **None of these six were in the eight I fixed.** The two criteria barely overlap — which is the
whole point of filing this.

**jobid 78 is the cleanest candidate**: 4 statement-timeout failures across 113 runs, no confounding
window, function declares 90 s (inert), and its longest success is 119.5 s against a 120 s cap.

⚠ **Deliberately NOT shipped**, for three reasons that should be re-weighed rather than assumed:
1. Trevor's standing instruction from this pass: do not raise a budget on thin evidence.
2. Every raise costs worker-slot squat time, and the 08-09d window demonstrated that cost is real —
   five jobs starved with the `job startup timeout` signature at 04:26Z.
3. **The measurement instrument is itself in question** (see above). Sizing budgets from numbers I
   cannot fully explain is the mistake this repo documents most often.

### Also visible: the real squat load

Nine `cron_heavy` jobs sit at **95–100%** of their 600 s budget on their worst successful run
(jobids 73, 76, 235, 236, 67, 71, 211, 70, 75, 217). These, not the 120 s cohort, are what saturates
the worker pool. **Raising anything should be weighed against this population, not judged per-job.**

---

## Recommended order for the next pass

1. **Clean probes first, no builds in flight** — jobid 4 (21:25 PT daily), jobid 259 (06:33 PT daily),
   jobid 261 (hourly :29), jobid 54 (Sundays). Confirm 08-09d's fix before extending it.
2. **Explain the two budget overruns** (jobids 218, 210). Until then the headroom table cannot size
   anything. Cheapest test: log `clock_timestamp()` at function entry/exit and compare to
   `job_run_details`, which separates "the statement overran" from "pg_cron's bookkeeping lagged".
3. **jobid 78** — smallest, best-evidenced budget fix, if (1) and (2) come back clean.
4. **jobid 235 `market-index-daily`** — the real MV lever, as a *design* item with the
   backfill-mutates-history constraint above stated up front.

---
---

# RESOLUTION — 2026-08-09 ~23:20 PT (Claude Code, interactive, read-only)

> ⚠ **The overshoot counts in this section were re-measured and are superseded** — see
> `2026-08-10T0620Z-headroom-audit-corrections.md` (§VERIFIED). The mechanism and the conclusion are
> unchanged and confirmed; the arithmetic below undercounts. Corrected inline where marked ⟲.

Worked items **2 and 3**. Item 1 was already closed by a concurrent session (see the top
`2026-08-09 · POST-SHIP WATCH` ledger entry — jobid 4's post-fix 300.1 s failure, correctly read as
CIC collateral; 259/54 not yet run). **No prod change made by this pass.** Item 4 untouched, as filed.

## ✅ Item 2 SOLVED — and the doc's framing was backwards

**The instrument is fine. `statement_timeout` is what's imprecise.**

The doc looked only at over-budget *successes* and concluded `job_run_details` overstates. The decisive
evidence is in the *failures*, which it did not check. All statement-timeout kills, 14 d, grouped by the
budget that actually binds:

| effective budget | kills | landed on budget | **overshot** | max recorded | max overshoot |
|---|---|---|---|---|---|
| 120 s | 5 | **5** | **0** | 120.6 s | +0.6 s |
| 180 s | 3 | 3 | 0 | 128.4 s | — |
| 300 s | 2 | **2** | **0** | 300.1 s | +0.1 s |
| **600 s** | 129 | 117 | **12 (9.3%)** ⟲ *re-measured: 23 (17.8%)* | **1058.0 s** | **+458.0 s** |

**A 1058.0 s `canceling statement due to statement timeout` under a 600 s budget cannot be pg_cron
bookkeeping lag** — pg_cron recorded the error the backend actually returned, so the backend really did
run 1058 s and really was cancelled. That single row kills both candidate explanations the doc offered.

**Mechanism: cancel latency.** `statement_timeout` fires SIGALRM, which only sets `QueryCancelPending`;
the cancel is serviced at the next `CHECK_FOR_INTERRUPTS`. On this disk-IO-budget-throttled instance a
heavy statement can go minutes between interrupt checks. So the kill lands at *the first interrupt check
after the budget expires* — and **if the statement finishes inside that gap, it commits successfully
despite having blown its budget.** One mechanism, three observations:

- 12 kills at 615–1058 s under a 600 s cap ⟲ *re-measured: 23 kills at 601–1058 s*
- 5 over-budget *successes* in 14 d (215 938.7 s · 218 762.0 s · 210 701.8 s · 62 701.0 s · 261 299.9 s)
- zero overshoot anywhere below 600 s

⚠ **Ruled out, with data:** not role (overshoot hits both `postgres` and `cron_heavy`), not command form
(both with and without an in-command `SET`), not `REFRESH MATERIALIZED VIEW CONCURRENTLY` (hits plain
`INSERT…SELECT` too), and not startup lag (trivial jobs in the *same minute* as 218's 942.3 s run
completed in 0.3 s, so pg_cron was dispatching promptly). `cron.use_background_workers = off`,
`cron.max_running_jobs = 32`.

⚠ **The doc's 215 / 62 "✅ two statements — each gets its own 600 s" explanations are wrong too.**
218 has **zero** semicolons in its command and still recorded 762.0 s. Same mechanism, no multi-statement
needed.

### 🔓 This UNBLOCKS the headroom table rather than invalidating it

Overshoot is **exclusively** a 600 s-cohort phenomenon. The 120 s cohort's five kills all landed within
0.6 s of budget. **So the doc's reason #3 for withholding — "the measurement instrument is itself in
question" — does not apply to the 120 s cohort.** Those `% of budget` figures are sound.

⚠ **What IS newly soft is the `cron_heavy` squat estimate.** "Nine jobs at 95–100% of 600 s" overstates
the *scheduled* time they are entitled to: part of that tail is cancel latency the budget never granted.
Worker-slot squat is real regardless — the slot is held either way — but do not read those as
"legitimately need ~600 s of work."

## ⛔ Item 3 DECLINED — jobid 78 is fully drained; raising its budget makes waste reliable

The doc called this "the cleanest candidate." It is the cleanest *decline*. Measured live:

- **Candidate pool: 4,256. Rows already written by this backfill: 4,256. Exactly equal — it is DONE.**
- **10 days / ~40 scheduled runs inserted 37 rows total**; ~27 of those runs inserted **nothing**
  (best day 11 rows, typical productive run 1–3).
- Every run re-derives the whole pool anyway. The function has **no cursor and no anti-join** — just
  `INSERT … ON CONFLICT (nft_id, wallet, transaction_hash) DO NOTHING`, so all 4,256 are re-computed and
  discarded each time. Textbook `[[green-pipeline-blind-to-its-own-work]]`.
- Planner cost **35,301**, and it is fixed: an unordered `LIMIT` over a hash join cannot push down, so
  the 47 k-row Pinnacle `wallet_moments_cache` index scan (**cost 25,462**, the dominant node) runs in
  full before a single row emerges. That is the 8–120 s we see, cold vs warm.

**Raising 120 s → 300 s would buy nothing but a longer, more reliable rescan four times a day, on an
instance whose scarce resource is exactly disk I/O.** Correct call by the doc's own instinct, wrong
reason — decline it on the drain evidence, not on instrument doubt.

⚠ **`LIMIT 50000` is inert, not a defect** — the pool is 4,256. Do not "fix" it.

### The real fix, measured — and the hole in the obvious version

Narrow the driving set by **ingest time**, not `sold_at` (same trap as jobid 235, and
`pinnacle_sales.created_at` is 187,156/187,156 non-null, oldest 2026-04-14):

```
WHERE ps.sale_price_usd > 0 AND ps.created_at > now() - interval '7 days'
```

Planner-only `EXPLAIN`: **35,301.68 → 10,489.34 (−70%)**, and the 25,462-cost wmc scan is *replaced* by a
per-candidate `Index Only Scan` on `wallet_moments_cache_wallet_collection_moment_key` (1.69 each, ~485
candidates). 7 d of overlap on a 6-hourly job = 28× redundancy; `ON CONFLICT DO NOTHING` makes it free.
Residual 8,670 is a seq scan of `pinnacle_sales` (no `created_at` index) — cheap, and indexing a hot
ingest table needs its own justification.

⚠ **DO NOT ship that narrowing alone — it has a hole the current full-rescan design silently covers.**
The join needs *both* sides present. `wallet_moments_cache` is written by wallet walks, so a buyer's wmc
row can appear **days after** the sale was ingested. Keyed only on `ps.created_at`, that pair is never
seen again. So the shape must be **incremental + a periodic full sweep** — precisely the pattern this
doc prescribes for jobid 235: `p_since_days int DEFAULT 7`, `NULL` = full sweep, 6-hourly incremental
plus a weekly `NULL` run carrying its own `SET statement_timeout`. Not pinned in
`db-invariants-drift-guard` (checked), so no test copy to update.

⚠ **jobid 218 `rpc-backfill-pinnacle-mint-acquisitions` is the same family** — hourly, `50000` cap,
p50 24.3 s, 7 failures, and it produced the 942.3 s kill. Re-measure its drain state before touching it.

## 🟡 jobid 261 — restated, still too thin to act on

The alert-path precompute shipped this morning. Its function declares `statement_timeout=90s`, which is
**inert** — it is the same class as the eight the 08-09d migration fixed, simply missed (that migration's
selector was "declares *more* than the effective budget", and 90 < 120). Effective budget: **120 s**.
Its 299.9 s run at 04:29Z sits inside the 04:03–05:09Z window when `postgres` was temporarily raised; the
grant is now confirmed reverted, so that workload would now be exposed. **Three runs total (299.9 / 4.6 /
9.5 s) — the D15 one-sample trap. Re-probe after 24 h of hourly ticks, then decide.** Do not splice a
number: the author's declared 90 s is *below* the current cap, so there is no author intent to honour
here — this one needs a re-measure, not a prefix.
