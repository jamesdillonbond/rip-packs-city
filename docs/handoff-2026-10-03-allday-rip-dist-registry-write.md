✅ **DONE 2026-10-03 ~9:58 AM PT — applied outside the cloud session; verified: `edge_lane_watch` → `pipeline_runs / allday-rip-dist-resolve`, watchlist row active, Edge Lane Observability 18 fresh / 1 unchecked / 0 stale. Nothing left to do here.**

# Handoff → Cowork: apply one small DB write (All Day dist-resolver observability)

**Written** 2026-10-03 ~9:45 AM PT by Claude Code (cloud session). **HEAD at writing:** `2d8366445` or later.

## Context

Already shipped and verified live:

- Edge function `resolve-allday-rip-dist-api` now writes one `pipeline_runs` row per run as
  **`allday-rip-dist-resolve`** (commit `2d8366445`, deployed via `edge-fn-deploy.yml`, read-back
  clean). First row landed 2026-10-03 9:25 AM PT: `ok=true`, `rows_found 0`, `note: none`.
- Migration file `supabase/migrations/20261003163000_audit_20261003_allday_rip_dist_resolve_is_observed_via_its_run_row.sql`
  is committed.

**What this handoff covers:** the migration's two statements are **NOT applied**. Every write
from the cloud session's Supabase MCP (`apply_migration` ×2, `execute_sql` ×3, including after
Trevor disconnected and reconnected the connector) timed out at 60 s with nothing landing. Reads
work, so the connector is holding writes for a confirmation that session cannot display. Verified
after each attempt: `edge_lane_watch.observed_via` still `none`, watchlist row count 0.

⚠ This blocker is specific to that cloud session's connector. Cowork's Supabase MCP or the
dashboard SQL editor should both work.

## The item

**Why:** `rpc-allday-resolve-rip-dist-api` (pg_cron jobid 26, hourly at :17) is the one edge
lane the sentinel's Edge Lane Observability arm reads as "unchecked". The 09-19 seed said it
could not identify the lane's target table. It writes `pack_rips.dist_id`; its other write was to
`api_probe_debug`, a table that does not exist. The backlog is 0 of 2.8M rows, so an
outcome-freshness check would read stale on a healthy empty queue. The new run row is the right
observation.

**Run exactly this** (Supabase MCP `execute_sql` on project `bxcqstmqfzmuolpuynti`, or the
dashboard SQL Editor). It is idempotent:

```sql
UPDATE public.edge_lane_watch
   SET observed_via = 'pipeline_runs',
       pipeline_name = 'allday-rip-dist-resolve',
       outcome_table = NULL, outcome_column = NULL, max_age_hours = NULL,
       severity = 'warn',
       note = 'Writes pack_rips.dist_id for All Day rips with a NULL dist (Dapper searchPackNft). Observed via its own pipeline_runs row (allday-rip-dist-resolve), written on every outcome since 2026-10-03; the old api_probe_debug write targeted a table that does not exist. Backlog was 0 of 2.8M on 10-03, so an outcome-freshness bound would read stale on a healthy empty queue. Cadence armed in pipeline_cadence_watchlist (180/360 min).'
 WHERE jobname = 'rpc-allday-resolve-rip-dist-api';

INSERT INTO public.pipeline_cadence_watchlist
  (pipeline, max_silent_minutes, max_minutes_without_success, severity, notes, is_active)
VALUES ('allday-rip-dist-resolve', 180, 360, 'medium',
  'Edge fn resolve-allday-rip-dist-api (pg_cron jobid 26, hourly :17): names the dist of All Day rips with a NULL pack_rips.dist_id. One pipeline_runs row per run since 2026-10-03 (ok=true on an empty queue). 180 = 3 missed ticks, 360 without success. medium = visibility.',
  true)
ON CONFLICT (pipeline) DO NOTHING;
```

**Preflight (read-only, do first):** confirm the lane is still writing its row, so the registry
never points at a missing pipeline:

```sql
select max(started_at) at time zone 'America/Los_Angeles' from pipeline_runs where pipeline = 'allday-rip-dist-resolve';
```

Expect a time within the last ~70 min.

**Verify after:**

```sql
select (select observed_via || ' / ' || pipeline_name from edge_lane_watch where jobname = 'rpc-allday-resolve-rip-dist-api') as watch,
       (select count(*) from pipeline_cadence_watchlist where pipeline = 'allday-rip-dist-resolve' and is_active) as cad,
       check_edge_lane_observability() -> 'unchecked_count' as unchecked,
       check_edge_lane_observability() -> 'stale_count' as stale;
```

Expect `pipeline_runs / allday-rip-dist-resolve`, `cad = 1`, `unchecked = 1` (only
`rpc-allday-dist-opened-backfill` remains, unchecked by design), `stale = 0`.

**If the MCP is unavailable too, use Chrome:** open
`https://supabase.com/dashboard/project/bxcqstmqfzmuolpuynti/sql/new`, paste the two statements,
Run, then run the verify query the same way. Read only the result grid. Do not open
Settings / API pages: they display keys.

**Revert:**

```sql
UPDATE public.edge_lane_watch SET observed_via = 'none', pipeline_name = NULL, severity = 'warn',
  note = 'NO OUTCOME CHECK because I could not identify its target table with confidence on 2026-09-19.'
  WHERE jobname = 'rpc-allday-resolve-rip-dist-api';
DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline = 'allday-rip-dist-resolve';
```

## After applying

- Add a one-line entry to the top of `docs/overnight/ledger.md`: date, "applied the DB half of
  `20261003163000` (handoff 2026-10-03)", applied via MCP or dashboard, and the revert above.
  Re-read the ledger from disk first and splice at the first line-start `### `. Run
  `awk -f scripts/find-swallowed-ledger-headings.awk docs/overnight/ledger.md` (must print 0).
- **No `schema_migrations` row is needed.** `check-migration-parity` flags production rows with no
  file, never a file with no row. The file is already committed.
- Direct to `main`, no branches, no PRs. If no push path is up, the ledger line can wait: the DB
  change is the deliverable.

Direct inspection of the live tables wins over this doc on any disagreement. Adapt to what is
actually there.

**End state:** the sentinel's Edge Lane Observability reads 18 of 19 lanes observed (1 unchecked
by design), and a silent All Day dist resolver raises an alert after 3 missed hours.
