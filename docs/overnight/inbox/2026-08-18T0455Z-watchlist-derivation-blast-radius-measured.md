# Blast radius of the watchlist derivation: 67 added → 4 breaching, 0 chronic — but only under a rule the rows do not use

**Filed 2026-08-18T0455Z (2026-08-17 21:55 PT) · Claude Code on Trevor's box · READ-ONLY (no DB writes)**

This is the measurement named as the missing precondition in
[the coverage correction](2026-08-18T0450Z-watchlist-coverage-was-measured-against-rows-the-monitor-ignores.md).
It does not ship the derivation change; it prices it.

## Population

| quantity | value |
|---|---|
| unwatched pipelines, 7d (`pipeline_runs_daily`) | **67** |
| …seen in raw `pipeline_runs` (72h) | 66 |
| …invisible in 72h — no threshold derivable at all | **1** |
| …with only ONE run in 72h — median gap is NULL | **5** |
| **with a derivable median gap** | **61 of 67** |

⚠ **6 of the 67 get NO threshold, and a NULL threshold is a SILENT PASS.** A median-derived rule adds
those six to the list and still does not monitor them: `silent > med * 2.5` is NULL, not true, when
`med` is NULL. They are `candy-editions-ingest-heartbeat`, `ownership-sync-dune`,
`topshot-misattrib-drain`, `topshot-wmc-fossil-drain`, `weekly-wmc-prune`, plus the one pipeline with
no runs inside 72h. **The derivation must FAIL CLOSED on an underivable threshold** — flag as
unclassifiable — or it reproduces the exact defect it was written to fix, at a smaller population.

## Rule A — 2.5 × median, the method the existing rows document

**5 breaching · 3 chronic false-firers** (own p95 gap exceeds its own threshold, i.e. it fires on
ordinary jitter): `backfill-offer-fill-sales`, `promote_unmapped_sales`, and `drain-fmv-cold-tail`
(the last is a boundary artifact — p95/median = **2.50** exactly).

⚠ **Membership FLAPS, and I watched it happen.** `backfill-offer-fill-sales` was `false` in one query
and `true` two minutes later. Its median gap is **1.2 min** against a p95 of **43.1 min** — a
**p95/median of 35×** — so a 2.5× median threshold of 3 min is crossed by its own normal behaviour.
The count moved 4 → 5 between two reads of the same instrument.

## Rule B — `max(2.5 × median, 1.5 × p95, 15 min)`

**4 breaching · 0 chronic.** No pipeline's own p95 gap exceeds its own threshold, so nothing fires on
jitter. `backfill-offer-fill-sales` goes from a 3-minute threshold to ~65.

| pipeline | silent | threshold | verdict |
|---|---|---|---|
| `topshot-flowty-unmapped-drain` | 1604 m | 50 m | ⛔ **correctly retired 08-16** — row already `is_active=false` |
| `topshot-flowty-sales-history-backfill` | 1706 m | 450 m | ⛔ same |
| `drain-fmv-cold-tail` | **126 m** | 113 m | ⚠ **genuine miss, unmonitored** (median gap 30 m) |
| `resolve-topshot-stubs` | **104 m** | 90 m | ⚠ **genuine miss, unmonitored** (median gap 30 m) |

✅ **The flood fear is refuted as stated — 67 additions produce 4 alerts, not 67** — but only under
rule B. Under the documented 2.5×-median method the noise is real, small (3), and flapping. **The
caution was right to demand the number; the number then licensed the change.**

⛔ **And the two retired pipelines are the measured argument for the suppression list.** Derived
membership reads `pipeline_runs`, which still holds their final runs, so they are re-added and alert
**forever**. `is_active=false` on a curated row is doing real work today; derivation must inherit it
as *suppression*, not discard it.

## Preconditions before flipping `detect_stalled_pipelines` to derived membership

1. **Threshold = rule B**, not 2.5 × median alone.
2. **Suppression list seeded** with the two retired `topshot-flowty-*` pipelines.
3. **Underivable threshold fails CLOSED** (unclassifiable ≠ healthy) — covers the 6.
4. **Decide `drain-fmv-cold-tail` and `resolve-topshot-stubs` first.** Both are late right now. Wiring
   an alarm to a condition already true means it fires on arrival.

## Limitations, stated

⚠ **This is a 72h characterization of a 7d population** — raw `pipeline_runs` retains ~73h, and 1 of
the 67 is invisible to it entirely. ⚠ **Daily and weekly pipelines have 1–3 samples**, so their
medians are near-tautological (1440.0) and their p95 carries no information; rule B's 1.5×p95 term is
inert for them and the 15-minute floor is what binds. A 7-day gap distribution needs a rollup that
does not exist.

**No DB change, no migration, no cron change, no watchlist edit.** Read-only.
