# Nightly autonomous pass — 2026-09-01 ~08:0xZ (01:0x PT)

> ⚠ **Environment scope.** This was a **PUSH-ENABLED desktop/device-VM run** (credential in
> `<repo>/.rpc-git-cred`; `git push --dry-run` returned "Everything up-to-date" at run start).
> The *cloud* nightly session cannot push and runs NO-PUSH — that is a fact about the cloud
> environment, not about any artifact here. Everything below is committed to `main` normally.

Genuine overnight: DB `now()` 2026-09-01 08:02:42Z, app-stamped rows 07:56Z (no clock skew), real
local **01:0x PT** — inside the 00:00–06:00 window. Lock taken over from last night's RELEASED
marker. No FREEZE.

## Verdict

**GREEN. One parity commit shipped, zero production-behaviour changes, post-ship watch clean.** A
quiet, verified night — the 03:00–06:00Z cloud pass + Claude Code interactive session had already
drained every 2026-09-01 inbox filing with heavy, well-verified shipping, so almost every live lever
is hot (<48h) or operator-blocked. The one net-new safe action was closing a prod-ahead-of-repo
drift window.

## Shipped

**`e376ccae` — recovered the fileless AllDay-dist rehydrate migration.**
`20260901071258_audit_20260901_allday_dist_opened_rehydrate_the_175_dists_frozen_since_the_one_shot_hydration.sql`
was applied to prod at **07:12Z** by a prior RPC session and never committed, leaving prod ahead of
the repo and `check-migration-parity` red **by name**. Recovered byte-exact from prod via
`scripts/recover-fileless-migrations.mjs --window 1`; written md5 **`33e0d434b37f61eac5fe50c57a41f4ad`**
equals prod's md5 over `array_to_string(statements, E'\n')` (5,752 chars / 5,756 UTF-8 bytes — the
gap is multibyte glyphs, not a mismatch).

What the migration itself does (already applied — this commit only records it): re-`NULL`s
`opened_count` on **175** AllDay distributions frozen since the 2026-06-30 one-shot hydration, so
pg_cron jobid 27's one-shot hydrator re-fills them. Those 175 dists had taken 1,656 pack opens
since their `opened_updated_at`, so the public depletion % (`v_allday_pack_info.opened_pct_of_minted`
and `pack_distributions.total_opened`) was reading up to ~5 points low (worst dist_id 6369:
published 93.4% depleted, true 98.3%). The applying session recorded a positive control (the Dapper
`?mode=probe` leg returned live, matching totals) in the migration header.

- **Revert:** `git revert e376ccae` — removes the file record only. The DB change and the prod
  `supabase_migrations.schema_migrations` row are unaffected (this is a record-recovery, not the
  original apply).
- **Ship budget:** does not count against the 4-item production cap — no production behaviour
  changed; the DB object already existed.

## Post-ship watch — previous 24-48h ships, ALL HOLDING

Measured against the `ops_pgss_delta('3 hours', ...)` baseline (age 3h04m, after the change points):

| ship | pre | post (this pass) | verdict |
|---|---|---|---|
| `refresh_wmc_fmv_drift_active` (OFFSET-0 fence + 26-wallet index) | 30,993 blocks/call | **4,246 /call over 33 calls** | exit met — the >=20-call confirmation the 0410Z note required |
| `get_allday_unresolved_pulls` (90-day window) | 129,112 buffers | **1,622 blocks/call over 6 calls** | holding; forward-resolution path intact |
| `refresh_mv_pack_ev_latest` (rewrite) | 304k buffers | 11,209 blocks/call, 7 calls | stable |
| `fmv-recalc` (historical-fallback finishable + LATERAL) | 100% fallback fail | all runs ok, no errors 6h | ok |
| security (invariants / anon-write / RLS / secdef-anon) | clean | **clean** post-ship | ok |

No shipped change correlates with any regression; nothing auto-reverted.

## Health-drift findings (rpc_ops_snapshot @ 08:05Z vs metrics-latest @ 03:20Z)

- **Security:** invariants `[]`, anon_write_holes `[]`, rls_off_base_tables `[]`, secdef_anon `[]` — all clean.
- **Trust health:** 2 breaches, both known, neither a regression, precompute fresh (5.29h < 13):
  - `public_board_slow_count = 1` (breach_at 1) — the planner-pruned instrument. Real public-page
    instrument (Vercel 5xx, 3h) shows only the known external IPFS-gateway class plus a handful of
    **no-crash** board 504s (`/api/analytics/packs/summary` x3, `sniper-feed`, `collection-stats`,
    `liquidity-distribution` x1) at daytime-IO-band onset — ~0.1% error rate, no error-level logs.
  - `unmapped_resolution_backlog_max = 225` (breach_at 100) — structural, **declining** 265->255->228->225. Do NOT raise breach_at.
- **Pipeline alerts:** all known/structural — `allday-pack-opens-backfill` cron_silent (the EarlyDrop
  ~94%-unlogged false-positive; do NOT suppress/raise), `fmv-backfill` 5/15 failure_rate (trailing
  2-day window, **no new failures** — count held at 5 while denominator grew 13->15; ages out),
  `golazos_sales` + `unmapped-sales-nfl_all_day` info (structural).
- **Sentinel:** `sentinel_ts_uuid_editions_48h = 0`. **DB size:** 14,114 MB.
- **editions_by_collection:** candy_mlb 125, ufc_strike 518, nfl_all_day 6190, nba_top_shot 19933, laliga_golazos 575.

## Queued / needs Trevor (carried, not new)

Unchanged from the 0300Z cloud metrics — all operator-only:
- Retire the duplicate scheduled task `trig_01AZzLzkTPp5xbSjK1EFmeCw` (58 */2 * * *) — `delete_trigger`/`update_trigger` require MCP approval, closed to autonomous runs.
- Both scheduled tasks are UNBOUND (no device binding); a binding cannot be added post-creation — verify the v3 card offers one on the laptop before creating it.
- `INGEST_SECRET_TOKEN` gates the `sales-counterparty-backfill` / `sales-serial-backfill` treadmills (each runs clean but recovers ~nothing).
- Studio-client Top Shot migration is still open and route-code (-> `rpc-handoff`), still sized against the dead `public-api.nbatopshot.com` host (still 530, positive control 200 same second).

## Failed / blocked / reverted

None. No verification failures; no shipping hard-stop.
