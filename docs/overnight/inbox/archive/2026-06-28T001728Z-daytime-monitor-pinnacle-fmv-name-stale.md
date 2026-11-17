# Daytime monitor — 2026-06-28 ~00:09Z (Sat 17:09 PDT, late-afternoon tick)

Health GREEN. security 0/0/0/0 · trust 13/13 ok (0 breaches) · pgcron [] · detect_stalled [] · pipeline_alerts [] · Vercel prod c688f67 (pack-lifecycle) READY, 0 ERROR · Sentry 0 issues/24h · editions FLAT (TS 17471 / AllDay 6191 / Golazos 581 / UFC 518) · FMV TS H+M 4605, AllDay 906 (improving) · sentinel TS-UUID-48h 34 (inert) · DB 6345 MB (+63, benign).

Notable (NOT findings — deliberate, recorded): the standing unmapped_resolution_backlog_max BREACH (484/100) is CLEARED → 26/100 ok, via the topshot-flowty-unmapped-drain + the deliberate close-out commit "scope unmapped_resolution_backlog_max to recent-30d (trust-health 13/13 green)" (16e65d7, CANCELED deploy = docs/SQL-only, expected). The 06-27 CC daytime wave (sentinel_threshold_config, sales/wallet/snapshot GHA backstops + pipeline_run_locks concurrency guard, wmc-fossil on-chain re-key 1748->0, AllDay current-holder resolver, pack-lifecycle page+views+cron) all deployed READY; migrations/views confirmed live this tick (pipeline_run_locks, sentinel_threshold_config[6 rows], v_topshot_pack_lifecycle, v_topshot_pack_realized_ev, drain watchlisted). Recent pipeline fails all transient/recovered (offers-sweep TS-GQL 429 x2, compute-topshot-pack-ev + wmc-fmv-populate statement-timeout x1 each; latest run ok each).

Artifact validation: 13 active (NEW rpc-pack-lifecycle added today 21:40Z). rpc-pack-lifecycle FULLY payload-validated (global/life 40/ev 40/daily 61; 188,005 opened, $1.66M realized, 21% attribution — sane). Shared data layer confirmed live for the rest (pipeline_runs, fmv_snapshots, pinnacle_fmv_history, cached_listings_v2, pack_rips, get_pipeline_alerts, cross_collection mats fresh 20.1h/19.8h <26h). No artifact broken; none repaired (read-only).

## NEW candidate (LOW / docs+prose only) — PINNACLE-FMV-TABLE-NAME-STALE

The Pinnacle FMV table `pinnacle_fmv_snapshots` was replaced by `pinnacle_fmv_history` on 2026-06-08 (old one survives only as `pinnacle_fmv_snapshots_backup_20260608`; current engine `pinnacle-2.0.0-render`). Live schema check this tick: `information_schema.tables` shows ONLY `pinnacle_fmv_history` + `..._backup_20260608` — a query against `pinnacle_fmv_snapshots` now 42P01-errors. The dead name still appears as a CURRENT fact in two durable places:

1. CLAUDE.md — the fmv_snapshots / Known-issues #4 / Architecture-notes areas still say Pinnacle FMV "lives in its own `pinnacle_fmv_snapshots` table ... recomputed daily by algo `pinnacle-1.0.0` ... holds 425 editions." This sits in a "CRITICAL — verify before writing queries" section, so it can mislead a future session into a broken query (the real footgun).
2. rpc-live-health artifact — the Section-3 footer "Source:" prose still lists `pinnacle_fmv_snapshots`. COSMETIC ONLY: the board's CONSOLIDATED_SQL reads `pinnacle_fmv_history` (chart note line ~225) and has loaded fine for 19 days. This is the specific string — folds into the existing WEEKLY-SURFACE-QA-PROSE ledger item, do it in that same prose-fix reinstall (not worth a standalone install).

- Source: information_schema.tables (live) + CLAUDE.md + rpc-live-health/index.html footer (~line 240).
- Risk: docs/prose only — no code/DB/runtime impact, artifact works, no migration.
- Suggested action (night pass / CC): in CLAUDE.md replace Pinnacle-FMV `pinnacle_fmv_snapshots` / `pinnacle-1.0.0` references with `pinnacle_fmv_history` / `pinnacle-2.0.0-render`; fix the live-health footer string alongside WEEKLY-SURFACE-QA-PROSE. LOW priority.

(No other new candidates. ALLDAY-FMV-POPULATE-NOOP-STALL already queued — and not flagging this tick, detect_stalled/alerts both []. ALLDAY-V1-UNMAPPED-DRIFT, TS-WMC-fossil tail, etc. owned/Trevor-decision per ledger.)
