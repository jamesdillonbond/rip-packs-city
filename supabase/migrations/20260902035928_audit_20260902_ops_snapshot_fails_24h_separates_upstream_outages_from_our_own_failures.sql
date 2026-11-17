-- audit_20260902_ops_snapshot_fails_24h_separates_upstream_outages_from_our_own_failures
-- anon-exec: rpc_ops_snapshot — SECURITY DEFINER, service_role-only, identical signature.
-- CREATE OR REPLACE preserves the ACL ({postgres=X/postgres,service_role=X/postgres}); anon and
-- authenticated EXECUTE remain false (asserted below).
--
-- WHAT THIS FIXES
-- `pipeline_fails_24h` is a bare `count(*) WHERE ok=false`, ordered by that count. One upstream
-- outage therefore takes the top of the operator's failure list and pushes the pipelines that are
-- ACTUALLY broken off the bottom of the eye. Measured on this instance, trailing 24 h, at the moment
-- of writing: **51 of 82 failures are one Top Shot GraphQL Cloudflare 530**, spread across seven
-- pipelines — and the ranking it produced was:
--
--   offers-sweep 36 · sync-nba-projections 8 · ingest 7 · wallet-backfill 7 · …
--
-- `offers-sweep` is at the top with FRESH data (`edition_offers` max updated_at was ~1 min old) and
-- its failures are the upstream breaker working exactly as designed — the `ok=false` on every second
-- tick is the state the breaker READS to know the upstream is still down. Meanwhile
-- `sync-nba-projections` (dead sports proxy, known-issues #8) and three `wallet-backfill*` pipelines
-- that are losing rows sat beneath it.
--
-- ⛔ THE FIX IS ON THE READER, NOT THE WRITER, AND THAT DISTINCTION IS THE WHOLE POINT.
-- The obvious repair — have offers-sweep log `ok=true` for a 530 — was proposed, measured against the
-- code it would change, and is HARMFUL: `checkUpstreamBreaker` finds "the most recent REAL run" by
-- skipping skip-markers, so a failing probe that reported ok=true would leave no failing run to find,
-- the breaker would return `last_run_ok` forever, and it would attack a dead upstream at full price
-- on every tick with nothing recording that the protection was lost. Changing a writer to make a
-- metric look nicer destroys the signal the writer exists to emit. So the writer is untouched and the
-- OBSERVER learns to classify.
--
-- THE CHANGE (additive; no existing key changes meaning)
--   • each row gains `upstream` — how many of that pipeline's failures carry the Cloudflare
--     origin-down signature. `fails` still counts EVERY failure, so nothing is hidden or subtracted.
--   • the ordering becomes `(fails - upstream) DESC, fails DESC` — most OUR-OWN failures first. The
--     same 24 h now reads: sync-nba-projections 8/0 · wallet-backfill 7/0 · wallet-backfill-allday
--     5/0 · wallet-backfill-golazos 5/0 · … with offers-sweep 36/36 correctly demoted.
--
-- ⚠ THE SIGNATURE IS A COPY OF `CLOUDFLARE_ORIGIN_DOWN` IN lib/pipeline/upstream-breaker.ts, and the
-- copy is deliberate — that module cannot be imported from SQL. It is pinned against drift by
-- __tests__/ops-snapshot-upstream-signature-matches-breaker-guard.test.ts, which fails in CI naming
-- THIS migration if either side changes. It covers the four spellings observed in `pipeline_runs`:
--   "Top Shot GraphQL failed with 530. Response body: …" · "http 530: error code: 1033"
--   "gql HTTP 530: error code: 1033"                      · "HTTP 530 error code: 1033"
-- ⚠ Deliberately NOT a bare `530`: that matches row counts, ids and byte sizes, and a signature that
-- matches ordinary text would let a failure in OUR OWN code be filed as someone else's outage — which
-- is the exact defect this migration exists to remove, pointed the other way.
--
-- REVERT: re-apply the previous body (the `pipeline_fails_24h` sub-select without the `upstream`
-- FILTER and with `ORDER BY n DESC`); nothing else in the snapshot is touched. No table, index,
-- schedule or grant changed.

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
    'pipeline_alerts', public.get_pipeline_alerts(),
    -- `fails` still counts EVERY failure. `upstream` is the subset carrying the Cloudflare
    -- origin-down signature, and the ORDER puts the pipelines whose failures are OURS first, so one
    -- upstream outage across seven pipelines can no longer bury a real one. See the header.
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
    'fmv_by_collection', (
      SELECT jsonb_object_agg(c.slug, fmv.counts)
      FROM (VALUES
        ('nba_top_shot','95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid),
        ('nfl_all_day','dee28451-5d62-409e-a1ad-a83f763ac070'::uuid),
        ('laliga_golazos','06248cc4-b85f-47cd-af67-1855d14acd75'::uuid),
        ('ufc_strike','9b4824a8-736d-4a96-b450-8dcc0c46b023'::uuid),
        ('disney_pinnacle','7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid)
      ) AS c(slug,cid),
      LATERAL (SELECT coalesce(jsonb_object_agg(s.confidence, s.count),'{}'::jsonb) AS counts
               FROM public.sentinel_fmv_confidence_rows(c.cid) s) fmv
    )
  );
$function$;

COMMENT ON FUNCTION public.rpc_ops_snapshot() IS
  'One-call operator snapshot: security invariants, stalled pipelines, alerts, 24 h failure buckets, '
  'trust-health arms, edition and FMV-confidence census. '
  '⚠ pipeline_fails_24h CLASSIFIES (2026-09-02): each row is {pipeline, fails, upstream}, where '
  '`fails` is every ok=false run in 24 h and `upstream` is the subset matching the Cloudflare '
  'origin-down signature. Rows are ordered by (fails - upstream) DESC, so the pipelines whose '
  'failures are OURS rank first. Measured when this shipped: 51 of 82 failures in 24 h were ONE Top '
  'Shot GraphQL 530 spread over seven pipelines, and the old count-ordered list put a pipeline with '
  'FRESH data at the top while sync-nba-projections and three wallet-backfill* pipelines sat under it. '
  '⛔ Do NOT "fix" this on the writer side by logging ok=true for a 530: checkUpstreamBreaker finds '
  'the most recent REAL run by skipping skip-markers, so a probe reporting ok=true leaves no failing '
  'run to find and the breaker disarms itself permanently. The writer is load-bearing; the observer '
  'classifies. '
  '⚠ The signature is a hand-copy of CLOUDFLARE_ORIGIN_DOWN in lib/pipeline/upstream-breaker.ts '
  '(SQL cannot import it) and is pinned by '
  '__tests__/ops-snapshot-upstream-signature-matches-breaker-guard.test.ts.';

DO $mig$
DECLARE
  v_snap jsonb;
  v_rows jsonb;
  v_missing int;
  v_up int;
  v_ours int;
  v_first_ours int;
  v_last_ours int;
BEGIN
  IF has_function_privilege('anon', 'public.rpc_ops_snapshot()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POST-STATE FAILED: anon gained EXECUTE';
  END IF;
  IF has_function_privilege('authenticated', 'public.rpc_ops_snapshot()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POST-STATE FAILED: authenticated gained EXECUTE';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.rpc_ops_snapshot()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POST-STATE FAILED: service_role LOST EXECUTE — every operator read would 403';
  END IF;

  v_snap := public.rpc_ops_snapshot();
  v_rows := v_snap -> 'pipeline_fails_24h';

  -- The snapshot must still be WHOLE. A rewrite that dropped a sibling key would leave this
  -- migration's own target looking perfect.
  IF NOT (v_snap ? 'security' AND v_snap ? 'stalled_pipelines' AND v_snap ? 'pipeline_alerts'
          AND v_snap ? 'trust_health' AND v_snap ? 'trust_health_breaches'
          AND v_snap ? 'editions_by_collection' AND v_snap ? 'fmv_by_collection'
          AND v_snap ? 'sentinel_ts_uuid_editions_48h' AND v_snap ? 'db_size_mb') THEN
    RAISE EXCEPTION 'POST-STATE FAILED: a sibling key of the snapshot was lost';
  END IF;

  SELECT count(*) INTO v_missing
  FROM jsonb_array_elements(v_rows) e
  WHERE NOT (e ? 'upstream' AND e ? 'fails' AND e ? 'pipeline');
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'POST-STATE FAILED: % rows are missing a key', v_missing;
  END IF;

  SELECT count(*) FILTER (WHERE (e->>'upstream')::int > 0),
         count(*) FILTER (WHERE (e->>'fails')::int - (e->>'upstream')::int > 0)
    INTO v_up, v_ours
  FROM jsonb_array_elements(v_rows) e;

  -- POSITIVE CONTROL, both directions: the classifier is only proven by a window that contains BOTH
  -- kinds. If it does not, say so rather than passing on a vacuous check.
  IF v_up > 0 AND v_ours > 0 THEN
    SELECT (v_rows->0->>'fails')::int - (v_rows->0->>'upstream')::int,
           (v_rows->-1->>'fails')::int - (v_rows->-1->>'upstream')::int
      INTO v_first_ours, v_last_ours;
    IF v_first_ours <= v_last_ours THEN
      RAISE EXCEPTION
        'POST-STATE FAILED: ordering did not take — first row has % our-own failures, last has %',
        v_first_ours, v_last_ours;
    END IF;
    RAISE NOTICE 'post-state ok: % pipelines with upstream failures, % with our own; head=% tail=% our-own',
      v_up, v_ours, v_first_ours, v_last_ours;
  ELSE
    RAISE NOTICE 'post-state: the 24h window holds only one kind (upstream=%, ours=%) — ordering not exercised',
      v_up, v_ours;
  END IF;
END
$mig$;
