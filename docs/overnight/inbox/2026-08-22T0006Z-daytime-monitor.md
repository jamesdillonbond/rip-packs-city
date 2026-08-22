# Daytime monitor — 2026-08-22T00:06Z (2026-08-21 17:06 PT)

READ-ONLY sweep. Positive control at 00:06Z: **io_wait 0 / active 0 — a genuine QUIET window** (contrast the last several nights' io_wait 24/27 spells). `rpc_ops_snapshot()` returned fast, no timeout. So the durations/failure-rates below are the *accumulated* damage of the multi-day spell read during a quiet instant, not a live spell. Nothing NEW is broken; the standing saturation condition has deepened. No loud page — but the escalation and a usable recovery window are worth Trevor's eyes.

Demand gate (always capture): **21 users / 0 WAU (7d)** — down from 21/1 last night; the only gate that matters, still flat-to-down. Security 4/4 clean. Latest prod deploy READY `052552c4` (collection autoPaginate fix); 0 ERROR deploys in last 20 (the CANCELED tail is docs-only ignoreCommand, expected). Trevor shipped a wave of honesty-layer board fixes today (`398fb8be` cross-collection real-age stamp, `92a1d4b6` rookies/first-mint stale-age, `dde8cd18` entity "No sales yet" three-state) — none appear to regress; they harden exactly the surfaces the spell degrades.

---

## CANDIDATE 1 — SYMPTOM: saturation spell deepened; public boards crossed slow→EMPTY. Quiet window available NOW for the queued manual rebuilds.
- **Source:** `rpc_ops_snapshot()` trust_health + pipeline_alerts, 00:06Z.
- **Observed (symptom, not cause — do not conclude direction from one reading per focus #3):**
  - `public_board_empty_count` **0 → 999** (breach_at 1) — newly breaching tonight; was not in last night's SET.
  - `public_board_slow_count` **6 → 999** (breach_at 1).
  - `board_mv_refresh_stale_hours` **8.03 → 17.86** (breach_at 8) — roughly doubled.
  - Backing failure rates (2d): refresh-insights-cache 53.2%, fmv-recalc 67.0%, compute-allday-pack-ev 80.2%, refresh_wmc_fmv_drift_active 67.3%, populate-pinnacle-wmc-fmv 78.6% — ALL `statement timeout` / `upstream request timeout`, zero logic errors. Same disk-IO root cause (focus #3: cut work, never raise a timeout / upgrade tier).
- **Risk read:** LOW-as-a-bug / MEDIUM-as-a-state. Same root cause the platform has carried for days; user exposure is minimal (0 WAU) and the public surfaces degrade honestly (banners shipped today). The state-change worth noting is empty-vs-slow: precomputed board rows are now reading empty, not merely slow.
- **Suggested action (NOT taken — read-only):** the recovery for board-warm / MV staleness is a manual refresh that is only safe in a quiet window, and **17:06 PT was one** (io_wait 0). The automated refreshes keep dying because they fire during spells; the manual recovery keeps getting deferred because the 1am night pass often runs *inside* a spell. Night pass / Trevor: take the io_wait positive control, and if quiet, run the queued board-warm + cross-collection rebuilds then. Re-measure the two `public_board_*` arms in a quiet window before treating the 999s as anything but accumulated spell damage.

## CANDIDATE 2 — QUEUED (still open): cross-collection MV ~4d20h stale, 5th consecutive failed nightly cycle.
- **Source:** `cross_collection_cohort_mat` / `cross_collection_ts_set_overlap_mat` max(computed_at) = 2026-08-17 04:10Z/04:25Z; `check_pgcron_recent_failures()` shows rpc-ccm-step1 (04:10Z) + rpc-ccm-step2 (04:25Z) both `statement timeout` on 08-21.
- **Risk read:** LOW — freshness miss, cohort count stable (179), NO data loss. User-facing age is now HONESTLY displayed (`398fb8be` shipped today), so the honesty half is closed. Only the data-refresh half remains.
- **Suggested action:** already owned by inbox `2026-08-19T1511Z` CANDIDATE 1 and last night's ledger — re-flag only as "still open, and a quiet window now exists." Recovery = quiet-window self-cleaning per-step pg_cron one-shot (step1 opens with TRUNCATE ACCESS EXCLUSIVE; a rebuild that times out mid-spell empties the public board, so run ONLY when io_wait is verified low). Do not run mid-spell.

## CANDIDATE 3 — VERIFY (new, not obviously saturation-class): candy_offers_unverified_pct = 100.
- **Source:** `rpc_ops_snapshot()` trust_health, 00:06Z. `candy_offers_unverified_pct` = 100 (breach_at 25) — newly breaching, was not in last night's SET. candy-offers-indexer logged 2 fails/24h (minor).
- **Risk read:** LOW stakes (Candy = chain-two, Solana, pre-revenue) but genuinely NEW and NOT the timeout signature the other arms share, so it should not be dismissed as spell collateral without a look.
- **Suggested action (verify, do not conclude):** night pass characterize whether the offer-verification step on candy-offers-indexer is failing vs the arm reading a threshold artifact on a small live offer book. One quiet-window read of the candy offers verification state settles it.

---

**Carried / not re-raised (known-class per ledger + focus STEER):** unmapped_resolution_backlog_max 351 (AllDay permanent floor, do NOT raise breach_at); fmv-recalc wasteful-not-broken; reconcile-saved-wallet-stats still failing (14/24h) — post-ship watch from 08-18, saturation-throttled per-wallet cost, NO revert per last night; candy-editions-ingest / weekly-db-maintenance / pinnacle-sync cron_silent all known threshold/rollup artifacts; panini-ingest info-severity residential-box gap (Trevor's call, left at info); allday-pack-opens-backfill at floor. pg_cron failures all timeout/job-startup-timeout, zero logic errors, none post-date a same-day fix = known saturation signature. Artifact estate NOT deep-payload-validated this run: the insights artifacts' backing views are the same board-warm views timing out above, so running them stacks IO and merely reproduces the known spell; DB responding (snapshot fast), no schema change since last validation.
