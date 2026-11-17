-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠ VERSIONED 215000 ON PURPOSE, NOT WHEN IT WAS APPLIED (~18:35Z). It was first
-- written as 20260914183500 and that ORDER WAS A LATENT REVERT: migration
-- 20260914190000_..._the_search_path_class_gets_a_guard_... also does a FULL-BODY
-- CREATE OR REPLACE of rpc_ops_snapshot (14 keys, live FMV leg), so on a replay it
-- would run AFTER this file and silently undo the precompute and its provenance
-- key. Production was applied in the correct order and is right; only the FILE
-- order was wrong. Renamed so a replay reproduces the live body. Parity keys on
-- the migration NAME, not the version, so the rename does not orphan the applied row.
-- ─────────────────────────────────────────────────────────────────────────────
-- #121 exit (2): the snapshot's dominant leg becomes a precompute, WITH its
-- provenance.
--
-- MEASURED FIRST (2026-09-14, quiet window, positive control pg_stat_activity
-- io_wait 1 / active 2). `rpc_ops_snapshot()` is cancelled 57014 at a 50 s
-- budget. Its `fmv_by_collection` leg calls sentinel_fmv_confidence_rows() five
-- times and costs 32.58 s COLD / 32.50 s WARM. Warm == cold means the leg is
-- COMPUTE-bound and cache-immune, so no index and no cache can touch it -- a
-- precompute is the only lever. (For contrast, the 38-arm trust view is 13.62 s
-- cold / 0.00 s warm, i.e. IO-bound and already cache-served; de-duplicating its
-- double read looks like a 23% win and measures ZERO. Not done, deliberately.)
--
-- ⚠ HONESTY: a precomputed headline metric MUST project its provenance, or no
-- reader downstream can be honest. Three states are preserved deliberately:
--   * never computed   -> NO ROW  -> the key reads JSON `null`
--   * computed, empty  -> a row with counts `{}`  (disney_pinnacle is this today)
--   * computed, values -> a row with counts
-- `{}` and `null` are NOT interchangeable here, and the new sibling key
-- `fmv_by_collection_computed_at` is what makes a stale split visible instead of
-- passing as live. The existing `fmv_by_collection` SHAPE is unchanged, so no
-- reader breaks.
--
-- ⚠ A collection whose refresh raises does NOT overwrite its own row. The old
-- row survives and its computed_at ages visibly -- the alternative (writing `{}`
-- on failure) is this estate's most productive defect class: a failed read
-- rendering as a fact.
--
-- anon-exec: refresh_fmv_confidence_precompute -- REVOKED below; it is a writer, called only by pg_cron.
-- anon-exec: rpc_ops_snapshot -- unchanged; CREATE OR REPLACE does not reset a function ACL, so this re-declaration must NOT add a revoke (it would change production while pretending to be a body-only edit).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.fmv_confidence_precompute (
  collection_id uuid PRIMARY KEY,
  slug          text        NOT NULL,
  counts        jsonb       NOT NULL,
  computed_at   timestamptz NOT NULL DEFAULT now(),
  duration_ms   integer
);

COMMENT ON TABLE public.fmv_confidence_precompute IS
  'Per-collection FMV confidence split, precomputed. #121: the live 5x sentinel_fmv_confidence_rows() leg is compute-bound at ~32.5s and timed out rpc_ops_snapshot(). NO ROW means never computed (reads as JSON null); counts={} means computed and genuinely empty. computed_at is the provenance the readers must project.';

ALTER TABLE public.fmv_confidence_precompute ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.refresh_fmv_confidence_precompute()
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  r         record;
  v_counts  jsonb;
  v_start   timestamptz;
  v_ms      integer;
  v_ok      integer := 0;
  v_failed  jsonb   := '[]'::jsonb;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('nba_top_shot',   '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid),
      ('nfl_all_day',    'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid),
      ('laliga_golazos', '06248cc4-b85f-47cd-af67-1855d14acd75'::uuid),
      ('ufc_strike',     '9b4824a8-736d-4a96-b450-8dcc0c46b023'::uuid),
      ('disney_pinnacle','7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid)
    ) AS c(slug, cid)
  LOOP
    BEGIN
      v_start := clock_timestamp();

      SELECT coalesce(jsonb_object_agg(s.confidence, s.count), '{}'::jsonb)
        INTO v_counts
        FROM public.sentinel_fmv_confidence_rows(r.cid) s;

      v_ms := (EXTRACT(EPOCH FROM (clock_timestamp() - v_start)) * 1000)::integer;

      -- clock_timestamp(), not now(): now() is the TRANSACTION timestamp and
      -- would understate freshness by the whole ~32 s run.
      INSERT INTO public.fmv_confidence_precompute AS f
             (collection_id, slug, counts, computed_at, duration_ms)
      VALUES (r.cid, r.slug, v_counts, clock_timestamp(), v_ms)
      ON CONFLICT (collection_id) DO UPDATE
        SET slug        = EXCLUDED.slug,
            counts      = EXCLUDED.counts,
            computed_at = EXCLUDED.computed_at,
            duration_ms = EXCLUDED.duration_ms;

      v_ok := v_ok + 1;
    EXCEPTION WHEN OTHERS THEN
      -- Deliberately per-collection: one collection's failure must not discard
      -- the other four's fresh values. The failed one keeps its PREVIOUS row,
      -- whose computed_at then ages -- visible staleness beats a fabricated {}.
      v_failed := v_failed || jsonb_build_object('slug', r.slug, 'error', SQLERRM);
    END;
  END LOOP;

  RETURN jsonb_build_object('refreshed', v_ok, 'failed', v_failed, 'at', clock_timestamp());
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.refresh_fmv_confidence_precompute() FROM PUBLIC, anon, authenticated;

SELECT cron.schedule(
  'rpc-refresh-fmv-confidence-precompute',
  -- Quiet-band only (01:35/05:35/09:35/13:35Z = 18:35/22:35/02:35/06:35 PT).
  -- ⚠ APPLIED AS '35 1,7,13,19' AND ALTERED TO THIS WITHIN THE HOUR, deliberately
  -- and recorded rather than left as a fileless drift: the seed run measured
  -- nba_top_shot at 93,063 ms of a 106.9 s total, and TS swings ~25 s (io_wait 1)
  -- to 93 s (io_wait 9). pg_cron's 120 s ceiling is therefore MARGINAL, so the two
  -- daytime-band slots were moved out before any reader depended on them. A replay
  -- of this file produces the LIVE schedule, not the superseded one.
  '35 1,5,9,13 * * *',
  $cron$SELECT public.refresh_fmv_confidence_precompute();$cron$
);

-- ── rpc_ops_snapshot(): fmv_by_collection now reads the precompute, and gains a
-- SIBLING provenance key. Live body re-read immediately before writing this
-- (length 4697, md5 c07b67879a58a1e76ca799742084a08e, 14 keys) per the standing
-- CREATE OR REPLACE rule -- this is a FULL-BODY WRITE.
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
    -- #121. Was 5 live sentinel_fmv_confidence_rows() calls at ~32.5 s total, which
    -- is what pushed this function past its budget. LEFT JOIN, not INNER: a
    -- collection with no precompute row must read JSON `null` (never computed),
    -- which is NOT the same claim as `{}` (computed, genuinely empty).
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

-- ── Verify on the DEFINITION, not by calling it: the pre-change function needs
-- >45 s, so executing it here could abort this migration.
DO $verify$
DECLARE
  d text;
  k text;
  prior text[] := ARRAY[
    'generated_at','db_size_mb','security','stalled_pipelines',
    'suppression_parked_claim_drift','backward_cursor_rewinds',
    'function_search_path_drift','pipeline_alerts','pipeline_fails_24h',
    'trust_health','trust_health_breaches','sentinel_ts_uuid_editions_48h',
    'editions_by_collection','fmv_by_collection'
  ];
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='rpc_ops_snapshot';

  -- All 14 pre-existing keys survived this full-body write, not just the 15th.
  FOREACH k IN ARRAY prior LOOP
    IF position('''' || k || '''' IN d) = 0 THEN
      RAISE EXCEPTION 'rpc_ops_snapshot lost pre-existing key %', k;
    END IF;
  END LOOP;

  IF position('''fmv_by_collection_computed_at''' IN d) = 0 THEN
    RAISE EXCEPTION 'rpc_ops_snapshot did not gain its provenance key';
  END IF;

  -- The upstream classifier must still be present exactly as the repo test pins it.
  IF position('failed with 530' IN d) = 0 THEN
    RAISE EXCEPTION 'rpc_ops_snapshot lost its upstream failure classifier';
  END IF;

  -- The new function must NOT be anon-executable.
  IF has_function_privilege('anon', 'public.refresh_fmv_confidence_precompute()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.refresh_fmv_confidence_precompute()', 'EXECUTE') THEN
    RAISE EXCEPTION 'refresh_fmv_confidence_precompute is anon/authenticated executable';
  END IF;

  -- And the new table must not widen the RLS-off surface the snapshot bans.
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
             WHERE n.nspname='public' AND c.relname='fmv_confidence_precompute'
               AND c.relrowsecurity=false) THEN
    RAISE EXCEPTION 'fmv_confidence_precompute has RLS off';
  END IF;
END
$verify$;
