# Daytime monitor — 2026-08-28 ~18:10Z (11:10 PT)

Read-only sweep. Platform is up; no security drift, no ERROR deploys, no new Sentry issues. One
genuinely-new observation worth a quiet-window re-measure; everything else is documented / already
inboxed and is NOT re-filed.

## SYMPTOM (quiet-window re-measure — do NOT act on the cause under saturation, per SKILL Section 1c)

**`rpc_ops_snapshot()` — the monitor's own baseline vector — now TIMES OUT on its `sentinel_fmv_confidence_rows`
leg during the daytime IO band.**
- Source: `SELECT rpc_ops_snapshot();` → `57014 canceling statement due to statement timeout`,
  CONTEXT `sentinel_fmv_confidence_rows` (statement 1). Observed 2026-08-28 18:06Z.
- Positive control at the same minute: `pg_stat_activity` io_wait=9 vs active=8 of 36 sessions — elevated
  IO, consistent with the documented 01:00–19:00Z disk-IO degraded band (18:06Z is near its tail).
- Light indexed reads (`detect_stalled_pipelines`, the security checks, a targeted `pipeline_runs` scan) all
  returned FAST in the same window — so this is the HEAVY FMV-confidence sentinel timing out under the band,
  **not a systemic outage and not a broken function.**
- Risk read: LOW/informational, but it degrades the monitor's OWN baseline instrument — when the band is
  active, `rpc_ops_snapshot()` gives no FMV/editions headline and the sweep must fall back to the discrete
  checks (which is what this run did). Worth knowing before anyone treats a snapshot timeout as a fault.
- Suggested action (quiet window, ~20:00–00:00Z or overnight): re-run `rpc_ops_snapshot()` and, if it still
  times out OUTSIDE the band, drill into `sentinel_fmv_confidence_rows`'s query cost (BUFFERS, not timing);
  if it only times out INSIDE the band, this is pure saturation collateral and needs no code change — it
  rides on the same IO-band work as the MV-refresh cluster below. Symptom observed under saturation —
  re-measure in a quiet window before acting.

## Context for the night pass — NOT new findings, recorded so they are not re-diagnosed

- **209 pipeline_runs fails / 6h**, but the breakdown is ~entirely `statement timeout` / `Timed out
  acquiring connection from connection pool` / `upstream request timeout` clustered 14:00–18:00Z =
  saturation collateral of the band, not N distinct bugs. Top groups: topshot-pack-pool-backfill (41,
  known wedge/#38 fixed dd4be709), wallet-backfill-* (already inboxed 08-28T0420Z/0445Z), compute-*-pack-ev,
  refresh_wmc_fmv_*, fmv-recalc (self-labelled saturation-class; CLAUDE.md: wasteful-not-broken).
- **wallet-backfill 45s→130s fix IS HOLDING**: zero wallet-backfill/-allday/-pinnacle fails in the last 3h
  (targeted scan). The `45000ms` string in the 6h rollup is an OLDER row — `max(error)` is lexicographically
  decoupled from `max(started_at)`; not a regression.
- **pg_cron fails (all timeout/startup-timeout class, no logic errors)**: rpc-refresh-allday-pack-realized
  (3/4, MV refresh statement timeout — already inboxed 08-28T0010Z), rpc-refresh-market-index-daily (2/3),
  rpc-refresh-thin-fmv-guard (1/1, single 08:30Z run), rpc-thp-leg-board-liveness (1/4, job startup timeout).
  These map to the board/market-MV timeout cluster (known-issues #27, needs Trevor). Saturation collateral.
- **Stalled pipelines (both known-expected, do NOT re-raise/suppress)**: candy-editions-ingest BREACH =
  the 22:10Z→01:10Z schedule transition (first run at new slot 2026-08-29 01:10Z; reads breach ~51h across
  it, per ledger); allday-pack-opens-backfill 93m vs 90m threshold = the EarlyDrop ~6%-logging false-fire,
  refuted for suppression in ledger 08-24.
- **Artifact validation DEFERRED this run**: running ~12 heavy jsonb payload queries during the active IO
  band would stack IO and time out uninterpretably (SKILL Section 1b spell discipline). Re-validate next
  quiet-window tick. No artifact is flagged broken.
- sync-nba-projections `all_upstreams_failed` = the known-dead sports/ESPN proxy (#8). Not re-raised.
