# Watchlist coverage was measured against rows the monitor ignores — the blind spot is 67, not 62

**Filed 2026-08-18T0450Z (2026-08-17 21:50 PT) · Cowork cloud · READ-ONLY except one length-neutral CLAUDE.md correction**

## The correction

`docs/overnight/inbox/2026-08-17T2320Z-watchlist-coverage-audit-62-of-149-pipelines-are-unwatched.md` and
CLAUDE.md both carried **62 of 149**. That compared live pipelines against **all 102** rows of
`pipeline_cadence_watchlist`.

⛔ **`detect_stalled_pipelines` reads `WHERE w.is_active`, and only 83 of the 102 rows are active.**
Measured against what the guard actually reads:

| quantity | value |
|---|---|
| distinct pipelines with runs in 7d (`pipeline_runs_daily`) | **150** |
| watchlist rows | 102 |
| …of which `is_active` | **83** |
| unwatched vs ALL rows (the filed figure) | 63 |
| **unwatched vs ACTIVE rows — what the monitor is blind to** | **67** |
| live pipelines whose row exists but is DEACTIVATED | **4** |
| active rows with no runs in 7d | **0** |

The audit's own headline was an instance of the trap it was written about: a coverage number derived
from the table rather than from the predicate the consumer applies.

## ✅ Half of the "drifts BOTH ways" claim is refuted

CLAUDE.md said the list *"carries 15 rows for pipelines that no longer run."* Those rows exist, but
**every one of them is already `is_active = false`** — `active_but_no_runs_7d = 0`. The dead-entry
direction is already handled by the flag and costs the monitor nothing. **It drifts one way, not two.**
CLAUDE.md corrected in place, length-neutral (margin unchanged at 113).

## ⚠ Two pipelines are running unmonitored — and two are correctly retired

The 4 deactivated-but-live rows are not one group:

| pipeline | last run | runs/72h | verdict |
|---|---|---|---|
| `analytics-smoke` | **28 min ago** | 150 | ⚠ **LIVE, unmonitored.** Row notes say `[RETIRED May14 — route fir…]`; it has run for ~3 months since |
| `drain-fmv-cold-tail` | **1 h 54 m ago** | 120 | ⚠ **LIVE, unmonitored** |
| `topshot-flowty-unmapped-drain` | 1 d 2.5 h ago | 149 | ✅ correctly retired 08-16, correctly deactivated |
| `topshot-flowty-sales-history-backfill` | 1 d 4.3 h ago | 15 | ✅ same |

⛔ **THE ROLLUP SAID ALL FOUR RAN TODAY.** `pipeline_runs_daily` reported `last_day = 2026-08-17` for
every one, because the UTC day bucket still contains each pipeline's final runs. Only the raw
`pipeline_runs` table separates "running" from "stopped 26 hours ago". **This is a fresh instance of
the documented rule — `pipeline_runs_daily` for VOLUME and TREND, never for RECENCY.** My first draft
of this note claimed all four were live; the raw table refuted it.

## Who is calling the two live ones — INFERRED, not read

Enumerated three of the schedulers: **`vercel.json` (36 cron entries — 0 match), `.github/workflows/`
(0 match), `cron.job` (0 match).** By elimination the driver is **cron-job.org or the home-machine
scheduler**. ⚠ **That is an inference, not a reading** — I did not open the cron-job.org console
(secret-safety: its job-edit pages carry Authorization headers in the DOM). **Refutation condition:**
a matching cron-job.org entry, or any in-repo `fetch` caller I did not grep.

## What NOT to do

⛔ **Do not flip `detect_stalled_pipelines` to derived membership in one step.** It would add **67**
pipelines to alerting at once, on thresholds nobody has measured — and the watchlist's per-row
`max_silent_minutes` is *derived from each pipeline's own measured cadence* (the rows document their
own method: "median gap 20.0min, p95 20.0 … threshold 2.5x median"). A monitor that floods gets muted,
which is strictly worse than one that is blind.

**The missing input is a blast radius:** for each of the 67, the observed median gap, the 2.5×
threshold it implies, and whether it would breach *right now*. That measurement is cheap and is the
precondition for the derivation change. Not run here — it belongs in a quiet window, since this
instance is disk-IO starved.

## Also observed

⚠ **`check_pgcron_recent_failures()` timed out at the 60 s MCP cap** on this pass, twice. The standing
focus.md instruction is to run it every sweep; **right now it cannot complete**, so its silence this
pass is not evidence of pg_cron health. Not investigated — flagging that the instrument was
unavailable rather than green.

## Revert

CLAUDE.md line 147 only; `git revert` the commit, resolvable with
`git log -1 --format=%H --grep='coverage is only real against what the guard reads'`. No DB change, no
migration, no cron change. Read-only otherwise.
