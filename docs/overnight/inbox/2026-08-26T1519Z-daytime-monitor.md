# Daytime monitor — 2026-08-26 08:19 PT / 15:19Z (first tick of day)

Read-only sweep. **An IO-saturation spell is ACTIVE** (positive control: io_wait 6 / active 4;
`rpc_ops_snapshot()` and the value-bearing `v_rpc_trust_health` scan both time out; the light
status-only trust scan and catalog reads succeed). Per spell discipline everything below is filed as a
**SYMPTOM** — causes and cost figures are deferred to a quiet-window re-measure. Nothing here is a new
push-needing code task.

## New candidate (1) — candy_offers trust breaches appeared during the day · SYMPTOM

`v_rpc_trust_health` now shows **`candy_offers_oldest_active_hours` = BREACH** and
**`candy_offers_unverified_pct` = BREACH**. Neither was breaching in the nightly baseline
(`metrics-latest.json`, 2026-08-26T08:07Z, which listed only `public_board_slow_count` and
`unmapped_resolution_backlog_max`). So both are new since ~01:07 PT.

- Source: `v_rpc_trust_health` (status-only scan; the value+catches columns time out under the spell).
- Classification: `detect_stalled_pipelines()` does **NOT** flag `candy-offers-indexer`, so the indexer
  is firing on cadence — the breach is offer **freshness / verification aging**, not an indexer stall.
  Most likely candy offer-verification work being killed/queued under the active IO spell (candy is the
  newest, least-prioritized collection), but that is a hypothesis, not a measurement.
- Risk read: low-to-medium. `/insights/candy-mlb` is public; stale/unverified offers could surface on
  its Deals/Spread tabs. No security or write impact.
- Suggested action (NIGHT PASS): **re-measure in a quiet window** — pull the actual
  `candy_offers_oldest_active_hours` value + `candy_offers_unverified_pct` and the candy-offers-indexer
  terminal-vs-heartbeat rows. Only if they stay breached OUTSIDE a spell is this a real candy-offers
  freshness regression to fix. Do not conclude a cause from a spell-time read.

## Known / not re-filed (context for the night pass)

- **pg_cron statement-timeout cluster (8 jobs)** — `rpc-reconcile-saved-wallet-stats`,
  `rpc-refresh-allday-pack-realized`, `rpc-refresh-market-index-daily`,
  `rpc-thin-sale-ask-disclosure-refresh`, `rpc-refresh-new-collectors`, `rpc-thp-leg-impossible-parallel`,
  `rpc-allday-ev-corrected-refresh`, `rpc-refresh-challenge-costs` — all `canceling statement due to
  statement timeout`, zero logic errors. This is the known IO-saturation collateral class (#27,
  focus.md item 3, R46). One root, not 8 bugs. Not re-filed.
- **Trust breaches `board_mv_refresh_stale_hours`, `public_board_empty_count`, `public_board_slow_count`**
  — same saturation family (MV refreshes / candy boards timing out). `unmapped_resolution_backlog_max`
  is the known All Day net-draining structural residual. Not re-filed.
- **`compute-golazos-pack-ev` silent 874 min (> 800 threshold), last run 2026-08-26T00:37Z** — this is
  the KNOWN golazos-specific fault already filed at
  `inbox/2026-08-18T1406Z-golazos-pack-ev-is-not-saturation-and-the-freshness-arm-cannot-see-it.md`
  (net.http_get enqueue reports green while the board goes stale). Recurring, not new. Not re-filed —
  flagging only that it is still active.
- **Other stalled-pipeline arms** — `candy-listings-indexer` (known cry-wolf: writes a terminal row on
  ~1/3 of ticks), `panini-ingest` (known residential home box, ~15% ticks dropped by design, severity
  info), `allday-pack-opens-backfill` (126>90, finite backfill, mild), `topshot-moments-hydrator`
  (80>30, info, ~2 ticks). All known/benign. Not re-filed.

## Clean this run

- Security: `public_security_invariants`, anon-write-on-RLS-off, RLS-off base tables, secdef-anon all
  return `[]`. The 08-26 anon-readable `_rpc_waste_baseline_20260825` scratch table is confirmed closed.
- Vercel: latest READY production deploy = the `rwfc` freshness-guarded fast-path (sha `a2ab3bf`, this
  morning). No ERROR-state deploys; the newer entries are docs-only tips correctly CANCELED by
  `ignoreCommand`.
- Cross-collection refresh (first-tick 1a): both MVs fresh (cohort 2026-08-25 23:10Z / 220 rows, overlap
  23:25Z, within 26h); `rpc-ccm-step1` + `rpc-ccm-step2` both `active` and both `succeeded` last night
  (the 08-23/08-24 step2 failures predate the verified 08-25 enable_nestloop=off fix).
- Trust health: 33 metrics ok, incl. the usually-breaching `ts_uuid_dupes_created_24h` = OK.
- Artifacts: **NOT validated this run** — 11 present; per Section 1b, heavy payload queries are not run
  during an active saturation spell (each stacks IO). Re-validate on a quiet tick. None flagged broken
  in the nightly baseline.
