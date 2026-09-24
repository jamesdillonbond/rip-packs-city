# Overnight autonomous pass — 2026-09-24 (~01:10 AM PT)

**GIT PUSH UNAVAILABLE — DB + local-only this run.** The mounted repo's
`remote.origin.pushurl` is empty and `origin.url` is the plain public URL with no
PAT and no credential helper, so `git push --dry-run` fails
(`could not read Username for github.com`). Ran the full pass in NO-PUSH MODE:
health triage + read-only diagnostics executed normally; DB migrations and artifact
repairs remained on the table (none warranted); code commits/deploys were off the
table and are queued for Trevor. Outputs written to the mounted tree (clone is
per-run/disposable), flagged uncommitted (push unavailable).

- Run id: np-20260924-6ef5993b. Window: genuine overnight (real time verified
  ~08:08Z / ~01:08 AM PT; shell clock agreed with DB now() and app-stamped rows to
  within 1 min — no skew this run). Lock taken over (prior lock RELEASED).
- Shipped: 0. Reverted: 0. Verdict: **GREEN / no regression.**

## Reviewed
- **Continuity:** ledger, metrics-latest.json (09-23 19:10Z), latest handoff
  (09-23 daytime), focus.md. Inbox: newest candidate is `2026-09-23T0510Z` (the
  fourth ask-only writer / Flowty republish item) — already queued as Q0 and
  off-limits (FMV route). **No new inbox candidates since the last pass.** The
  545-file inbox is append-only by rule (INDEX.md CI assertions + live citations);
  left intact, nothing to archive this run.
- **origin/main:** HEAD `7d8671be` at 05:48Z, stable (~2h20m, not advancing during
  the run). The last 24-48h saw heavy Claude Code activity (pack opens/metrics/
  history engine, franchise hubs `/teams`, panini + pack-EV backtest views,
  fast-break honesty). NO-PUSH mode means none of my work touches those hot files.

## Health-drift triage — all GREEN
`rpc_ops_snapshot()` baseline:
- **Security:** invariants [], anon_write_holes [], rls_off_base_tables [],
  secdef_anon_violations [] — 4/4 clean.
- **Trust health:** 0 breaches; all 39 arms `ok`. Notables within band:
  edition_integrity_flags 7 (breach 250), fmv_sweep_stall_pct_24h 3.3% (breach 50),
  allday/candy/golazos/topshot/panini/pinnacle fmv_stale all 0-9.6h and under breach.
- **Stalled pipelines:** []. **Structural-drift arms:** all [] (backward_cursor_rewinds,
  function_search_path_drift, procedure_txn_control_pins, cross_collection_mat_staleness,
  procedure_search_path_unpinned, suppression_parked_claim_drift).
- **Pipeline alerts (5, all severity=info, all previously characterized benign):**
  1. compute-allday-pack-ev failure_rate — **0/76 since last failure 38h ago**;
     cleared by streak split (the 33.9%/3d pooled figure straddles the 09-22 v10 fix).
     Even more clearly recovered than the 09-23 read.
  2. unmapped-sales-nfl_all_day — 9333 actionable open rows, ~5.4d to clear at the 7d
     net rate; frozen multi-NFT txs by design. Chronic, info.
  3. atlas-editions-upstream-403 — 54/480 (11.3%) Cloudflare challenges; 0 of 281 sets
     incomplete >6h (re-walk keeps up). Escalates only if that count goes non-zero.
  4. atlas-market-upstream-403 — 45/460 (9.8%); last successful drain 08:09Z, newest
     event 08:06Z (fresh). Escalates only if no drain in 30 min.
  5. flow-rest-moment-moved-400 — 868/4320 "panic: no nft" = designed outcome (moment
     sold/transferred off the puller wallet; re-asked after 30d).
- **pipeline_fails_24h:** low chronic, none stalled — atlas-market-feed 19 (the 403
  self-heal above), sync-nba-projections 8, wallet-backfill 7, atlas-editions-refresh 4,
  wallet-backfill-allday/golazos 2 each, resolve-topshot-stubs / ts-listings-atlas-sync /
  topshot-pack-supply-backfill 1 each. All self-recovering; trust arms clean.
- **Sentry (org rip-packs-city):** 0 new / 0 escalating (24h). SDK still out of the tree
  (#34, no-spend) — Vercel is the paired authoritative signal.
- **Vercel runtime errors (24h):** 12 groups, **0 new-first-seen** — every group's
  first-seen predates the window (oldest 06-16, newest-introduced 08-23). None traces
  to the 09-24 Claude Code ships. Chronic classes: url.parse DEP0169 warning (148),
  Flow Cadence computation-limit on large TopShot sharded wallets (0xe1f2.., 0x0d74..),
  sniper-feed AD GQL 403 block, wallet-search unresolved username, chronic pack-detail /
  insights statement timeouts (count 1 each, last 09-23).
- **Prod deploy:** production **READY** at `09ada9a5`; the newer `7d8671be` and
  `023fe6ab` are migration-only commits, correctly CANCELED by the deploy-skip rule.
  No ERROR states.

## Post-ship regression watch
The autonomous pass shipped nothing on 09-23 (monitor-mode), so there is no
autonomous ship to re-measure. The 24-48h changes were Claude Code's: verified no
regression — no new Sentry/Vercel error class traces to them (all first-seen predate),
trust arms clean across pack_ev / panini / golazos / candy, TopShot editions grew
14016 -> 14460 (Atlas catalog new-sets ingest healthy), FMV HIGH+MED flat/up, and the
compute-allday-pack-ev alert is now clearly recovered. **Nothing to auto-revert.**

## Overnight deltas (vs 09-23 19:10Z)
- FMV HIGH+MED: TopShot 7750->7771 (+21), AllDay 1747->1768 (+21),
  Pinnacle 701->709 (+8), Candy 26->25 (-1), Golazos 4->4. Flat/slightly up — healthy.
- Editions: TopShot 14016->14460 (+444, catalog ingest), AllDay/UFC/Golazos/Candy flat.
- DB size: 23433 -> 24237 MB (+804 MB in ~13h — pack-opens + catalog ingest write volume).
- sentinel_ts_uuid_editions_48h 0; unmapped_resolution_backlog_max 2. Unchanged, clean.

## Live Cowork artifacts
Enumerated 11 legacy live artifacts. They open only in the desktop Cowork sidebar and
**cannot be updated from this cloud session** — artifact repair is unavailable this run
(logged, per procedure). None were monitor-flagged broken/stale. Verified their 13
distinct backing objects all still exist (incl. the 2 new backtest views); combined with
trust arms public_board_empty_count 0 / public_board_slow_count 0, the surfaces are
healthy. (Q5 consolidation of the 11 dashboards remains a Trevor decision.)

## Shipped
None. NO-PUSH mode + no safe, valuable additive migration or artifact repair available;
did not manufacture work.

## Queued for Trevor (all carried, no NEW items this run)
- **Q0 (HIGH, live, off-limits):** `fmv_from_cached_listings` republishes Flowty
  valuations as ASK_ONLY FMV up to ~20x above live floor on `edition_fmv_current`, with
  $1M troll floors and an unscoped DELETE. FMV route logic — off-limits to autonomous
  ships. Ready-to-run fix in the 09-23 handoff / inbox 2026-09-23T0510Z.
- **Q1** institutional-wallet snapshot silent (needs cron-job.org console).
- **Q2** two disabled 2h Routines (#55) — delete or re-enable.
- **Q3** All Day HIGH+MED honest downward KPI drift from the ghost-floor fix — accept.
- **Q4** Candy MLB HIGH+MED dispersion-gate question (now stable at 25).
- **Q5** consolidate the 11 legacy desktop dashboards.
- **Q6** Top Shot pack-sales ingest ~8h late (head-first walker sweeps full history first;
  the walker just landed 09-24, catching up by design).
- **Operational:** the autonomous pass has now run NO-PUSH for consecutive passes — the
  mounted repo has no push credential (pushurl empty, no helper). Restore the PAT in
  `remote.origin.pushurl` if nightly autonomous code-shipping is wanted. (Does not block
  Q0, which is off-limits regardless.)

## Failed / blocked / reverted
None. No verification failures; no hard-stop triggered.

## Outputs (UNPUSHED — mirrored to mount, picked up by the next push-capable session)
handoff-2026-09-24-overnight-pass.md, ledger.md (appended), metrics-latest.json (overwritten).
CLAUDE.md "Recent sessions" prepend deferred to the next push-capable session (hot file;
avoid editing the mounted copy and creating a pull conflict for Claude Code).
