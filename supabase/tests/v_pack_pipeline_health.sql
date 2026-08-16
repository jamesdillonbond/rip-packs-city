-- DB invariant: public.v_pack_pipeline_health — the standing instrument over pack
-- ingestion for Top Shot + All Day (migration
-- 20260816182300_audit_20260816_pack_pipeline_health_allday_arms_and_static_vs_wedged).
--
-- WHAT IT DOES. One row per pack event_cursor, carrying the cursor's block + age,
-- its owning pipeline's 24 h pipeline_runs activity, per-collection data recency,
-- and a `status`.
--
-- ── THE PROPERTY THAT MATTERS, AND WHY IT IS A REFUSAL ─────────────────────
--
--   ⚠ A STATIC CURSOR IS ONLY DIAGNOSABLE WHEN ITS PIPELINE OWNS EXACTLY ONE.
--   `pack-events-ingest-backfill` drives FOUR cursors and writes ONE pipeline_runs
--   row per invocation, so its rows_found belongs to no particular cursor.
--   Measured live 2026-08-16, that pipeline reported 7,155 rows found / 0 written
--   in 24 h — ALL of it the All Day backfill re-treading blocks the forward cursor
--   had already covered (idempotent ON CONFLICT), while the two Top Shot cursors
--   sat finished at the worker's TARGET_END_BLOCK since 2026-05-21.
--
--   A view that divided rows_found across its cursors would therefore have
--   reported both FINISHED Top Shot cursors as `wedged` — an incident
--   manufactured out of the monitor's own blind spot, on a pipeline that is
--   working exactly as designed. `rows_attributable` is false for those four and
--   the status is the neutral `static`: a description, not a verdict.
--
--   This is the property to protect. It fails in the LOUD direction (a false
--   page), which is the direction that gets a monitor ignored — the cry-wolf cost
--   this repo already paid with `ufc_fmv_stale_hours`, and the same cost the old
--   version of this view was imposing by rendering those two finished cursors as
--   an ever-growing `seconds_since_update` (2,098 h and counting at rebuild time).
--
--   The other three statuses are ordinary and asserted below: `quiescent` (sole
--   cursor, static, finding nothing — done), `wedged` (sole cursor, static, still
--   finding rows — the real defect signal), `live` (cursor moved recently).
--
--   ⚠ ALL DAY MUST APPEAR AT ALL. The pre-2026-08-16 view was Top-Shot-only, so
--   four live All Day cursors were absent and All Day pack ingest could have
--   stopped entirely with the view still green. A regression to TS-only is the
--   most likely way this view silently loses half its job, so it is asserted
--   directly rather than left implied by the other cases.
--
--   ⚠ NOT ASSERTED, deliberately: that the view is CHEAP. Its whole third reason
--   for existing is that the old definition's two bare `count(*)` scans over
--   pack_purchases + pack_rips made `select * from v_pack_pipeline_health` blow
--   the 60 s statement budget outright. Cost is not observable from a rolled-back
--   fixture of a dozen rows — a `count(*)` is instant here. What IS checkable
--   from inside the test is the DEFINITION, so the absence of a bare count and
--   the presence of the reltuples estimate are asserted against pg_get_viewdef,
--   the same trick used to pin CONCURRENTLY on the MV refresh wrappers.

BEGIN;

CREATE TABLE public.event_cursor (
  id text PRIMARY KEY,
  last_processed_block bigint,
  updated_at timestamptz
);

CREATE TABLE public.pipeline_runs (
  pipeline text,
  started_at timestamptz,
  ok boolean,
  rows_found bigint,
  rows_written bigint
);

CREATE TABLE public.pack_purchases (collection_id uuid, sealed_at timestamptz);
CREATE TABLE public.pack_rips      (collection_id uuid, sealed_at timestamptz);

-- ── fixtures ────────────────────────────────────────────────────────────────
-- Top Shot live pair: cursor moved minutes ago.
INSERT INTO public.event_cursor VALUES
  ('topshot_pack_purchases',                  161550253, now() - interval '2 minutes'),
  ('topshot_pack_opens',                      161550253, now() - interval '2 minutes'),
  -- The two finished-by-design Top Shot backfills, frozen at TARGET_END_BLOCK.
  ('topshot_pack_purchases_backfill',         151610000, now() - interval '87 days'),
  ('topshot_pack_opens_backfill',             151610000, now() - interval '87 days'),
  ('topshot_pack_purchases_primary_backfill', 151848205, now() - interval '90 days'),
  -- Sole-cursor pipeline, static, finds nothing => quiescent (walked below SPORK_FLOOR).
  ('topshot_pack_opens_history_backfill',      61808846, now() - interval '10 days'),
  ('allday_pack_purchases',                   161550253, now() - interval '2 minutes'),
  ('allday_pack_purchases_backfill',          161548140, now() - interval '12 minutes'),
  ('allday_pack_opens_forward',               161549184, now() - interval '18 minutes');
  -- allday_pack_opens_backfill deliberately ABSENT => missing_cursor.

INSERT INTO public.pipeline_runs VALUES
  -- Multi-cursor pipeline: finds plenty, writes none (the All Day backfill re-treading).
  ('pack-events-ingest-backfill',         now() - interval '5 minutes',  true, 7155,  0),
  ('pack-events-ingest',                  now() - interval '5 minutes',  true, 15926, 3245),
  -- Sole-cursor, static, nothing found.
  ('topshot-pack-opens-history-backfill', now() - interval '5 minutes',  true, 0,     0),
  -- Sole-cursor, static, STILL FINDING ROWS => the genuine wedge.
  ('allday-pack-opens-backfill',          now() - interval '5 minutes',  true, 801,   0),
  ('allday-pack-opens-forward',           now() - interval '5 minutes',  true, 21,    65);

INSERT INTO public.pack_purchases VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '3 minutes'),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', now() - interval '90 minutes');
INSERT INTO public.pack_rips VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '6 minutes'),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', now() - interval '95 minutes');

-- >>> BEGIN verbatim v_pack_pipeline_health >>>
CREATE OR REPLACE VIEW public.v_pack_pipeline_health
WITH (security_invoker = on) AS
WITH streams AS (
  SELECT *
    FROM (VALUES
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
         WHEN j.runs_24h = 0 AND j.cursor_age_hours < 6 THEN 'map_broken'
         WHEN j.runs_24h = 0                            THEN 'not_running'
         WHEN j.cursor_age_hours < 6                    THEN 'live'
         WHEN j.rows_attributable AND j.rows_found_24h > 0 THEN 'wedged'
         WHEN j.rows_attributable                       THEN 'quiescent'
         ELSE 'static'
       END AS status
  FROM j
 ORDER BY j.collection_slug, j.stream, j.lane, j.cursor_id;
-- <<< END verbatim v_pack_pipeline_health <<<

-- ── 1. THE REFUSAL. A finished cursor on a multi-cursor pipeline is `static`,
--       never `wedged`, even though that pipeline reports 7,155 rows found.
--       Flipping either row's sole_cursor_of_pipeline to true reds this.
SELECT _assert_eq(
  (SELECT status FROM public.v_pack_pipeline_health WHERE cursor_id = 'topshot_pack_purchases_backfill'),
  'static', 'finished TS purchases backfill must be static, not wedged');
SELECT _assert_eq(
  (SELECT status FROM public.v_pack_pipeline_health WHERE cursor_id = 'topshot_pack_opens_backfill'),
  'static', 'finished TS opens backfill must be static, not wedged');
SELECT _assert_eq(
  (SELECT rows_found_24h::text FROM public.v_pack_pipeline_health WHERE cursor_id = 'topshot_pack_opens_backfill'),
  '7155', 'the pipeline-level rows_found is still REPORTED — the view withholds the verdict, not the data');
SELECT _assert(
  (SELECT NOT rows_attributable FROM public.v_pack_pipeline_health WHERE cursor_id = 'topshot_pack_opens_backfill'),
  'a four-cursor pipeline must mark its rows unattributable');

-- ── 2. quiescent: sole cursor, static, finding nothing. The history backfill has
--       walked below SPORK_FLOOR and its edge fn reports done:true every tick.
SELECT _assert_eq(
  (SELECT status FROM public.v_pack_pipeline_health WHERE cursor_id = 'topshot_pack_opens_history_backfill'),
  'quiescent', 'sole-cursor pipeline finding nothing on a static cursor is done, not broken');

-- ── 3. wedged: sole cursor, static, STILL FINDING ROWS. Same static cursor age as
--       case 2 — only rows_found differs, so this pins the discriminator itself.
UPDATE public.event_cursor SET updated_at = now() - interval '10 days'
 WHERE id = 'allday_pack_purchases_backfill';
INSERT INTO public.event_cursor VALUES ('allday_pack_opens_backfill', 85059721, now() - interval '10 days');
SELECT _assert_eq(
  (SELECT status FROM public.v_pack_pipeline_health WHERE cursor_id = 'allday_pack_opens_backfill'),
  'wedged', 'sole-cursor pipeline still finding rows on a static cursor is a real wedge');

-- ── 4. ALL DAY IS PRESENT. A regression to the pre-2026-08-16 Top-Shot-only view
--       is the most likely way this silently loses half its job.
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.v_pack_pipeline_health WHERE collection_slug = 'nfl_all_day'),
  '4', 'all four All Day cursors must appear');
SELECT _assert_eq(
  (SELECT count(DISTINCT collection_slug)::text FROM public.v_pack_pipeline_health),
  '2', 'the view must cover both collections');

-- ── 5. live, and missing_cursor. A cursor row absent from event_cursor must be
--       REPORTED as missing, not dropped by an inner join — a monitor that omits
--       a stream it cannot find is a monitor that goes green when ingest is torn out.
SELECT _assert_eq(
  (SELECT status FROM public.v_pack_pipeline_health WHERE cursor_id = 'allday_pack_opens_forward'),
  'live', 'a cursor that moved 18 minutes ago is live');
DELETE FROM public.event_cursor WHERE id = 'allday_pack_opens_forward';
SELECT _assert_eq(
  (SELECT status FROM public.v_pack_pipeline_health WHERE cursor_id = 'allday_pack_opens_forward'),
  'missing_cursor', 'an absent cursor must surface as missing_cursor, not vanish');

-- ── 6. not_running: no runs in the lookback, on an already-static cursor.
DELETE FROM public.pipeline_runs WHERE pipeline = 'topshot-pack-opens-history-backfill';
SELECT _assert_eq(
  (SELECT status FROM public.v_pack_pipeline_health WHERE cursor_id = 'topshot_pack_opens_history_backfill'),
  'not_running', 'no runs in 24h on a static cursor reports not_running');

-- ── 6b. map_broken, and why the ORDER of these three branches is load-bearing.
--       A cursor advancing while its pipeline logs zero runs is a CONTRADICTION:
--       something is doing the work, so `not_running` is false, and calling it
--       `live` would hide that the wedged/quiescent verdict is now inert for every
--       row sharing that pipeline name. The realistic cause is this view's own
--       hardcoded cursor→pipeline map drifting against a worker rename.
--       ⚠ Without this case the ordering of `not_running` vs `live` is unobservable
--       — the two branches are independent in every other state, so swapping them
--       passed the whole file (mutation-confirmed before this case existed).
--       ⚠ AND WITH IT, SWAPPING THEM IS UNOBSERVABLE AGAIN — deliberately, and this
--       is the honest end state rather than a hole. Once `map_broken` claims the
--       contradictory state, every remaining row has (runs_24h > 0) OR
--       (cursor_age_hours >= 6), so `not_running` and `live` are MUTUALLY EXCLUSIVE
--       and their relative order cannot change any output. Mutation still reports
--       the swap as surviving; it survives because the clause is redundant behind
--       the guard above it, not because the fixture is too weak. Contriving a
--       fixture to kill it would require a state the CASE can no longer produce.
--       It becomes load-bearing again the moment `map_broken` is removed or moved
--       — which is exactly what M4b/M4c above assert.
DELETE FROM public.pipeline_runs WHERE pipeline = 'allday-pack-opens-forward';
INSERT INTO public.event_cursor VALUES ('allday_pack_opens_forward', 161549184, now() - interval '18 minutes');
SELECT _assert_eq(
  (SELECT status FROM public.v_pack_pipeline_health WHERE cursor_id = 'allday_pack_opens_forward'),
  'map_broken', 'a fresh cursor with no runs is a broken cursor->pipeline map, not live and not not_running');

-- ── 7. Cost properties, asserted from the DEFINITION because they are invisible
--       in a fixture this size (see the header). The old view's bare count(*) over
--       pack_purchases/pack_rips is what made it unrunnable in production.
SELECT _assert(
  pg_get_viewdef('public.v_pack_pipeline_health'::regclass, true) LIKE '%reltuples%',
  'row totals must come from the planner estimate, not a scan');
SELECT _assert(
  pg_get_viewdef('public.v_pack_pipeline_health'::regclass, true) NOT LIKE '%count(*) AS count%FROM pack_purchases%',
  'no bare count(*) over pack_purchases — that is what blew the 60s budget');

-- ── 8. security_invoker survived. CREATE OR REPLACE VIEW with no WITH clause
--       RESETS reloptions and silently strips it; nothing in the output shows it.
SELECT _assert(
  (SELECT reloptions @> ARRAY['security_invoker=on']
     FROM pg_class WHERE oid = 'public.v_pack_pipeline_health'::regclass),
  'view must keep security_invoker=on');

ROLLBACK;
