# Daytime monitor — 2026-11-11 ~01:12Z (17:12 PT 11-10) — 2 candidates

Read-only daytime health pass (Cowork cloud, lock RELEASED). GREEN overall: security `[]`,
stalled `[]`, 13/13 dashboards' SQL objects resolve, Vercel prod READY, no runtime crash/spike,
client-error beacon 0/12h. NOT in a saturation spell (snapshot fast, trust_precompute 5.29h ok,
board refresh 1.09h). Three trust breaches all known-shape and present in the 11-10 baseline
(`edition_integrity_flags` 11,045→9,119 falling #246 census repair; `candy_ask_book_drop_pct` 90.8
+ `candy_sales_stale_hours` 27.7 = Candy wind-down since the 11-09 revival blip). The 11-10 NEW
breach `public_board_empty_count` (candy_offer_spread_board floor) was fixed during the day
(`20261110154319`) and reads 0. pg_cron's one failure (`rpc-chain-arrivals-seed` 11-10 11:13Z)
predates the 11-10 11:30 AM PT fix → stale pre-fix run, clears on the 11-11 3:13 AM PT tick.

## 1. (MEDIUM) `fmv-backfill` still tips the 60 s statement timeout on ~1/3 of runs post the 11-10 fix

- **Source:** `pipeline_runs` pipeline='fmv-backfill' (last 10) + Vercel runtime `/api/fmv-backfill`
  (last 2026-11-11T00:35:31Z). Error each time: `fmv_backfill_candidates: canceling statement due to
  statement timeout` at exactly 60.1 s.
- **Pattern:** 3 of last 10 runs FAILED at the 60 s cap — 00:35Z 11-11, 12:29Z 11-10, 02:49Z 11-09 —
  while the OK runs land at 24–41 s (6–9 s on 11-08, so the ok-side cost is itself climbing).
  The 11-10 focus steer recorded the `fmv_backfill_candidates` fix as "617k buffers / 1.4 s … read
  its next rows: ok, well under 60 s." Production disagrees: the fix cut the all-timeout state
  (was 3.0M buffers) down to ~1/3 timeouts, but the per-edition sales probe still sits near the cap
  and tips over under load. The 1.4 s was a single quiet-window EXPLAIN, not the lived cost.
- **Risk read:** low-risk to investigate (read-only). This is a backfill lane, not a user path; a
  timed-out run loses that cycle's candidates but the next run re-picks them, so no data loss — but
  the arm will keep flapping MEDIUM and the ok-side cost is trending up, so it is worth closing.
- **Suggested action (night pass / quiet window):** re-measure `fmv_backfill_candidates` BUFFERS in
  a quiet window (positive-control first), then either tighten the per-edition sales probe (the
  acceptance test is an EXPLAIN whose cost sits well under the 60 s budget across a multi-day
  sample, NOT a single fast wall-clock) or lift the lane's `statement_timeout`. Do not conclude a
  cause from one measurement — the fails are spread across hours (00:35/12:29/02:49), consistent
  with a near-threshold query that tips on competing load rather than a single regressing change.

## 2. (LOW / INFO) `wallet-backfill-continuation` failure-rate arm reads HIGH on the already-recovered #245 lane

- **Source:** `rpc_ops_snapshot().pipeline_alerts` (HIGH, "5/5 runs failed (100.0%) over the last 3
  calendar days … HTTP 508") vs `pipeline_runs` for the lane + `wallet-backfill-resume`.
- **What it actually is:** all 5 failures are 508s on deep continuation dispatch (depth 3 / 7),
  newest 2026-11-10 22:11Z (~11 h before this pass) — i.e. they all pre-date or coincide with the
  #245 fix `987f45865` (~2:25 PM PT 11-10, closed in the ledger). The documented recovery path is
  working: `wallet-backfill-resume` is ok=true and has `picked 0 / dispatched 0` for 8 consecutive
  ticks (queue empty, nothing stuck), and no continuation failure has landed in ~11 h. So the lane
  is recovered; the HIGH is a 3-day pooled rate that STRADDLES the fix on a lane that only fires
  when a big wallet needs continuation and therefore has not yet re-armed with a SUCCESS.
- **Risk read:** instrument-cosmetic, no data at risk. But a permanent-looking HIGH on a recovered
  lane is exactly the "instrument that lies" noise every pass then has to re-triage.
- **Suggested action:** consider giving this `failure_rate` arm the same change-point / streak-split
  annotation that `backfill-pack-rip-metadata` already carries ("CLEARED BY THE STREAK SPLIT …"),
  so a recovered rarely-firing lane stops reading HIGH until a genuinely new failure re-arms it.
  No fix needed to the lane itself. Re-raise only if a NEW continuation 508 lands AND the resume
  queue stops draining (picked > 0 persisting).

## ↳ Item 1 acted on — 2026-11-10 ~6:15 PM PT (Claude Code cloud)

Re-measured: 705k buffers / 13.4 s for 0 rows; the unpriced-set anti-join over `fmv_snapshots` was 256k of it and most of the cold IO. `20261111014609` prefilters on `edition_fmv_current` (then confirms against `fmv_snapshots`; same set, EXCEPT both ways = 0) → 533k / 4.2 s, and lifts `statement_timeout` 60 → 90 s (route `maxDuration` 120). Watch the next `fmv-backfill` runs for `ok` and duration. Item 2 (continuation arm streak-split) not acted on — instrument change, left for the night pass.

**↳ Item 1 RESOLVED 11-11 ~1:20 PM PT (Claude Code cloud):** `fmv-backfill` ok on both real runs since `20261111014609` (11:11 PM PT 5.9 s, 7:28 AM PT 0.6 s).
