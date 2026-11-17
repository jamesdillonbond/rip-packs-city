-- 2026-08-16 — rebuild public.v_pack_pipeline_health.
--
-- ✅ APPLIED 2026-08-16 as schema_migrations version `20260816185749`.
-- (The version differs from this filename's timestamp because apply_migration
-- stamps its own; migration-parity matches on NAME, so that is expected.)
--
-- It was authored UNAPPLIED and held back deliberately: every apply_migration
-- invalidates PostgREST's schema cache and costs a ~10–20 s burst of user-facing
-- PGRST002 500s, and at authoring time the instance was disk-IO saturated (five
-- 60 s MCP timeouts in one session; fmv-recalc killed at maxDuration on ~63–75%
-- of invocations). It was applied later the same day in a measured quiet window
-- — `pg_stat_activity` showing 0 active backends and 0 IO waits — which is the
-- cheap check worth repeating before any apply.
--
-- Verified after apply: all 10 rows present across both collections
-- (6 live / 2 static / 1 quiescent / 0 wedged), `reloptions` still
-- `{security_invoker=on}`, `check_public_security_invariants()` and
-- `check_anon_write_surface()` both 0 rows.
--
-- REVERT: the prior definition is reproduced verbatim at the bottom of this file
-- under "REVERT BODY". Re-run that block; it carries its own
-- `WITH (security_invoker = on)` and its own DROP.
--
-- ── WHY ───────────────────────────────────────────────────────────────────────
-- This view is the only standing instrument over pack ingestion, and a 2026-08-16
-- audit of pack ownership / opens / purchases / sales found three defects in it.
-- Every gap that audit surfaced was invisible *because* of them:
--
--   1. IT IS TOP-SHOT-ONLY. Four live All Day cursors (allday_pack_purchases,
--      allday_pack_purchases_backfill, allday_pack_opens_forward,
--      allday_pack_opens_backfill) appear nowhere. All Day pack ingest could stop
--      entirely and this view would stay green.
--
--   2. IT CRIES WOLF ON TWO CURSORS THAT ARE COMPLETE BY DESIGN.
--      topshot_pack_purchases_backfill and topshot_pack_opens_backfill both stop
--      at the worker's TARGET_END_BLOCK (151_610_000) and have therefore not moved
--      since 2026-05-21/22. The old view rendered that as `seconds_since_update`,
--      a number that has been growing for ~87 days and will grow forever. An arm
--      that can only get redder trains the operator to skim past the whole view —
--      the exact cost this repo already paid with `ufc_fmv_stale_hours`.
--
--   3. ITS OWN COST MAKES IT UNRUNNABLE. Two bare `count(*)` scans over
--      pack_purchases (~302 k) and pack_rips (~3.66 M) — `select * from
--      v_pack_pipeline_health` blew the 60 s statement budget outright during the
--      audit. An instrument you cannot run is not an instrument. Row counts are
--      now planner estimates from pg_class.reltuples (free), and recency is a
--      per-collection `max(sealed_at)` riding idx_pack_{purchases,rips}_collection_time
--      (an index-only backward scan, not a heap scan).
--
-- ── THE STATUS COLUMN, AND WHAT IT DELIBERATELY REFUSES TO SAY ────────────────
-- The distinction worth having is STATIC-BECAUSE-DONE vs STATIC-BECAUSE-WEDGED.
-- A cursor that stopped with nothing left to find is healthy; a cursor that is
-- still finding rows and not advancing is a defect. That is decidable from
-- pipeline_runs.rows_found — but ONLY when the pipeline owns exactly one cursor.
--
-- ⚠ `pack-events-ingest-backfill` drives FOUR cursors and writes ONE pipeline_runs
-- row per invocation, so its rows_found cannot be attributed to a cursor. During
-- the audit that pipeline showed 50,877 rows found / 0 written over 7 days — all
-- of it the All Day backfill re-treading blocks the forward cursor already covered
-- (idempotent ON CONFLICT), while the two Top Shot cursors sat finished. A view
-- that divided rows_found across its cursors would have marked both finished Top
-- Shot cursors `wedged`. So `rows_attributable` is false for those four and the
-- status is the neutral `static` — a description, not a verdict. Reporting an
-- attribution we cannot make is how a monitor manufactures an incident out of its
-- own blind spot.
--
-- Statuses: missing_cursor | not_running | live | wedged | quiescent | static
--
-- SOURCE OF TRUTH for the cursor→pipeline map is workers/pack-events-ingest/index.ts
-- (live mode logs `pack-events-ingest`, POST /backfill logs `pack-events-ingest-backfill`)
-- and the pg_cron jobs rpc-allday-pack-opens-{forward,backfill} / rpc-topshot-pack-opens-history.
-- No block constants are duplicated here on purpose: the worker's TARGET_END_BLOCK /
-- SPORK_FLOOR live in one place, and a copy in SQL would drift silently.
--
-- LOOKBACK is 24 h and must stay well inside pipeline_runs' ~73 h retention
-- (prune_pipeline_runs(3), pg_cron jobid 57) or the activity columns read 0 for
-- every pipeline and every static cursor reports `not_running`.

-- ⚠ DROP + CREATE, NOT `CREATE OR REPLACE` — and this is not a style choice.
-- `CREATE OR REPLACE VIEW` cannot rename or reorder columns; the prior view's
-- first column is `pipeline` and this one's is `collection_slug`, so a replace
-- fails outright:
--     42P16: cannot change name of view column "pipeline" to "collection_slug"
-- ⚠ THE SQL TEST CANNOT CATCH THIS. `supabase/tests/v_pack_pipeline_health.sql`
-- builds the view inside a rolled-back transaction where no prior definition
-- exists, so the compatibility constraint against the LIVE view is invisible to
-- it by construction — the test passed while the apply failed. Verified safe to
-- drop first: zero DB dependents (pg_depend/pg_rewrite) and zero repo consumers;
-- this view is operator-diagnostic only, read by no route, cron or function.
-- ⚠ The REVERT BODY at the bottom carries the same DROP for the same reason —
-- reverting hits the identical constraint in the opposite direction, so a
-- `CREATE OR REPLACE` revert would fail exactly when it is needed.
DROP VIEW IF EXISTS public.v_pack_pipeline_health;

CREATE VIEW public.v_pack_pipeline_health
WITH (security_invoker = on) AS
WITH streams AS (
  SELECT *
    FROM (VALUES
      -- collection_slug, collection_id, stream, lane, cursor_id, pipeline, sole_cursor_of_pipeline
      ('nba_top_shot', '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, 'purchases', 'live',     'topshot_pack_purchases',                  'pack-events-ingest',                  false),
      ('nba_top_shot', '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, 'opens',     'live',     'topshot_pack_opens',                      'pack-events-ingest',                  false),
      ('nba_top_shot', '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, 'purchases', 'backfill', 'topshot_pack_purchases_backfill',         'pack-events-ingest-backfill',         false),
      ('nba_top_shot', '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, 'opens',     'backfill', 'topshot_pack_opens_backfill',             'pack-events-ingest-backfill',         false),
      ('nba_top_shot', '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, 'purchases', 'backfill', 'topshot_pack_purchases_primary_backfill', 'pack-events-ingest-backfill',         false),
      ('nba_top_shot', '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, 'opens',     'history',  'topshot_pack_opens_history_backfill',     'topshot-pack-opens-history-backfill', true),
      ('nfl_all_day',  'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid, 'purchases', 'live',     'allday_pack_purchases',                   'pack-events-ingest',                  false),
      ('nfl_all_day',  'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid, 'purchases', 'backfill', 'allday_pack_purchases_backfill',          'pack-events-ingest-backfill',         false),
      ('nfl_all_day',  'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid, 'opens',     'live',     'allday_pack_opens_forward',               'allday-pack-opens-forward',           true),
      ('nfl_all_day',  'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid, 'opens',     'backfill', 'allday_pack_opens_backfill',              'allday-pack-opens-backfill',          true)
    ) AS t(collection_slug, collection_id, stream, lane, cursor_id, pipeline, sole_cursor_of_pipeline)
), activity AS (
  SELECT r.pipeline,
         count(*)                                  AS runs_24h,
         count(*) FILTER (WHERE NOT r.ok)          AS fails_24h,
         coalesce(sum(r.rows_found), 0)            AS rows_found_24h,
         coalesce(sum(r.rows_written), 0)          AS rows_written_24h,
         max(r.started_at)                         AS last_run_at
    FROM public.pipeline_runs r
   WHERE r.started_at >= now() - interval '24 hours'
     AND r.pipeline IN (
       'pack-events-ingest', 'pack-events-ingest-backfill',
       'topshot-pack-opens-history-backfill',
       'allday-pack-opens-forward', 'allday-pack-opens-backfill'
     )
   GROUP BY r.pipeline
), j AS (
  SELECT s.collection_slug,
         s.stream,
         s.lane,
         s.cursor_id,
         s.pipeline,
         s.sole_cursor_of_pipeline AS rows_attributable,
         c.last_processed_block    AS cursor_block,
         c.updated_at              AS cursor_updated_at,
         round(extract(epoch FROM now() - c.updated_at) / 3600.0, 1) AS cursor_age_hours,
         coalesce(a.runs_24h, 0)         AS runs_24h,
         coalesce(a.fails_24h, 0)        AS fails_24h,
         coalesce(a.rows_found_24h, 0)   AS rows_found_24h,
         coalesce(a.rows_written_24h, 0) AS rows_written_24h,
         a.last_run_at,
         CASE s.stream
           WHEN 'purchases' THEN (SELECT max(p.sealed_at) FROM public.pack_purchases p WHERE p.collection_id = s.collection_id)
           ELSE                  (SELECT max(k.sealed_at) FROM public.pack_rips      k WHERE k.collection_id = s.collection_id)
         END AS data_most_recent,
         CASE s.stream
           WHEN 'purchases' THEN (SELECT c2.reltuples::bigint FROM pg_class c2 WHERE c2.oid = 'public.pack_purchases'::regclass)
           ELSE                  (SELECT c2.reltuples::bigint FROM pg_class c2 WHERE c2.oid = 'public.pack_rips'::regclass)
         END AS table_rows_estimate
    FROM streams s
    LEFT JOIN public.event_cursor c ON c.id = s.cursor_id
    LEFT JOIN activity a            ON a.pipeline = s.pipeline
)
SELECT j.collection_slug,
       j.stream,
       j.lane,
       j.cursor_id,
       j.pipeline,
       j.cursor_block,
       j.cursor_updated_at,
       j.cursor_age_hours,
       j.runs_24h,
       j.fails_24h,
       j.rows_found_24h,
       j.rows_written_24h,
       j.rows_attributable,
       j.last_run_at,
       j.data_most_recent,
       round(extract(epoch FROM now() - j.data_most_recent) / 3600.0, 1) AS data_age_hours,
       j.table_rows_estimate,
       CASE
         WHEN j.cursor_block IS NULL                    THEN 'missing_cursor'
         -- ⚠ A cursor advancing while its pipeline logs ZERO runs is a
         -- contradiction, and the likeliest cause is THIS VIEW'S OWN cursor→
         -- pipeline map having drifted (a pipeline rename in the worker, or a
         -- lookback longer than pipeline_runs' ~73 h retention). It matters
         -- because a wrong map silently disables the wedged/quiescent verdict
         -- for every row that shares it — the map's failure would otherwise
         -- render as a calm `not_running` on a pipeline that is running fine.
         -- Checked BEFORE both, so neither can absorb it.
         WHEN j.runs_24h = 0 AND j.cursor_age_hours < 6 THEN 'map_broken'
         WHEN j.runs_24h = 0                            THEN 'not_running'
         WHEN j.cursor_age_hours < 6                    THEN 'live'
         -- Static cursor. Only a pipeline that owns exactly ONE cursor can say why.
         WHEN j.rows_attributable AND j.rows_found_24h > 0 THEN 'wedged'
         WHEN j.rows_attributable                       THEN 'quiescent'
         ELSE 'static'
       END AS status
  FROM j
 ORDER BY j.collection_slug, j.stream, j.lane, j.cursor_id;

COMMENT ON VIEW public.v_pack_pipeline_health IS
  'Pack ingestion health for Top Shot + All Day: one row per event_cursor, with 24h pipeline_runs activity and per-collection data recency. status distinguishes a cursor that stopped with nothing left to find (quiescent) from one still finding rows and not advancing (wedged); `static` means the owning pipeline drives several cursors so rows_found cannot be attributed — see rows_attributable. Cheap by construction: no count(*), recency rides idx_pack_{purchases,rips}_collection_time.';

-- ── REVERT BODY ───────────────────────────────────────────────────────────────
-- ⚠ The DROP is REQUIRED here too — see the note at the top. Reverting renames
-- the columns back, which `CREATE OR REPLACE VIEW` refuses with the same 42P16.
-- DROP VIEW IF EXISTS public.v_pack_pipeline_health;
-- CREATE VIEW public.v_pack_pipeline_health
-- WITH (security_invoker = on) AS
--  SELECT 'topshot_pack_purchases (live)'::text AS pipeline,
--     (SELECT event_cursor.last_processed_block FROM event_cursor WHERE event_cursor.id = 'topshot_pack_purchases'::text) AS cursor_block,
--     EXTRACT(epoch FROM now() - ((SELECT event_cursor.updated_at FROM event_cursor WHERE event_cursor.id = 'topshot_pack_purchases'::text)))::integer AS seconds_since_update,
--     (SELECT count(*) AS count FROM pack_purchases) AS total_rows,
--     (SELECT max(pack_purchases.sealed_at) AS max FROM pack_purchases) AS most_recent_data
-- UNION ALL
--  SELECT 'topshot_pack_opens (live)'::text AS pipeline,
--     (SELECT event_cursor.last_processed_block FROM event_cursor WHERE event_cursor.id = 'topshot_pack_opens'::text) AS cursor_block,
--     EXTRACT(epoch FROM now() - ((SELECT event_cursor.updated_at FROM event_cursor WHERE event_cursor.id = 'topshot_pack_opens'::text)))::integer AS seconds_since_update,
--     (SELECT count(*) AS count FROM pack_rips) AS total_rows,
--     (SELECT max(pack_rips.sealed_at) AS max FROM pack_rips) AS most_recent_data
-- UNION ALL
--  SELECT 'topshot_pack_purchases (backfill)'::text AS pipeline,
--     (SELECT event_cursor.last_processed_block FROM event_cursor WHERE event_cursor.id = 'topshot_pack_purchases_backfill'::text) AS cursor_block,
--     EXTRACT(epoch FROM now() - ((SELECT event_cursor.updated_at FROM event_cursor WHERE event_cursor.id = 'topshot_pack_purchases_backfill'::text)))::integer AS seconds_since_update,
--     NULL::bigint AS total_rows,
--     NULL::timestamp with time zone AS most_recent_data
-- UNION ALL
--  SELECT 'topshot_pack_opens (backfill)'::text AS pipeline,
--     (SELECT event_cursor.last_processed_block FROM event_cursor WHERE event_cursor.id = 'topshot_pack_opens_backfill'::text) AS cursor_block,
--     EXTRACT(epoch FROM now() - ((SELECT event_cursor.updated_at FROM event_cursor WHERE event_cursor.id = 'topshot_pack_opens_backfill'::text)))::integer AS seconds_since_update,
--     NULL::bigint AS total_rows,
--     NULL::timestamp with time zone AS most_recent_data
-- UNION ALL
--  SELECT 'topshot_moments_hydrator'::text AS pipeline,
--     NULL::bigint AS cursor_block,
--     NULL::integer AS seconds_since_update,
--     (SELECT count(*) AS count FROM v_moments_needing_hydration WHERE v_moments_needing_hydration.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid) AS total_rows,
--     NULL::timestamp with time zone AS most_recent_data;
