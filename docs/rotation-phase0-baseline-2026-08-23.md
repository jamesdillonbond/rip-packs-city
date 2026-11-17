# Rotation Phase 0 — frozen silence baseline, and why the v2 detector inverts on a third of the fleet

**Frozen 2026-08-23 02:05Z.** Window: the 72 h to that instant. Companion data: `rotation-phase0-baseline.csv` (155 lanes).

## Why this had to be taken now

`pipeline_runs` held **79.4 h** at capture (oldest row 2026-08-19 18:41Z, 49,969 rows, 163 distinct pipelines) and is a rolling window. A stranded caller after a flag-day rotation **does not fail — it goes silent**, because a 401 writes no `pipeline_runs` row. So the rotation cannot be verified by looking for errors; it can only be verified by comparing *who is still writing* against *who was writing before*. Once the window rolls past the rotation there is no "before" left to compare against. This file is that "before".

## What the fleet looks like

155 lanes with ≥2 runs in 72 h. Per lane the CSV carries `runs_72h`, `ok_72h`, `last_run_utc`, `p90_gap_s`, `max_gap_s`.

**Two silence signals disagree, and the disagreement is the finding.**

| detector | flags right now |
|---|---|
| `3 × p90`, floor 1800 s (the v2 rule) | 6 lanes |
| `2 × max_gap_72h`, floor 1800 s | **0 lanes** |

Of v2's six, **one is real** and five are the same artifact v1 had, in a new costume.

## The real one

`allday-pack-opens-backfill` — last run **2026-08-22 13:16Z**, silent 12.8 h against a 3×p90 threshold of 8.0 h. Over the 72 h window: **38 runs, 7 ok**, `max_gap 43,800 s` (12.2 h). Independently reached here from p90-gap analysis; the concurrent session reached the same lane from pg_cron dispatch counts. Two different instruments, same lane.

## The five that are not

`wallet-backfill`, `-golazos`, `-multicollection-complete`, `-multicollection-dispatch`, `-ufc` — all last-ran 01:29–01:30Z, all ~36 min quiet, all ratio 1.17–1.22 against the 30-minute floor.

They are not stalled. **Measured over the same 72 h, this family spends 82–87% of wall-clock time inside a gap longer than 30 minutes:**

| lane | gaps > 30 min | seconds beyond the floor | % of 72 h |
|---|---|---|---|
| wallet-backfill | 27 | 224,326 | **86.5%** |
| wallet-backfill-golazos | 29 | 224,057 | **86.4%** |
| wallet-backfill-multicollection-complete | 29 | 223,649 | **86.3%** |
| wallet-backfill-multicollection-dispatch | 29 | 221,995 | **85.6%** |
| wallet-backfill-ufc | 29 | 219,469 | **84.7%** |
| wallet-backfill-pinnacle | 29 | 213,075 | **82.2%** |
| wallet-backfill-allday | 29 | 212,312 | **81.9%** |

A 30-minute floor on these lanes is **true roughly 85% of the time**. Poll at a random instant and you flag each of the seven with ~0.85 probability. That is not a miscalibration, it is an inversion.

The mechanism: `p90_gap` is **20–85 s** while `max_gap` is **20,610–21,579 s** (5.7–6.0 h) — a ratio near 1,000×. These lanes run in dense bursts separated by ~6 h of idle, so nearly all *runs* are inside bursts and nearly all *time* is between them. Any threshold derived from a gap percentile sits inside the burst and every inter-burst pause breaches it. v1 (3× median) failed because p50 = 0 s; v2 (3× p90) fails for the same reason one order of magnitude up. **The next percentile will fail too.** For burst-shaped lanes, run-cadence is the wrong instrument — measure work done per interval (rows written) or ask the burst-level question ("was there a burst in the last 8 h?").

Also worth recording so nobody chases five ghosts: the five stopped **together**, 01:29–01:30Z, and `wallet-backfill-multicollection-dispatch` is one of them. One dispatcher between bursts explains all five at once.

## ⚠ Why the better-looking rule is a trap, and why this file is frozen

`2 × max_gap_72h` gives zero false positives right now — and it also **fails to flag `allday-pack-opens-backfill`**, whose threshold it computes as 24.3 h *because that lane's own 12.2 h outage is inside the window it was calibrated on*. A rolling recalibration learns the outage as normal and stops reporting it. The longer a lane stays broken, the more normal its silence looks.

That is the argument for a **frozen** Phase 0 baseline rather than a live query: the numbers in the CSV are calibration, not status, and they must not be recomputed after the rotation. And known-bad lanes must be excluded **by name at freeze time** — as of this snapshot that is `allday-pack-opens-backfill` (already silent, already writing at 8.6% of expected before the rotation is touched).

## Post-rotation verification

Run this against the frozen CSV, not against a fresh calibration:

```sql
select pipeline, max(started_at) as last_run,
       round(extract(epoch from (now() - max(started_at))))::int as silent_s
from pipeline_runs
where started_at >= '<rotation start timestamptz>'
group by pipeline;
```

Then diff the returned pipeline set against the 155 names in the CSV. **Anything present in the CSV and absent from the post-rotation set is a candidate stranded caller** — that is the whole test, and it works precisely because silence, not error, is the failure mode.

Two things it cannot tell you:

- **The seven `wallet-backfill*` lanes cannot be cleared inside a short window.** Their normal quiet stretch reaches ~6 h, so absence for anything less than that proves nothing. Clear them by row-writes into their target tables instead, or wait 12 h.
- **Lanes whose natural cadence is daily** (`max_gap >= 80,000 s`) need a **full 24 h** past the rotation before their absence means anything. Re-derived by query, not by eye — **20 lanes**: `allday-badge-ingest`, `apply-fmv-haircut`, `candy-editions-ingest-heartbeat`, `compute-laliga-pack-ev-heartbeat`, `daily-portfolio-snapshot`, `drain-conflated-subeditions`, `golazos-buyer-backfill`, `golazos-buyer-discovery`, `ingest-topshot-challenges`, `match-topshot-players`, `ownership-onchain-walk`, `ownership-onchain-walk-heartbeat`, `pinnacle-catalog-backfill`, `pinnacle-sync-heartbeat`, `prune-log-tables`, `purge-stale-listings`, `topshot-catalog-backfill`, `topshot-subedition-backfill`, `ufc-studio-sales-history-backfill`, `ultimate-fmv-recalc-v1`. Twenty lanes plus the seven burst lanes means **the verification tail is 24 h, not an evening** — that sets the real length of the rotation window, and it is the kind of thing that is otherwise discovered at 3 a.m. mid-rotation.
  ⚠ My first pass at this list was eyeballed off the CSV and had **18** entries — it missed `drain-conflated-subeditions` and `ownership-onchain-walk-heartbeat`. Re-derived by `select`. Do not read this list off the CSV by hand.

## Lanes already unhealthy at freeze time, by ok-rate

Not silence, but worth freezing so a post-rotation reader does not attribute them to the rotation: `sync-nba-projections` 0/22 ok · `apply-fmv-haircut` 0/3 · `reconcile-saved-wallet-stats` 2/48 · `wallet-username-resolver` 2/21 · `allday-buyer-backfill` 4/21 · `allday-unmapped-resolver-tail` 6/21 · `allday-pack-opens-backfill` 7/38 · `topshot-fmv-populate` 3/12 · `populate-pinnacle-wmc-fmv` 17/68 · `compute-allday-pack-ev` 37/133 · `run-insider-detectors` 27/66 · `topshot-active-listings-ingest` 2/7 · `refresh_wmc_fmv_drift_active` 274/681 · `lock-check-batch` 69/141 · `fmv-recalc` 72/180 · `refresh-insights-cache` 454/766 · `allday-unmapped-resolver` 173/306.

## Provenance

Every figure above is a `select` against `pipeline_runs` on `bxcqstmqfzmuolpuynti` at 2026-08-23 02:05–02:10Z. Nothing is inferred from a repo file, a dashboard, or a prior filing. No DDL was applied — it was ~02:05Z, inside the degraded band this repo's migration headers forbid, so this snapshot is a file rather than a table.
