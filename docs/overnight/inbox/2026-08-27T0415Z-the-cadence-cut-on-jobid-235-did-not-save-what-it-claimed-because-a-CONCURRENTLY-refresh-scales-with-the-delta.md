# ⚠ The cadence cut on jobid 235 saved **~1.4 h/wk, not the 3.7 h/wk claimed** — because a `REFRESH … CONCURRENTLY` costs what CHANGED, and cutting the cadence made each run 3× bigger

**Filed 2026-08-26 (PT) / 2026-08-27 04:15Z by Claude (Cowork cloud). NOTHING SHIPPED.**
**This is a measurement with a confound I am naming up front, and a falsifier that settles it.**

---

## 1. The job, and the number that starts this

pg_cron **jobid 235** `rpc-refresh-market-index-daily`:

```
7 */6 * * *   SET statement_timeout = '600s';
              REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_topshot_market_index_daily;
```

**Since the 6-hourly cadence took effect (2026-08-22 12:00Z), 19 runs:**

| | |
|---|---:|
| failed (`canceling statement due to statement timeout`) | **4 — 21.1%** |
| p50 (successes) | **346 s** |
| p90 (successes) | **515 s** |
| **max success** | **565 s** |
| **budget** | **600 s** |
| heavy IO burned by the failures | **2,401 s in 5 days ≈ 480 s/day producing nothing** |

⭐ **The max observed success is 565 s against a 600 s ceiling — 6% headroom.** Over the job's whole
retained history (305 runs since 2026-08-01) the max success is **598 s against 600**: **two seconds.**
**This is not a flaky job; it is a distribution whose right tail is being clipped by the ceiling**, and
the failures are the same distribution, not a second fault.

ⓘ **The shape is already named in this repo** — *"a job whose runtime has grown to straddle its own
budget fails intermittently and reads as flaky rather than sick"* — with **jobid 235 cited as the
first recorded instance.** What is new here is the cause and the arithmetic.

## 2. ⭐ The cause I think is new: a cadence cut on a CONCURRENTLY-refreshed MV does not save proportionally

The cadence was cut **`7 */2` → `7 */6`** on the recorded reasoning that the MV's grain is daily and
its only consumer reads a ~121-day series, so 12 refreshes a day only move *today's single partial
point*. **That consumer reasoning is correct and I am not disputing it.**

⛔ **What the cut did not account for: a `REFRESH MATERIALIZED VIEW CONCURRENTLY` costs what CHANGED
since the last refresh, not what the view contains.** Tripling the interval triples the delta each
run has to fold in. Measured:

| | before the cut | after the cut |
|---|---:|---:|
| runs/day | 12 | 4 |
| p50 duration | **67 s** (whole-history) | **346 s** |
| failure rate | 9.5% (whole-history) | **21.1%** |

**p50 rose 5.2×** against a 3× cadence factor.

**So the claimed saving does not hold at the claimed size.** The ledger's *"saves ~3.7 h of heavy DB
time per week"* assumes the per-run cost is unchanged (12 × 204 s → 4 × 204 s). With the measured
post-cut costs:

- before ≈ 12 × 204 s ≈ **2,448 s/day**
- after ≈ 4 × (0.79 × ~380 s + 0.21 × 600 s) ≈ **1,704 s/day**

**≈744 s/day ≈ 1.4 h/wk saved, not 3.7 h/wk — and 480 s/day of what remains is failures returning
nothing.** ⭐ **Transferable: when you cut the cadence of a delta-proportional job, the per-run cost
rises to meet you. Predict the saving from the measured post-change cost, never by multiplying the
old cost by the new frequency.**

## 3. ⚠ THE CONFOUND, stated before the conclusion — and part of it is mine

The 5-day post-cut window (2026-08-22 → 27) **overlaps a known saturation spell on this instance**:
index builds and drops, several 900k-buffer `EXPLAIN`s, and the `rwfc` work whose own cost comparison
was set aside as confounded for exactly this reason. **Some of the 67 s → 346 s shift is contention I
helped cause, and I cannot separate the two from this window.** n = **19 runs**.

⭐ **Falsifier, and it is cheap: re-measure p50 over a genuinely quiet 24 h with no index work
running.**

- **If p50 stays near ~346 s** → the cadence is the cause, the mechanism above holds, and the saving
  is ~1.4 h/wk.
- **If p50 returns toward ~67 s** → the window was contention, the cut was fine as recorded, and
  **only the budget headroom is the real issue.**

⛔ **Do not act on §2's conclusion before that read.** It is one 19-run window on a contended instance.

## 4. 👉 Options, with their prior art, and why I shipped none of them

**(a) Raise the budget `600s → 900s`.** ~1.6× the observed max success — the same heuristic upstream
used tonight when it raised the candy sweep budget to ~1.5× its observed max, from the lesson
*"`maxDuration` is what the platform DECLARES; the success band is what the route actually GETS."*
One statement, reversible, `postgres`-owned so `cron.alter_job` reaches it. ⚠ **Counter-argument that
is real: a failed run at 900 s wastes 900 s instead of 600 s.** It only pays if most of the clipped
runs would actually complete — which the 565 s max success suggests but does not prove.

**(b) Restore a shorter cadence (`7 */3`).** Trades run count against per-run delta. ⚠ Reverses a
deliberate, recorded decision on its consumer-impact reasoning, which remains correct.

**(c) Both.**

⛔ **None shipped, and the reason is specific rather than general caution.** The consumer impact of a
failure here is **near nil** — the ledger's own analysis is that a refresh only moves today's single
partial point on a four-month chart, so a missed one costs at most ~12 h of staleness on one point.
**A change with near-zero upside for the user and a real IO cost on the instance's binding constraint
is not one to make unilaterally at 04:00**, and §3's confound means the diagnosis is not yet settled.

**Exact revert-able form of (a), for whoever takes it:**

```sql
SELECT cron.alter_job(235, command =>
  $$SET statement_timeout = '900s'; REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_topshot_market_index_daily;$$);
-- revert: same call with '600s'
```

⚠ **And whichever is chosen, the metric to watch is not the failure count — it is `wasted_s`**
(`sum(duration) WHERE status='failed'`), currently **~480 s/day**. Raising a budget can cut failures
while raising waste, and only that number distinguishes the two.
