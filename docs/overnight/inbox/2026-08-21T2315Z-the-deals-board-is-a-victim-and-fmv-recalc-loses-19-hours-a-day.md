# The `deals` board is a VICTIM of a global 20h/day slowdown, not its cause — and the same window costs FMV recalc ~19 hours a day

**Filed 2026-08-21 ~16:15 PT (23:15Z), Claude Code interactive. MEASURED, with a non-circular control.
Partly a REFUTATION of the 22:45Z filing. NOT fixed — the levers are FMV/DB query logic, off-limits for
autonomous shipping.**

---

## 1. What the 22:45Z filing got right (re-derived, holds)

509 warm ticks / 48h from `pipeline_runs.extra.boards`:
`panini-squeeze` 79.2% · **`deals` 78.2%** · **`first-mint` 63.7%** · `candy-mlb` 17.7% · `rookies` 12.0%.

The per-day-per-hour grid reproduces on all three retained days — this is a repeating daily cycle, not a
step change dressed up by an hour-of-day average (I checked, because that confound is real):

| UTC hour | 23 | 00 | 01 | 02–19 | 20 | 21 | 22 |
|---|---:|---:|---:|---:|---:|---:|---:|
| `deals` fail % | 0 | 8–9 | **83–100** | 71–100 | 27–50 | 11–22 | 0–10 |

A **cliff** into failure at 00→01Z and a **drain** back out over 19→22Z.

## 2. ⚠ What it got wrong, and it changes the lever

Section 3 concludes: *"'Saturation-driven, self-heals when load lifts' no longer describes this."*
**It does.** The framing is right; only the WINDOW is stale (~20h/day, not the 05–08:30Z spell).

**The control that decides it — an unrelated, cheap job on an identical every-5-minutes schedule:**

| `rpc-backfill-wmc-fmv-confidence` | p50 duration |
|---|---:|
| hours 20–00Z | **0.7 – 1.0 s** |
| hours 01–19Z | **3.1 – 18.0 s** |

A query with nothing to do with `cross_collection_deals_board` runs 3–18× slower on exactly the same
clock. That is a **global** condition. Two more readings on the same axis:

- `rookies` — a CHEAP board — swings 0% → 70% failure across the same hours. If per-board query cost
  were the driver, the cheap board would be flat. It is not.
- FMV production collapses: **~2,800–4,100 snapshots/hour in 20:00–00:00Z vs 1–466/hour in 01:00–19:00Z.**

**Therefore levers 1–2 of the 22:45Z filing (materialise / narrow the deals view) target a victim.**
That view is **0.93%** of total `shared_blks_read`. Rewriting it cannot move a 20-hour global band.
The diagnosis in that filing is good work and its EXPLAIN analysis is worth keeping — it just answers
"why is `deals` the worst-hit board", not "why do the boards fail 20 hours a day".

## 3. ⚠ The circular instrument I used first, recorded so the next person skips it

I initially "confirmed" saturation from `cron.job_run_details` busy-seconds by UTC hour
(1.1–2.4k in the healthy band vs 4.0–13.0k in the failing one). **That is circular.** Every job in that
sum is on an hour-uniform schedule, so run COUNT is flat and busy-seconds varies only because durations
do — it is an OUTPUT of the slowdown measured as if it were the input. Any "load by hour" built from
durations has this defect. The fixed-job p50 in §2 is the non-circular version.

## 4. The bigger finding: the headline metric is starved 19 hours a day

`fmv_snapshots` rows written per hour, 72h — the same cycle, every day:

| day (UTC) | 20:00–00:00Z | 01:00–19:00Z (19 hours) |
|---|---:|---:|
| 08-19→20 | 15,890 | — |
| 08-20 | — | **1,309 total** |
| 08-21 | 9,534 (20–22Z, partial) | ~1,100 total |

**~92% of all FMV recalculation happens in a 5-hour window.** CLAUDE.md's stated headline metric is the
share of prices at HIGH/MEDIUM confidence, and the pipeline that produces those prices gets ~4 productive
hours a day. This is consistent with the recorded "`fmv-recalc`: wasteful, NOT broken — 72.7% wall-kills"
characterisation, and gives it a shape: the kills are not spread evenly, they are ~all of 01–19Z.

## 4b. ⚠ QUALIFYING §4 — throughput is NOT established as what caps the headline metric

**Added 2026-08-21 ~20:10 PT after the 02:56Z accuracy-gate filing landed.** §4 says the starvation costs
"the headline metric (the share of prices at HIGH/MEDIUM confidence)". **The throughput measurement
stands; that inference does not, and for two collections it is refuted.**

That filing measured the gate at **31.3% HIGH/MEDIUM (9,224 / 29,514 priced editions)** and found it
tracks **market liquidity** monotonically, no inversions:

    5.51 sales/edition/month -> 34.2%  (top shot)
    1.69                     -> 22.7%  (all day)
    0.17                     ->  0.0%  (golazos)
    0.00                     ->  0.0%  (ufc)

**An edition with 0.17 sales a month cannot reach a sales-based HIGH/MEDIUM however much compute you give
it.** I re-derived the load-bearing half independently: `ufc_strike`'s last sale is
**2026-05-13 17:06Z, with 0 sales in BOTH the last 30 and 90 days** — exactly as filed.

**So the honest split is:** the 19-hour starvation is real and wasteful, and it plausibly bears on Top
Shot and All Day, where liquidity is not obviously the binding constraint. It is **not** the explanation
for the 31.3%, and anyone reading §4 as "raise FMV throughput → the gate moves" would be acting on my
implication rather than my measurement. ⚠ That filing is careful about its own limits too — 4 points and
a consistent ordering is enough to redirect effort and not enough to quantify.

⚠ **A second thing worth recording: the headline metric is not merely unmeasured, it is EXPENSIVE TO
MEASURE.** Trying to re-derive the 31.3% myself, **two different formulations both timed out at 60 s**
(a `DISTINCT ON` over `fmv_snapshots`, then the `fmv_current` view) — inside the degraded band this
filing is about. That is very likely *why* no view, dashboard or recent measurement of it exists: the
number that gates the roadmap costs more to compute than anyone is willing to spend casually, and costs
most exactly when the estate is struggling. A cheap materialised counter would change that, and is a
better lever on "we don't know our accuracy" than anything in §6.

## 5. The largest single consumer, named but NOT diagnosed as the cause

`pg_stat_statements` (reset 2026-08-12 01:33Z), by `shared_blks_read`:

| statement | calls | mean | blocks/call | % of ALL reads |
|---|---:|---:|---:|---:|
| `refresh_wmc_fmv_changed($1,$2)` | 1,151 | **296.8 s** | **69,954 (~546 MB)** | **8.06%** |
| `panini_squeeze_board` (PostgREST) | 5,033 | 4.4 s | 8,917 | 4.49% |
| `raise_impossible_parallel_circ()` | 148 | 51.2 s | 158,177 | 2.34% |
| `cross_collection_deals_board` | 928 | 12.9 s | 10,017 | **0.93%** |

`refresh_wmc_fmv_changed`'s `prosrc` sets `v_budget := statement_timeout × 0.6`, and its p50 is pinned at
**364–377 s for 19 consecutive hours**, dropping to 24–122 s in 20–23Z. A flat p50 at a budget is the
signature of a job that never drains its backlog: it runs 6×/hour and burns ~366 s of every 600 s, a
**~61% duty cycle, permanently**. It also pops only `v_chunk := 5` editions per loop iteration.

⚠ **This is a CANDIDATE, not a verdict.** Its own p50 also drops 15× in the healthy window — exactly what
every confirmed victim does — so cause-vs-victim is unsettled by the data I have. Deciding it needs an
instrument I do not have from SQL: the Supabase disk-IO burst-credit balance over the day. Do not "fix"
this function on the strength of this table.

## 6. What was SHIPPED off the back of this (separate concern, already in the ledger)

The 22:45Z filing checked whether the staleness was disclosed, found `DealsBoardClient` renders
`Updated <FreshnessStamp>`, and concluded the ladder was honest. **It generalised from one board.**
`/insights/rookies` and `/insights/first-mint` carried `meta.fetched_at` and rendered NOTHING — no banner
(by `degradedFromSource`'s design) and no stamp. Both fixed; the premise is now enforced by a
population-derived guard rather than asserted in a comment. See the ledger entry of the same date.

## 7. Levers, none pulled — revised from the 22:45Z list

1. ⛔ **Drop levers 1–2 of the 22:45Z filing** (materialise / narrow the deals view) *as a fix for the
   failure rate*. 0.93% of reads. Keep them only as a way to make `deals` cheaper on its own merits.
2. **Find what actually flips at 00:30Z and drains by 20:00Z.** The decisive read is the burst-credit
   balance by hour in the Supabase dashboard — operator-only. If credits are depleted at 00:30Z and
   rebuild through the evening, the whole cycle is explained and the lever is total IO, not any one query.
3. **`refresh_wmc_fmv_changed` is the biggest single lever IF §5 is causal** — 8.06% of reads at a 61%
   duty cycle. Cheapest safe probe: raise `v_chunk` from 5 and compare **buffers** (warm-vs-warm), or cut
   the cadence from every 10 min to every 20 and watch whether the 01–19Z band narrows. Both are FMV
   logic ⇒ Trevor's call.
4. **Do NOT raise `BOARD_SNAPSHOT_STALE_CEILING_MS`** — unchanged from the 22:45Z filing, and still right.
