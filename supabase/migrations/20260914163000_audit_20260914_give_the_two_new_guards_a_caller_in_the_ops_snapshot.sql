-- ─────────────────────────────────────────────────────────────────────────────
-- Two guards shipped today have no caller. This gives them one.
--
-- ⭐ THE OBJECTION IS NOT MINE AND IT IS CORRECT. The concurrent Cowork filing
-- `inbox/2026-09-14T1514Z-…` landed on `check_suppression_parked_claim_drift()`
-- within the hour and said the right thing about it: *"The instrument for this
-- class is built; what it needs is a CALLER, not a rewrite."* CLAUDE.md states
-- the same rule from the other side — *"Ask what RUNS a guard, not only whether
-- it passes."* A guard nothing calls is a comment that happens to compile.
--
-- ADDS TWO KEYS to rpc_ops_snapshot(), which the daytime monitor and the night
-- pass already read for exactly this purpose:
--   • suppression_parked_claim_drift — a suppression whose headline claims its
--     cursor is parked at/below block N while the cursor sits ABOVE N, or a
--     PERMANENT terminal-state grant on a cursor that moved inside 24 h.
--   • backward_cursor_rewinds — a cursor observed walking DOWN that jumped UP,
--     i.e. discarded walk progress nothing re-walks.
-- Both return a jsonb ARRAY, so clean is `jsonb_array_length() = 0` and NOT
-- `count(*) = 1` — the `check_*` return shapes on this database are mixed.
--
-- ⛔ NOT wired into get_pipeline_alerts(): neither finding is worth paging for,
-- and a new arm on a 16.7 kB alert function is a much larger blast radius than
-- the thing it would report. The snapshot is a READER, which is the right tier.
--
-- ⚠ FULL-BODY WRITE. `CREATE OR REPLACE FUNCTION` replaces the whole body, so
-- this body was re-read from the LIVE object (`pg_get_functiondef`) minutes
-- before it was written, not reconstructed from an older migration — a draft off
-- a stale dump silently reverts whatever another session shipped in between.
-- Re-checked immediately before apply: live length 4257, unchanged.
--
-- ⚠ THE UPSTREAM-SIGNATURE FILTER IN pipeline_fails_24h IS LOAD-BEARING AND IS
-- COPIED VERBATIM (the pattern is deliberately NOT quoted in this header: the
-- guard below does not strip comments, and two matches is a failure, not a coin
-- flip).
-- `__tests__/ops-snapshot-upstream-signature-matches-breaker-guard.test.ts`
-- resolves the NEWEST migration defining this function and compares that regex
-- against `CLOUDFLARE_ORIGIN_DOWN` in `lib/pipeline/upstream-breaker.ts`. This
-- file is now that newest migration, so dropping or reformatting the pattern
-- reds CI here rather than silently re-burying real failures under one upstream
-- outage.
--
-- REVERT: re-apply 20260902035928_audit_20260902_ops_snapshot_fails_24h_separates_upstream_outages_from_our_own_failures.sql
-- (this body minus the two keys added below).
-- ─────────────────────────────────────────────────────────────────────────────

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

-- anon-exec: unchanged for rpc_ops_snapshot — this is a REPLACE of an existing function, and CREATE OR REPLACE does not reset an ACL, so a revoke here would CHANGE production while pretending to be a wiring-only edit.
-- (The marker must name the function on the SAME LINE as the anon-exec: token — the guard is per line, and a three-line version of this note failed it.)

-- ── verification, same transaction ───────────────────────────────────────────
DO $verify$
DECLARE
  v jsonb;
BEGIN
  v := public.rpc_ops_snapshot();
  IF NOT (v ? 'suppression_parked_claim_drift') OR NOT (v ? 'backward_cursor_rewinds') THEN
    RAISE EXCEPTION 'the two new keys are not in the snapshot';
  END IF;
  -- The keys the snapshot already carried must survive a full-body replace.
  IF NOT (v ? 'security' AND v ? 'pipeline_alerts' AND v ? 'pipeline_fails_24h'
          AND v ? 'trust_health' AND v ? 'fmv_by_collection' AND v ? 'stalled_pipelines'
          AND v ? 'editions_by_collection' AND v ? 'sentinel_ts_uuid_editions_48h'
          AND v ? 'trust_health_breaches' AND v ? 'db_size_mb' AND v ? 'generated_at') THEN
    RAISE EXCEPTION 'a pre-existing snapshot key was dropped by the replace: %', (SELECT jsonb_agg(k) FROM jsonb_object_keys(v) k);
  END IF;
  IF jsonb_array_length(v->'suppression_parked_claim_drift') <> 0
     OR jsonb_array_length(v->'backward_cursor_rewinds') <> 0 THEN
    RAISE EXCEPTION 'a new guard is not clean through the snapshot: %', v::text;
  END IF;
END
$verify$;
