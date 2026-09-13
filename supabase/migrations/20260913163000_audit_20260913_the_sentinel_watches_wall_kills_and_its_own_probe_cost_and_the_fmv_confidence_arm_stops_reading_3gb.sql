-- audit_20260913: the sentinel gains two arms it had no way to have, and loses
-- the heaviest probe on the instance.
--
-- Companion to 20260913155500 (the Edition Coverage rewrite). Same lesson,
-- applied systematically this time: EVERY ops RPC the sentinel calls was read
-- from pg_stat_statements before anything else was touched.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- (1) sentinel_fmv_confidence_canonical_ts_split() — 467,237 buffers PER SWEEP.
--
-- The headline accuracy metric (BASE HIGH+MED share) was computed by 14,015
-- LATERAL `ORDER BY computed_at DESC LIMIT 1` probes into fmv_snapshots — one
-- random index descent + heap fetch per canonical Top Shot edition, on the
-- instance's #1 read hotspot. pg_stat_statements since 2026-08-12:
--   calls 232 · mean 6,316 ms · max 28,978 ms · 467,237 blocks/call (~3.6 GB)
-- The Edition Coverage arm fixed this morning was 71,783; this one was 6.5x it.
--
-- Rewritten to read edition_fmv_current.confidence (the materialised latest
-- snapshot per edition, hourly incremental refresh — see 20260823173502).
-- MEASURED after: HashAggregate over a hash join, 4,845 buffers, 261 ms.
--
-- EQUIVALENCE, three ways, live 2026-09-13 09:0x PT:
--   • totals: base 9,539 and parallel 4,476 — IDENTICAL to the 07:36 PT sweep's
--     "HIGH 1509 of 9539 | 4476 editions" from the old function;
--   • a RANDOM sample of 358 canonical TS editions (abs(hashtext(external_id))
--     % 40 = 0 — a hash sample, not physical order), cached confidence vs the
--     live latest snapshot: 0 of 234 base and 0 of 124 parallel differ;
--   • shares: BASE HIGH+MED 65.9% now vs 65.6% at 07:36 (HIGH 1,505 vs 1,509),
--     PARALLEL 24.7% vs 26.3% — the parallel drift over 1.7 h is REAL movement
--     (ask corroboration ageing flips MED→LOW; the register already records
--     this figure as "a RANGE swinging on SWEEP POSITION"), not cache lag: the
--     sample says the cache matches live for 100% of rows.
-- ⚠ What changes in meaning: the figure is AS OF the last hourly refresh (a
-- confidence that flipped in the last hour reads its previous value until the
-- next refresh). The route's detail says so. Threshold semantics unchanged.
--
-- REVERT: re-apply the prior body:
--   WITH ed AS MATERIALIZED (SELECT id, external_id FROM public.editions
--     WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
--       AND external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$')
--   SELECT CASE WHEN ed.external_id LIKE '%::%' THEN 'parallel' ELSE 'base' END,
--          fc.confidence::text, count(*)::bigint
--   FROM ed JOIN LATERAL (SELECT s.confidence FROM public.fmv_snapshots s
--     WHERE s.edition_id = ed.id ORDER BY s.computed_at DESC LIMIT 1) fc ON true
--   GROUP BY 1, 2;
--
-- anon-exec: unchanged — SNAPSHOT of an existing SECDEF function whose ACL already excludes anon/authenticated (verified after apply); a REVOKE here would be a no-op pretending to be a decision (sentinel_fmv_confidence_canonical_ts_split)
CREATE OR REPLACE FUNCTION public.sentinel_fmv_confidence_canonical_ts_split()
 RETURNS TABLE(printing text, confidence text, count bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT
    CASE WHEN e.external_id LIKE '%::%' THEN 'parallel' ELSE 'base' END AS printing,
    c.confidence::text                                                   AS confidence,
    count(*)::bigint                                                     AS count
  FROM public.editions e
  -- INNER join on purpose: the old LATERAL was an inner join too (an edition with
  -- no snapshot had no row). edition_fmv_current has one row per edition that
  -- has ever had a snapshot, so the population is the same set.
  JOIN public.edition_fmv_current c ON c.edition_id = e.id
  WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
    AND e.external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'
  GROUP BY 1, 2;
$function$;

COMMENT ON FUNCTION public.sentinel_fmv_confidence_canonical_ts_split() IS
  'Sentinel "FMV Confidence (canonical TS)" arm: latest-snapshot confidence per canonical Top Shot edition (integer-pair external_id), split base vs parallel. Reads edition_fmv_current (hourly incremental refresh) since 2026-09-13; the LATERAL walk of fmv_snapshots it replaced cost 467,237 buffers and 6.3 s mean per sweep (232 calls) and is the reason the sentinel was a load on the table it measures. Random sample of 358 editions: 0 differ from live. The figure is AS OF the last refresh.';

-- ─────────────────────────────────────────────────────────────────────────────
-- (2) check_wall_kills(window, grace) — the maxDuration kill, as an arm.
--
-- A platform kill at a route's wall writes NO terminal pipeline_runs row, so it
-- is invisible to Pipeline Silence (the marker keeps last_run fresh), to the
-- failure-rate view (no ok=false row), to Zero-Yield (no row at all) and to
-- pipeline_runs_daily (a missing tick reads as 100% ok). The only instrument is
-- the heartbeat-vs-terminal correlation in lib/pipeline/kill-rate.ts, which ran
-- only when an operator ran `npm run pipelines:kills`. Live 24 h at apply time:
--   fmv-recalc 31 kills / 150 · panini-ingest 26 / 789 · wallet-backfill 24 / 735
--   · drain-fmv-cold-tail 11 / 46 · wmc-fmv-populate 4 / 142 — none paged.
--
-- Rules mirror the module (see lib/sentinel/wall-kills.ts for the argument):
--   marker = `-heartbeat` row, or a `-dispatch` row whose `-complete` sibling
--   exists in the window; matched = a terminal row within ±5 s; grace excludes
--   invocations still running; a pipeline with NO matched marker in the window
--   is `unverified`, never 100%-killed (dead-lane-backstop writes a GHA-side
--   marker and by design no terminal row).
--
-- COST, measured (this is a probe, and 20260913155500 is why that matters):
--   raw CTE materialised so the correlation EXISTS runs ONCE, not once per
--   FILTER clause (the unmaterialised form ran it three times: 80,233 buffers);
--   materialised: 33,414 buffers / ~4,700 markers, index-only on
--   pipeline_runs_pipeline_started_idx with heap fetches. Under the probe-cost
--   arm's 50,000 line, stated in its threshold note.
--
-- REVERT: DROP FUNCTION public.check_wall_kills(interval, interval);
CREATE OR REPLACE FUNCTION public.check_wall_kills(p_window interval DEFAULT '24 hours', p_grace interval DEFAULT '10 minutes')
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH raw AS MATERIALIZED (
    SELECT pipeline, started_at
    FROM public.pipeline_runs
    WHERE started_at > now() - p_window
      AND started_at < now() - p_grace
      AND (pipeline LIKE '%-heartbeat' OR pipeline LIKE '%-dispatch')
  ), markers AS (
    SELECT left(pipeline, length(pipeline) - 10) AS base,
           left(pipeline, length(pipeline) - 10) AS terminal,
           started_at
    FROM raw WHERE pipeline LIKE '%-heartbeat'
    UNION ALL
    -- A `-dispatch` name is a marker ONLY when its `-complete` sibling exists
    -- (alerts-dispatch is a real pipeline). Derived from the data, never a list.
    SELECT left(pipeline, length(pipeline) - 9),
           left(pipeline, length(pipeline) - 9) || '-complete',
           started_at
    FROM raw r WHERE pipeline LIKE '%-dispatch'
      AND EXISTS (SELECT 1 FROM public.pipeline_runs c
                  WHERE c.pipeline = left(r.pipeline, length(r.pipeline) - 9) || '-complete'
                    AND c.started_at > now() - p_window)
  ), scored AS MATERIALIZED (
    SELECT m.base, m.started_at,
           EXISTS (SELECT 1 FROM public.pipeline_runs t
                   WHERE t.pipeline = m.terminal
                     AND t.started_at BETWEEN m.started_at - interval '5 seconds'
                                          AND m.started_at + interval '5 seconds') AS matched
    FROM markers m
  ), per AS (
    SELECT base,
           count(*)                                   AS heartbeats,
           count(*) FILTER (WHERE matched)            AS matched,
           count(*) FILTER (WHERE NOT matched)        AS kills,
           max(started_at) FILTER (WHERE NOT matched) AS last_kill_at
    FROM scored GROUP BY base
  )
  SELECT jsonb_build_object(
    'window', jsonb_build_object(
       'hours', round((extract(epoch FROM p_window) / 3600)::numeric, 1),
       'grace_minutes', round((extract(epoch FROM p_grace) / 60)::numeric, 1),
       'correlation_seconds', 5),
    'inspected', (SELECT count(*) FROM per),
    'verified',  (SELECT count(*) FROM per WHERE matched > 0),
    'unverified', COALESCE((SELECT jsonb_agg(jsonb_build_object('pipeline', base, 'heartbeats', heartbeats) ORDER BY heartbeats DESC, base)
                            FROM per WHERE matched = 0), '[]'::jsonb),
    'offenders', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                              'pipeline', base, 'heartbeats', heartbeats, 'kills', kills,
                              'kill_pct', round(100.0 * kills / heartbeats, 1), 'last_kill_at', last_kill_at)
                            ORDER BY kills DESC, base)
                           FROM per WHERE matched > 0 AND kills > 0), '[]'::jsonb)
  );
$function$;

COMMENT ON FUNCTION public.check_wall_kills(interval, interval) IS
  'Sentinel "Wall Kills (24h)" arm: heartbeat/dispatch markers with no terminal row within ±5 s (a maxDuration kill), per pipeline, over p_window excluding the last p_grace. Pipelines with zero matched markers are reported as unverified, not as killed. ~33k buffers per call (materialised 24 h marker walk). Reader: lib/sentinel/wall-kills.ts.';

REVOKE EXECUTE ON FUNCTION public.check_wall_kills(interval, interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_wall_kills(interval, interval) TO postgres, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- (3) sentinel_probe_cost() — the sentinel reads its own weight.
--
-- For every ops RPC invoked through PostgREST as service_role whose name starts
-- sentinel_ / check_ / detect_ / dune_spend_report / get_pipeline_alerts:
-- calls, mean and max ms, buffers per call, total seconds — since the last
-- pg_stat_statements reset (returned as `since`, because the stats POOL and a
-- rewritten probe carries its old mean until its queryid is reset).
--
-- pg_stat_statements lives in the `extensions` schema on this instance and is
-- readable by postgres (pg_read_all_stats); SECURITY DEFINER owned by postgres
-- is what lets the service_role caller read it. Cost: one scan of the
-- pg_stat_statements view (in-memory; ~5,000 entries), no table reads.
--
-- REVERT: DROP FUNCTION public.sentinel_probe_cost();
CREATE OR REPLACE FUNCTION public.sentinel_probe_cost()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH r AS (
    SELECT substring(s.query FROM '"public"\."([a-z_0-9]+)"')                              AS fn,
           s.calls,
           round(s.mean_exec_time::numeric)                                                  AS mean_ms,
           round(s.max_exec_time::numeric)                                                   AS max_ms,
           round((s.shared_blks_hit + s.shared_blks_read)::numeric / greatest(s.calls, 1))   AS blks_per_call,
           round((s.total_exec_time / 1000)::numeric)                                        AS total_s
    FROM extensions.pg_stat_statements s
    WHERE s.userid = 'service_role'::regrole
      AND s.query LIKE 'WITH pgrst_source AS (SELECT "pgrst_call".% FROM "public"."%'
      AND substring(s.query FROM '"public"\."([a-z_0-9]+)"') ~ '^(sentinel_|check_|detect_|dune_spend_report|get_pipeline_alerts)'
  )
  SELECT jsonb_build_object(
    'since', (SELECT stats_reset FROM extensions.pg_stat_statements_info),
    'rows',  COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.blks_per_call DESC) FROM r), '[]'::jsonb)
  );
$function$;

COMMENT ON FUNCTION public.sentinel_probe_cost() IS
  'Sentinel "Ops Probe Cost" arm: per ops RPC (sentinel_*/check_*/detect_*/dune_spend_report/get_pipeline_alerts*, invoked via PostgREST as service_role) calls, mean/max ms, buffers per call and total seconds from pg_stat_statements since its last reset. Reader: lib/sentinel/probe-cost.ts. Reset a rewritten probe''s queryid (pg_stat_statements_reset(0,0,queryid)) or this reports its pooled pre-fix cost.';

REVOKE EXECUTE ON FUNCTION public.sentinel_probe_cost() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sentinel_probe_cost() TO postgres, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- (4) Threshold rows, so both arms are tunable and ackable without a deploy.
INSERT INTO public.sentinel_threshold_config (check_name, warn_at, crit_at, enabled, note)
VALUES
  ('Wall Kills (24h)', 3, NULL, true,
   'warn when a heartbeated pipeline has >= warn_at markers with no terminal row within ±5 s in 24 h (a maxDuration kill). Never critical: a pooled 24 h count cannot tell "broken now" from "fixed, corpse still in the window" — read last_kill_at. 3 = one clipped tail is noise, two a coincidence, three in a day a pattern. Seeded 2026-09-13.'),
  ('Ops Probe Cost', 50000, NULL, true,
   'warn when any ops RPC (sentinel_*/check_*/detect_*/dune_spend_report/get_pipeline_alerts*) reads >= warn_at buffers per call in pg_stat_statements (secondary: mean >= 5,000 ms, hardcoded). Anchored 2026-09-13: the two offenders found read 71,783 and 467,237; check_public_security_invariants 26,191 (data-integrity cron); check_wall_kills ~33,000 by construction; all else < 10,000. Rewrite the probe, do not raise this.')
ON CONFLICT (check_name) DO NOTHING;
