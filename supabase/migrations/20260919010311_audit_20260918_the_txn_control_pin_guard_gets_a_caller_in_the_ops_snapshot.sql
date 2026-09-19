-- audit 2026-09-18 — give `check_procedure_transaction_control_pin_drift()` a CALLER.
--
-- WHY: the guard shipped earlier tonight (20260919003619 + its comment-stripping
-- correction 20260919003741) and NOTHING read it. A guard with no reader is not a
-- guard; it is a function. Its creating migration said so in as many words and
-- deferred this wiring on a stated reason — a full-body `CREATE OR REPLACE` of a
-- large shared function while a concurrent session was pushing to `main`. That
-- window has closed, so the deferral is discharged here.
--
-- WHAT THE GUARD IS FOR: a routine carrying an attached `SET` clause runs inside an
-- implicit transaction block and may not `COMMIT`/`ROLLBACK` — it dies with
-- `2D000 invalid transaction termination`. Pinning `search_path` on a procedure that
-- COMMITs therefore BREAKS it, and that mistake has now been made THREE times on this
-- database (2026-08-22/23, filed WONTFIX "do NOT re-attempt"; 2026-09-13/14; and
-- 2026-09-18, self-reverted by 20260919002535). Twice it was made by a session that
-- had READ the warning. A comment is only read by someone already in that file, so
-- the class gets an instrument instead.
--
-- ⚠ THE BODY BELOW IS THE LIVE OBJECT, re-read immediately before writing this
-- migration (`pg_get_functiondef`, md5 d9a1ba3481400bd32b4b90722dc26895, 5558 chars),
-- per the repo rule that `CREATE OR REPLACE` is a FULL-BODY WRITE. The ONLY change is
-- the one added key. Every other line is verbatim, including the 2026-09-02 `upstream`
-- bucket that `ops-snapshot-upstream-signature-matches-breaker-guard` pins.
--
-- ⚠ BAN-AT-ZERO, and it returns a jsonb ARRAY like its three neighbours: clean is
-- `jsonb_array_length() = 0`, NEVER `count(*) = 1`.
--
-- NON-VACUITY, measured just now, not assumed: `public` holds 3 procedures and the
-- guard returns `[]` over them. A guard that reads clean at a population of zero is
-- indistinguishable from a broken one, so the population is stated.
--
-- anon-exec: NOT intentional for rpc_ops_snapshot — this is a REPLACE of an existing
-- function and `CREATE OR REPLACE` does not reset privileges. Verified live before
-- writing: anon=false, authenticated=false, cron_heavy=false, service_role=true,
-- postgres=true. No grant is added or removed here, so there is no pg_cron caller to
-- orphan.
--
-- REVERT: re-apply the previous definition (drop the single
-- `'procedure_txn_control_pins'` line); the guard function itself is untouched.

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

-- ── VERIFIED AT APPLY TIME, not asserted ──────────────────────────────────────
-- 1. FIDELITY. The body above, with ONLY the four added comment lines and the one
--    added key removed, hashes to md5 d9a1ba3481400bd32b4b90722dc26895 at 5558
--    chars — byte-identical to the live `pg_get_functiondef` read immediately
--    before this was written, and re-read immediately before it was applied. That
--    is a proof, not an eyeball: a REPLACE drafted off a stale dump silently
--    reverts whatever another session shipped in between.
-- 2. IT EXECUTES. `rpc_ops_snapshot()` returns 16 keys (was 15); the new one is a
--    jsonb array of length 0.
-- 3. POSITIVE CONTROL — the WIRE, not just the guard. Inside one DO block: create a
--    scratch procedure that COMMITs AND carries `SET search_path`, read the snapshot,
--    then RAISE so the whole block rolls back. The snapshot surfaced the offender with
--    its full detail. Residue after: 0 procedures named `zz_txn_pin_positive_control_tmp`.
--    The guard's own creating migration proved the GUARD; this proves the snapshot
--    does not swallow a non-empty reading.
-- 4. NON-VACUITY. `public` holds 3 procedures before and after. A ban-at-zero that
--    reads clean over an empty population is indistinguishable from a broken one.
