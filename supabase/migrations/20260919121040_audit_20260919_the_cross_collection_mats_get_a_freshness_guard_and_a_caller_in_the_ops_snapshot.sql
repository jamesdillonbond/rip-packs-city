-- 2026-09-19 (Cowork cloud). AUTHORED 05:15 PT 09-19.
--
-- Closes the monitoring gap that let cross_collection_cohort_mat sit 53.5 h stale on 09-18 and
-- 61.0 h stale right now with nothing alarming. Two changes, one PGRST002 burst:
--   1. NEW public.check_cross_collection_mat_staleness(numeric) -- ban-at-zero, jsonb ARRAY.
--   2. rpc_ops_snapshot() gains a 'cross_collection_mat_staleness' key that calls it.
--
-- ⛔ WHY NOT A TRUST-HEALTH ARM, WHICH IS WHAT THE FILING ASKED FOR. Twice now that was deferred
--    as "a full-body CREATE OR REPLACE of the trust surface"; this pass measured it instead of
--    repeating the assertion. v_rpc_trust_health is 48,766 chars across 37 UNION ALL branches, and
--    rpc_trust_health_precompute (metric, value, computed_at, duration_ms) has NO breach_at column
--    -- so every threshold lives inside the view text and there is no data-driven path to add one.
--    Rewriting 48,766 chars to add ~6 lines, on the surface that gates public trust, is a worse
--    trade than this: rpc_ops_snapshot() is 5,991 chars, is already what every session and the
--    nightly pass read first, and the same fidelity check applies to it.
--    👉 The trust arm remains the right long-term home. This makes the staleness VISIBLE today.
--
-- ⭐ THE GUARD SHIPS WITH ITS OWN CONTROL PAIR ALREADY IN THE DATA -- no synthetic setup needed.
--    At 05:09 PT: cross_collection_cohort_mat is 61.0 h old (186 rows, step1 has failed on
--    09-17/09-18/09-19) and cross_collection_ts_set_overlap_mat is 12.7 h old (264 rows).
--    So a correct guard at 26 h must return EXACTLY ONE entry, naming the cohort mat and NOT the
--    overlap mat. That is a positive control and a no-change control in a single reading.
--
-- ⚠ EXPECT THIS KEY TO READ NON-EMPTY IMMEDIATELY. That is the point, not a regression the guard
--   introduced: R109 says step1 cannot complete inside 600 s, so the cohort mat will stay stale
--   until R109 is fixed. Do not "fix" this by widening p_max_hours.
--
-- THRESHOLD: 26 h. Both mats rebuild daily (step1 10:02Z, step2 10:35Z), so the healthy maximum
-- age just before a run is ~24 h; 26 leaves ~2 h of slack. Sized from the TRUE cadence read off
-- cron.job, which is the lesson the 0011Z filing paid for -- an arm seeded from an assumed cadence
-- fires nightly on healthy behaviour.
--
-- REVERT:
--   CREATE OR REPLACE FUNCTION public.rpc_ops_snapshot() ... (drop the one added key)
--   DROP FUNCTION IF EXISTS public.check_cross_collection_mat_staleness(numeric);

CREATE OR REPLACE FUNCTION public.check_cross_collection_mat_staleness(p_max_hours numeric DEFAULT 26)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
  SELECT coalesce(jsonb_agg(q.x ORDER BY q.age_hours DESC NULLS FIRST), '[]'::jsonb)
  FROM (
    SELECT jsonb_build_object(
             'kind',        'cross_collection_mat_stale',
             'mat',         m.mat,
             'rebuilt_by',  m.job,
             'computed_at', m.computed_at,
             'age_hours',   round(m.age_hours, 1),
             'max_hours',   p_max_hours
           ) AS x,
           m.age_hours
    FROM (
      SELECT 'cross_collection_cohort_mat'::text         AS mat,
             'rpc-ccm-step1 (jobid 60, 2 10 UTC)'::text  AS job,
             max(computed_at)                            AS computed_at,
             extract(epoch FROM (now() - max(computed_at))) / 3600.0 AS age_hours
        FROM public.cross_collection_cohort_mat
      UNION ALL
      SELECT 'cross_collection_ts_set_overlap_mat'::text,
             'rpc-ccm-step2 (jobid 4, 35 10 UTC)'::text,
             max(computed_at),
             extract(epoch FROM (now() - max(computed_at))) / 3600.0
        FROM public.cross_collection_ts_set_overlap_mat
    ) m
    WHERE m.computed_at IS NULL OR m.age_hours > p_max_hours
  ) q;
$fn$;

COMMENT ON FUNCTION public.check_cross_collection_mat_staleness(numeric) IS
  'BAN-AT-ZERO guard on the two cross-collection mats. Returns a jsonb ARRAY: clean is '
  'jsonb_array_length() = 0, NEVER count(*) = 1 -- a scalar-jsonb check read with count(*) '
  'reports 1 violation when it is clean. Both mats rebuild daily and neither had any freshness '
  'arm: board_mv_refresh_stale_hours guards the board MVs, not these. That gap let '
  'cross_collection_cohort_mat reach 53.5 h stale on 2026-09-18 and 61.0 h on 09-19 behind '
  '/insights/cross-collection with nothing alarming. Their rebuilds are all-or-nothing -- step1 '
  'and step2 each TRUNCATE and re-INSERT in one transaction, so a statement_timeout rolls the tick '
  'back and the mat keeps serving old contents under an old computed_at. Default 26 h is sized '
  'from the TRUE cron cadence (daily => ~24 h healthy maximum, 2 h slack); do not widen it to '
  'silence a real stall. See register R109 for why step1 currently cannot complete.';

REVOKE ALL ON FUNCTION public.check_cross_collection_mat_staleness(numeric) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.rpc_ops_snapshot()
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jsonb_build_object(
    'generated_at', now(),
    'db_size_mb', round((pg_database_size(current_database())/1024.0/1024.0)::numeric, 0),
    'security', jsonb_build_object(
      'invariants', (SELECT coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'object_name', object_name)), '[]'::jsonb)
                     FROM public.check_public_security_invariants()),
      'secdef_anon_violations', public.check_secdef_anon_execute_violations(),
      'rls_off_base_tables', (SELECT coalesce(jsonb_agg(c.relname ORDER BY c.relname), '[]'::jsonb)
                              FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                              WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relrowsecurity=false),
      'anon_write_holes', (SELECT coalesce(jsonb_agg(DISTINCT g.table_name), '[]'::jsonb)
                           FROM information_schema.role_table_grants g
                           JOIN pg_class c ON c.relname=g.table_name AND c.relnamespace='public'::regnamespace
                           WHERE g.table_schema='public' AND g.grantee IN ('anon','authenticated')
                             AND g.privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE')
                             AND c.relrowsecurity=false AND c.relkind IN ('r','p'))
    ),
    'stalled_pipelines', public.detect_stalled_pipelines(),
    -- Added 2026-09-14. Both are BAN-AT-ZERO and both return a jsonb ARRAY:
    -- clean is jsonb_array_length() = 0, never count(*) = 1.
    'suppression_parked_claim_drift', public.check_suppression_parked_claim_drift(),
    'backward_cursor_rewinds', public.check_backward_cursor_rewind(),
    -- Added 2026-09-14. Also a jsonb ARRAY, also clean at length 0.
    'function_search_path_drift', public.check_function_search_path_drift(),
    -- Added 2026-09-18. Same shape, same reading. This one is the INVERSE of the line
    -- above it: `function_search_path_drift` flags a function MISSING a pin, and this
    -- flags a procedure that must NOT have one because it does its own transaction
    -- control. Pinning it costs `2D000` at the next run. Three occurrences to date.
    'procedure_txn_control_pins', public.check_procedure_transaction_control_pin_drift(),
    -- Added 2026-09-19. Same jsonb-ARRAY shape, same ban-at-zero reading. Covers the two
    -- cross-collection mats, which had NO freshness arm of any kind -- the gap that let
    -- cross_collection_cohort_mat reach 53.5 h stale on 09-18 behind a public insights
    -- surface with nothing alarming. EXPECT IT NON-EMPTY until R109 is fixed: step1
    -- cannot complete inside its 600 s ceiling, so the cohort mat stays stale. That is
    -- the guard working, not a regression -- do not widen its threshold to silence it.
    'cross_collection_mat_staleness', public.check_cross_collection_mat_staleness(),
    'pipeline_alerts', public.get_pipeline_alerts(),
    -- `fails` still counts EVERY failure. `upstream` is the subset carrying the Cloudflare
    -- origin-down signature, and the ORDER puts the pipelines whose failures are OURS first, so one
    -- upstream outage across seven pipelines can no longer bury a real one.
    'pipeline_fails_24h', (SELECT coalesce(jsonb_agg(jsonb_build_object('pipeline', z.pipeline, 'fails', z.n, 'upstream', z.u)
                                                     ORDER BY (z.n - z.u) DESC, z.n DESC), '[]'::jsonb)
                           FROM (SELECT pipeline, count(*) AS n,
                                        count(*) FILTER (
                                          WHERE error ~* '(failed with 530|http\s*530|530\s*error code|error code:\s*1033)'
                                        ) AS u
                                 FROM public.pipeline_runs
                                 WHERE ok=false AND started_at > now()-interval '24 hours'
                                 GROUP BY pipeline) z),
    'trust_health', (SELECT coalesce(jsonb_agg(jsonb_build_object('metric', metric, 'value', value, 'breach_at', breach_at, 'status', status) ORDER BY metric), '[]'::jsonb)
                     FROM public.v_rpc_trust_health),
    'trust_health_breaches', (SELECT coalesce(jsonb_agg(metric ORDER BY metric), '[]'::jsonb)
                              FROM public.v_rpc_trust_health WHERE status <> 'ok'),
    'sentinel_ts_uuid_editions_48h', (SELECT count(*) FROM public.editions
                                      WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd'
                                        AND external_id !~ '^[0-9]+:[0-9]+(::[0-9]+)?$'
                                        AND created_at > now()-interval '48 hours'),
    'editions_by_collection', (SELECT jsonb_object_agg(slug, n)
                               FROM (SELECT col.slug, count(*) n FROM public.editions e
                                     JOIN public.collections col ON col.id=e.collection_id GROUP BY col.slug) q),
    -- #121. Was 5 live sentinel_fmv_confidence_rows() calls at ~32.5 s total.
    -- LEFT JOIN, not INNER: a collection with no precompute row must read JSON
    -- `null` (never computed), which is NOT the same claim as `{}`.
    'fmv_by_collection', (
      SELECT jsonb_object_agg(c.slug, p.counts)
      FROM (VALUES
        ('nba_top_shot','95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid),
        ('nfl_all_day','dee28451-5d62-409e-a1ad-a83f763ac070'::uuid),
        ('laliga_golazos','06248cc4-b85f-47cd-af67-1855d14acd75'::uuid),
        ('ufc_strike','9b4824a8-736d-4a96-b450-8dcc0c46b023'::uuid),
        ('disney_pinnacle','7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid)
      ) AS c(slug,cid)
      LEFT JOIN public.fmv_confidence_precompute p ON p.collection_id = c.cid
    ),
    -- The provenance of the key above. A reader that prints the split without
    -- reading this cannot tell a fresh number from a week-old one.
    'fmv_by_collection_computed_at', (
      SELECT jsonb_object_agg(c.slug, p.computed_at)
      FROM (VALUES
        ('nba_top_shot','95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid),
        ('nfl_all_day','dee28451-5d62-409e-a1ad-a83f763ac070'::uuid),
        ('laliga_golazos','06248cc4-b85f-47cd-af67-1855d14acd75'::uuid),
        ('ufc_strike','9b4824a8-736d-4a96-b450-8dcc0c46b023'::uuid),
        ('disney_pinnacle','7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid)
      ) AS c(slug,cid)
      LEFT JOIN public.fmv_confidence_precompute p ON p.collection_id = c.cid
    )
  );
$function$;