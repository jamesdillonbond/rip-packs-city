-- R115 + R116 (register, 2026-09-19) — the FMV confidence precompute (pg_cron jobid 506,
-- `rpc-refresh-fmv-confidence-precompute`, `35 1,5,9,13` UTC) gets a budget it can finish
-- inside, derives its collection list from the data instead of a five-row literal, and
-- reads Pinnacle from the table Pinnacle is actually priced in.
--
-- Applied from Cowork cloud 2026-09-19 ~5:2x PM PT via the Supabase MCP. ⚠ This blocker note
-- is about THAT session's tooling only: Trevor's machine and Claude Code push normally.
--
-- ── WHAT WAS MEASURED (inbox 2026-09-19T2324Z + T2346Z, re-read live before this) ────────
--   * The last successful run (09-18 22:36 PT) took 118.4 s of a 120 s instance-default
--     `statement_timeout`; the 09-19 02:35 and 06:35 PT runs died at 120.4 s and 124.1 s.
--     Top Shot alone is 100.8 s: `sentinel_fmv_confidence_rows` streams 1,095,052 snapshot
--     rows to answer 14,016 editions (78:1) and the working set (~512 MB of index) does not
--     stay resident on a SMALL tier, so it is IO-bound and no index helps. That ratio grows
--     with every FMV write, so this is a deterministic path to permanent failure.
--   * The role is `postgres`, which carries NO role-level statement_timeout — 120 s is the
--     cluster default. A loose-index-scan rewrite was tried and WITHDRAWN on its own
--     cold-start control (3.2× more buffers cold). Reading `edition_fmv_current` instead is
--     forbidden in writing by that table's own column comment (R107).
--   * The hardcoded five-collection `VALUES` list is wrong both ways: `candy_mlb`
--     (209ade70-…) holds 6,994 snapshots / 125 editions and is ABSENT from the loop, while
--     `disney_pinnacle` is IN the loop with ZERO rows in `fmv_snapshots` — Pinnacle is keyed
--     on `render_id` and priced in `pinnacle_fmv_history`, so its published `counts: {}`
--     (duration 5 ms) has been a structural empty on every run it ever made, and
--     `coalesce(…, '{}')` made that indistinguishable from a real "no data" answer.
--   * Readers, established before writing this: the ONLY consumer of
--     `fmv_confidence_precompute` is `rpc_ops_snapshot()` (repo grep + pg_proc/pg_views).
--     No user-facing surface reads it. Blast radius is the ops instrument.
--
-- ── WHAT THIS DOES ───────────────────────────────────────────────────────────────────────
--   1. BUDGET. jobid 506 keeps its jobid, schedule and owner; its command gains the
--      house `SET statement_timeout = '300s';` prefix that `rpc-ccm-step2` (jobid 4) already
--      uses. ⚠ Deliberately NOT moved to `cron_heavy`: that role has no EXECUTE on either
--      function (inbox 2324Z §6 — a move without a GRANT fails as pure silence), and the
--      prefix pattern is proven on this estate. ⚠ Deliberately 300 s and not 600 s: a run
--      that stretches under an IO spell squats one of 6 worker slots for the whole budget;
--      300 s is 2.5× the healthy duration and matches the jobid-4 precedent.
--      ⛔ This is a ceiling raise, not the structural fix. The structural fix (a
--      per-collection watermark so Top Shot is not recomputed from all history every 4 h)
--      stays OPEN on R115; watch `duration_ms` for `nba_top_shot`, not the function total.
--   2. COVERAGE. The loop is `collections` ⋈ EXISTS(fmv_snapshots), so Candy appears now and
--      any future collection appears when its first snapshot lands. Pinnacle gets its own
--      arm reading `pinnacle_fmv_history` (latest `fmv_confidence` per `render_id`;
--      measured 2026-09-19: 2,550 renders, ~258k buffers, ~3.3 s).
--   3. HONESTY. `coalesce(…, '{}')` is gone. An arm whose source table has rows but whose
--      aggregate matched nothing writes `counts = NULL` plus a `note` saying so; `{}` is
--      never written. `rpc_ops_snapshot()` now derives `fmv_by_collection` and its
--      `_computed_at` sibling from the precompute table (no second hardcoded list to drift)
--      and adds `fmv_by_collection_note` so a null is interpretable in the payload itself.
--      Semantics, stated once: KEY ABSENT = no priced source for that collection at the
--      last refresh; NULL = the arm ran and matched nothing (read the note); an object =
--      a measured distribution.
--   4. OBSERVABILITY. The function now writes a `pipeline_runs` row (`fmv-confidence-
--      precompute`, ok = no failed arms) so the sentinel's pipeline arms can see it —
--      before this, a killed run was visible ONLY in cron.job_run_details (the R110 class).
--
-- ── FALSIFIER (from inbox 2346Z, unchanged) ──────────────────────────────────────────────
--   After the first scheduled run the table holds SIX rows; Candy's HIGH+MEDIUM reads ~62%
--   and Pinnacle's ~28%, both within a couple of points of `metrics-latest.json` (60.8 /
--   27.5 on 09-19) — the independent control that was already right. The run completes
--   under 300 s on its own cron tick (cron.job_run_details status = succeeded).
--
-- ── REVERT ───────────────────────────────────────────────────────────────────────────────
--   * Function bodies: re-apply `20260914215000` (the #121 originals of
--     refresh_fmv_confidence_precompute) and `20260919121040` (rpc_ops_snapshot with the
--     hardcoded lists). Drop the one additive column:
--       ALTER TABLE public.fmv_confidence_precompute DROP COLUMN note;
--   * Cron: SELECT cron.schedule('rpc-refresh-fmv-confidence-precompute','35 1,5,9,13 * * *',
--       'SELECT public.refresh_fmv_confidence_precompute();');   -- same name → same jobid 506
--   * Data: DELETE FROM public.fmv_confidence_precompute WHERE slug = 'candy_mlb';
--     (Pinnacle's row goes back to `{}` on the next run of the reverted body.)
--
-- anon-exec: intentional — unchanged: anon/authenticated EXECUTE were already FALSE on both
-- functions and same-signature CREATE OR REPLACE preserves ACLs; re-asserted with a REVOKE
-- below anyway (refresh_fmv_confidence_precompute, rpc_ops_snapshot)

ALTER TABLE public.fmv_confidence_precompute
  ADD COLUMN IF NOT EXISTS note text;

COMMENT ON COLUMN public.fmv_confidence_precompute.note IS
  'Set ONLY when counts is NULL: why the arm produced no distribution (2026-09-19, R116). A row with counts = NULL and a note is "the arm ran and matched nothing"; the arm never writes {}.';

COMMENT ON TABLE public.fmv_confidence_precompute IS
  'Per-collection latest-snapshot FMV confidence distribution, refreshed by refresh_fmv_confidence_precompute() on pg_cron jobid 506 (35 1,5,9,13 UTC, 300 s budget since 2026-09-19). Rows are DERIVED from the data: one per collection with fmv_snapshots rows, plus disney_pinnacle from pinnacle_fmv_history (render_id-keyed). Only reader: rpc_ops_snapshot(). NOT a user-facing source. R115 (cost) is still open: nba_top_shot alone is ~100 s because DISTINCT ON streams every snapshot ever written (78:1 and growing) — watch its duration_ms, not the function total.';

CREATE OR REPLACE FUNCTION public.refresh_fmv_confidence_precompute()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r         record;
  v_counts  jsonb;
  v_note    text;
  v_start   timestamptz;
  v_run_at  timestamptz := clock_timestamp();
  v_ms      integer;
  v_ok      integer := 0;
  v_failed  jsonb   := '[]'::jsonb;
  v_pinn    constant uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
BEGIN
  -- ⭐ Derived, not curated (R116). Every collection that has at least one row in
  -- fmv_snapshots, plus Pinnacle from its own table. A future collection appears the
  -- moment its first snapshot lands; nothing here needs editing for it.
  FOR r IN
    SELECT c.slug, c.id AS cid, 'fmv_snapshots'::text AS src
      FROM public.collections c
     WHERE EXISTS (SELECT 1 FROM public.fmv_snapshots fs WHERE fs.collection_id = c.id)
    UNION ALL
    SELECT c.slug, c.id, 'pinnacle_fmv_history'
      FROM public.collections c
     WHERE c.id = v_pinn
       AND EXISTS (SELECT 1 FROM public.pinnacle_fmv_history)
     ORDER BY 1
  LOOP
    BEGIN
      v_start := clock_timestamp();
      v_note  := NULL;

      IF r.src = 'pinnacle_fmv_history' THEN
        -- Pinnacle is keyed on render_id, not edition_id, and has ZERO rows in
        -- fmv_snapshots — reading it there published a permanent `{}` (R116).
        SELECT jsonb_object_agg(d.conf, d.n)
          INTO v_counts
          FROM (
            SELECT x.conf::text AS conf, count(*)::bigint AS n
              FROM (
                SELECT DISTINCT ON (h.render_id) h.fmv_confidence AS conf
                  FROM public.pinnacle_fmv_history h
                 ORDER BY h.render_id, h.computed_at DESC
              ) x
             GROUP BY x.conf
          ) d;
      ELSE
        SELECT jsonb_object_agg(s.confidence, s.count)
          INTO v_counts
          FROM public.sentinel_fmv_confidence_rows(r.cid) s;
      END IF;

      -- ⚠ No coalesce to '{}'. A NULL aggregate here means the source has rows (the
      -- loop proved it) but the arm's query matched none — say so rather than publish
      -- a well-formed empty object that reads as "measured: nothing".
      IF v_counts IS NULL THEN
        v_note := format('arm ran %s but matched no rows in %s', to_char(v_start AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI"Z"'), r.src);
      END IF;

      v_ms := (EXTRACT(EPOCH FROM (clock_timestamp() - v_start)) * 1000)::integer;

      INSERT INTO public.fmv_confidence_precompute AS f
             (collection_id, slug, counts, computed_at, duration_ms, note)
      VALUES (r.cid, r.slug, v_counts, clock_timestamp(), v_ms, v_note)
      ON CONFLICT (collection_id) DO UPDATE
        SET slug        = EXCLUDED.slug,
            counts      = EXCLUDED.counts,
            computed_at = EXCLUDED.computed_at,
            duration_ms = EXCLUDED.duration_ms,
            note        = EXCLUDED.note;

      v_ok := v_ok + 1;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed || jsonb_build_object('slug', r.slug, 'error', SQLERRM);
    END;
  END LOOP;

  -- R110 class: until 2026-09-19 a killed run of this lane was visible only in
  -- cron.job_run_details. One terminal row per run, ok iff no arm failed.
  BEGIN
    PERFORM public.log_pipeline_run(
      'fmv-confidence-precompute',
      jsonb_array_length(v_failed) = 0,
      jsonb_build_object('refreshed', v_ok, 'failed', v_failed,
                         'duration_ms', (EXTRACT(EPOCH FROM (clock_timestamp() - v_run_at)) * 1000)::integer)
    );
  EXCEPTION WHEN OTHERS THEN
    -- The record must never be the thing that fails the refresh.
    NULL;
  END;

  RETURN jsonb_build_object('refreshed', v_ok, 'failed', v_failed, 'at', clock_timestamp());
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.refresh_fmv_confidence_precompute() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.refresh_fmv_confidence_precompute() IS
  'Refreshes fmv_confidence_precompute for every collection that has fmv_snapshots rows, plus Pinnacle from pinnacle_fmv_history. Runs on pg_cron jobid 506 under a SET statement_timeout = 300s prefix (2026-09-19, R115). Writes a pipeline_runs row (fmv-confidence-precompute). Per-arm EXCEPTION handler: a failed arm lands in the returned `failed` array and keeps its OLD row, so computed_at ages visibly.';

-- ── rpc_ops_snapshot(): the fmv_by_collection legs derive from the precompute table ──────
-- Everything else in this body is VERBATIM from 20260919121040 (read back from
-- pg_get_functiondef before editing). Only the two `fmv_by_collection*` legs change and one
-- `fmv_by_collection_note` sibling is added.
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
    -- 2026-09-19 (R116): DERIVED from the precompute table, which is itself derived from
    -- the data -- there is no second hardcoded collection list to drift. Reading:
    --   KEY ABSENT  = no priced source for that collection at the last refresh
    --   null        = the arm ran and matched nothing (fmv_by_collection_note says why)
    --   an object   = a measured distribution
    -- `{}` is never emitted.
    'fmv_by_collection', (
      SELECT jsonb_object_agg(p.slug, p.counts)
      FROM public.fmv_confidence_precompute p
    ),
    -- The provenance of the key above. A reader that prints the split without
    -- reading this cannot tell a fresh number from a week-old one.
    'fmv_by_collection_computed_at', (
      SELECT jsonb_object_agg(p.slug, p.computed_at)
      FROM public.fmv_confidence_precompute p
    ),
    -- Only the slugs whose counts is NULL appear here, each with its reason.
    'fmv_by_collection_note', (
      SELECT coalesce(jsonb_object_agg(p.slug, p.note), '{}'::jsonb)
      FROM public.fmv_confidence_precompute p
      WHERE p.note IS NOT NULL
    )
  );
$function$;

REVOKE EXECUTE ON FUNCTION public.rpc_ops_snapshot() FROM PUBLIC, anon, authenticated;

-- ── jobid 506 keeps its identity; its command gains the house budget prefix ─────────────
-- Same jobname + same owner (postgres) => cron.schedule updates IN PLACE, jobid 506 kept.
-- Verified the shape on jobid 4 (`rpc-ccm-step2`), which has carried exactly this prefix.
SELECT cron.schedule(
  'rpc-refresh-fmv-confidence-precompute',
  '35 1,5,9,13 * * *',
  $cmd$SET statement_timeout = '300s'; SELECT public.refresh_fmv_confidence_precompute();$cmd$
);

DO $$
DECLARE v_id int; v_cmd text;
BEGIN
  SELECT jobid, command INTO v_id, v_cmd FROM cron.job WHERE jobname = 'rpc-refresh-fmv-confidence-precompute';
  IF v_id IS DISTINCT FROM 506 THEN
    RAISE EXCEPTION 'jobid changed: expected 506, got %', v_id;
  END IF;
  IF strpos(v_cmd, $p$SET statement_timeout = '300s'$p$) = 0 THEN
    RAISE EXCEPTION 'budget prefix not on jobid 506: %', v_cmd;
  END IF;
  IF has_function_privilege('anon', 'public.refresh_fmv_confidence_precompute()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.rpc_ops_snapshot()', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon EXECUTE leaked';
  END IF;
END $$;
