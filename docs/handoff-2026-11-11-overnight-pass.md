# Overnight pass — 2026-11-11 (~1:05 AM PT, Cowork cloud, laptop-VM clone + .rpc-git-cred push)

**Verdict: GREEN. 0 shipped, 0 reverted.** A quiet, healthy night — nothing cleared the "low-risk + reversible + verifiable within the run + not off-limits" bar that wasn't already handled in-day by Claude Code. 2 instrument/schedule-hygiene items (both daytime-monitor filings) are QUEUE-only by the off-limits rules.

Push AVAILABLE (VM route, `git push --dry-run` exit 0). Not frozen. Lock was RELEASED (11-10 pass). Clock verified vs DB — shell 09:03Z / VM 09:03Z / DB now() 09:04:50Z, no skew; sales ingested 09:03Z, FMV computed 08:53Z (engine live). Genuine overnight window (~1:05 AM PT).

## Reviewed
- `rpc_ops_snapshot` baseline; standing health functions (`check_when_others_timeout_blind` [], `check_zero_yield_lanes`, `check_pgcron_recent_failures`); `fmv_sales_backtest` accuracy gate (TS + All Day, 7d); Vercel prod state + 12h runtime errors + READY/stranded-code check; CLAUDE.md, focus.md, the recent ledger.
- Inbox drained (dispositions below): the two newest daytime filings (2026-11-11T0112Z, 2026-11-11T0715Z) plus the 11-10 afternoon/evening tail (1607Z, 1715Z, 1800Z, 1840Z, 1910Z, 2245Z) — all resolved in-day by Claude Code or known-shape. Inbox left untouched (append-only).
- 13 live dashboards: the 0715Z monitor reconciled the roster (13/13 SQL objects resolve, no new `docs/cowork-skills/*.html`, none flagged broken). No repair needed.
- Stranded-output sweep: inbox / handoffs / flow-ecosystem-watch all identical to origin; mount ledger is 12 entries BEHIND origin (laptop unpulled), 0 stranded entries. Nothing to carry over.

## Health-drift findings + deltas (vs metrics-latest 11-10 ~1:05 AM PT)
- **Security: clean** — invariants / anon_write_holes / rls_off_base_tables / secdef_anon_violations all `[]`.
- **Trust: 1 breach (was 5).** Only `edition_integrity_flags` 10,015 (breach_at 250) — the #246 Candy name-only census repair, falling 20,627 -> 11,045 -> 10,015; fail-safe; WATCH-not-fix per the 11-09 steer (do NOT exclude from the view or raise the threshold). The Candy wind-down cluster all CLEARED: `candy_ask_book_drop_pct` 91.2 -> 4.8, `candy_revival_sales_since_recorded_silence` 1 -> 0, `candy_sales_stale_hours` ok, `public_board_empty_count` 1 -> 0 (the 11-10 in-day board-floor fix `20261110154319` + ask-book recovery + silence re-date `20261110225146`).
- **stalled_pipelines `[]`**; `sentinel_ts_uuid_editions_48h` 0; `ts_uuid_dupes_created_24h` 0.
- **Pipeline alerts (3, all triaged non-actionable):**
  - `wallet-backfill-continuation` HIGH ("5/5 failed, HTTP 508") — RECOVERED instrument-lie. All 5 failures (newest 22:11Z 11-10) pre-date the #245 fix `987f45865` (~2:25 PM PT 11-10); `wallet-backfill-resume` 100% green every 10 min since (queue draining, picked 0). 3-day pooled rate on a rarely-firing lane that has not re-armed with a success. -> QUEUED (see below).
  - `candy-editions-ingest` MED — the daily 01:10Z tick tips a `wallet_moments_cache` lock timeout; the 04:10Z tick clears it (two days running: 11-11 and 11-10 both FAIL 01:10Z / OK 04:10Z). No data loss (re-ingested). -> QUEUED.
  - `fmv-backfill` MED — pooled across its own 11-10 fix. Last fail 00:35Z 11-11 PRE-dates the 01:46Z pin `20261111014609`; the one post-fix run (07:11Z) is OK. Holding; the 3-day rate will decay. Watch, no action (Claude Code's ship).
  - Atlas 403/404/400 `info` rows — by-design upstream-challenge attribution, escalation thresholds unmet, all lanes fresh (last 200s 09:03-09:05Z).
- **pg_cron: 1 fail** — `rpc-chain-arrivals-seed` (job 638, daily 11:13Z = 3:13 AM PT) last_run 11-10 11:13Z failed (`flow_height_estimate` statement timeout). PRE-dates the 11-10 17:03Z fix `20261110170308` -> stale pre-fix run. Next tick 11-11 11:13Z (~2h after this pass) confirms. Focus watch item.
- **zero-yield: 1 offender** — `topshot-map-checkpoint-reconcile` (0 writes/7d, 129 baseline). BENIGN: 6/6 recent runs ok, rows_written 0 — caught-up chain head, no new TS disagreements to reconcile (#226 "finds 0 is genuine"). Not a dead walker.
- **Vercel:** prod READY = `aacfefdeb` (rollback candidate / live). 8 newest prod deploys CANCELED = documented docs/migration-tip skip (diff `aacfefdeb..HEAD` = docs + the already-applied set-slug migration record, 0 app/lib/components code). 12h runtime errors: 5 groups, all known-chronic single/double occurrences (set-activity timeout 2x, fmv-backfill 1x pre-fix, insights/squeeze, sniper-feed allday, insights/trophies) — no new crash group, giveaway routes error-free.
- **Accuracy gate (7d, published):** TS ALL ratio 1.000 (13.3% err, within25 70.1%), HIGH 1.000 (within25 78%). All Day ALL 0.933 (>=0.90 — IMPROVED from 0.909 on 11-10, steer trigger not met), HIGH 0.881 (abs_err $0.03, sub-$1 quantization). In band.
- **Deltas:** db 50,759 -> 51,788 MB (+1,029, census editions). Candy editions 22,021 -> 27,415 (+5,394 census discovery; orphan cleanup netting against it). `edition_integrity_flags` 11,045 -> 10,015. Trust breaches 5 -> 1. FMV HIGH+MED stable: nba 6,867->6,874, panini 19,159->19,762, nfl 1,781->1,760, pinnacle 968->969.

## Post-ship regression watch (11-10 afternoon + evening ships) — CLEAN
Re-measured the heavy 11-10 Claude Code day (fmv-backfill prefilter `20261111014609`, pack_table_rows probe, sales ingested_at indexes, set-slug index, Panini set-progress + covering index, buyer-backfill telemetry fn, All Day set-tracker current-FMV, 8+ giveaway code ships, sol_usd_daily). No regression traces to any:
- Security clean (would catch any giveaway-route grant/RLS drift).
- fmv-backfill fix holding (post-fix 1/1 ok).
- Giveaway routes: 0 runtime errors in 12h.
- `public_board_empty_count` 0 (candy board-floor fix holding).
- No new Vercel crash group; 0715Z monitor client-error beacon 0/12h.
- Inconclusive, left to the owning session: buyer-backfill `sales_2023/24/25` `last_seq_scan` still ticks at :05, but that stat is shared across many readers — the precise pgss-queryid check is Claude Code's recorded watch, not evidence of regression.

## Shipped
None. Nothing cleared the ship bar that wasn't already handled in-day.

## Queued (needs decision / owner)
1. **`candy-editions-ingest` 01:10Z daily wmc lock timeout** (MED, inbox 2026-11-11T0715Z). Fails every 01:10Z tick on `wallet_moments_cache: canceling statement due to lock timeout`, self-heals 04:10Z; no data loss. NOT auto-shipped — both fix paths are gated:
   - *Stagger the tick off the collision* -> needs the 01:10Z lock holder identified across >=2 ticks (next 01:10Z is ~16h out; can't verify a new slot avoids the collision this run). `candy-editions-ingest` is absent from `cron.job` (not pg_cron) -> likely cron-job.org, so the stagger is a Chrome-console edit.
   - *SKIP LOCKED / short-retry on the wmc write* -> ingest route-logic, OFF-LIMITS (documented invisible-failure class). Ready-to-run only after human/Claude-Code review.
   - Recommended next step: at ~01:10Z snapshot the `pg_stat_activity` blocker chain + `cron.job` near :10 to name the holder, then stagger (lowest-risk) or hand the SKIP LOCKED diff to Claude Code.
2. **`wallet-backfill-continuation` failure_rate arm reads HIGH on the recovered #245 lane** (LOW/cosmetic, inbox 2026-11-11T0112Z item 2). The lane is fixed; the HIGH is a 3-day pooled rate straddling the fix on a lane that only fires on a big-wallet continuation and so hasn't re-armed with a success. Monitor's suggestion: give this arm the same change-point/streak annotation `backfill-pack-rip-metadata` carries (mechanism: migration `20260923231922` "failure_rate arm also splits at the last failure"). NOT auto-shipped: it modifies a pinned health instrument (push-gated, multi-file, blast radius into the sweep) and is a suppression of a real-if-stale alert — CLAUDE.md "remove the failure mode, don't soften the detector". Self-clears the moment the next continuation runs and succeeds. Hand to Claude Code (owns #245) or let it re-arm naturally.

## Failed / blocked / reverted
None.

## Watch (next pass / tomorrow)
- `rpc-chain-arrivals-seed` 11-11 11:13Z tick -> ok closes the pre-fix stale pg_cron fail.
- `fmv-backfill` next few runs -> all ok + duration well under 90 s confirms the `20261111014609` pin.
- `edition_integrity_flags` -> continuing to fall toward 250 as the #246 census repair laps.
- `candy-editions-ingest` next 01:10Z tick (if investigating the collision).
