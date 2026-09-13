-- audit_20260913_the_sentinel_names_the_maintenance_load_under_a_saturation_spell
--
-- ── WHY (2026-09-13) ─────────────────────────────────────────────────────────
-- Today's saturation spell had a cause no sentinel arm could name: the first-ever
-- autovacuum of pg_toast_51873 (net._http_response's 12.4 GB TOAST, register #75)
-- ran from ~10:37 PT for hours in IO/DataFileRead, and the digest said "268 cron
-- failures", "Trust Health INCONCLUSIVE", "Atlas tick 24 of 27 failed" — every
-- symptom, never the cause. A session found it by reading pg_stat_progress_vacuum
-- by hand, and the Atlas tick's failures matched the vacuum's start to the minute.
-- Before that read, the lane was about to be blamed for the spell.
--
-- This arm puts the maintenance work in the same digest as the symptoms: every
-- vacuum (manual or autovacuum), CLUSTER / VACUUM FULL and CREATE INDEX in
-- progress, with phase, progress and running time. It reads only the
-- pg_stat_progress_* views and pg_stat_activity — catalog-backed, no relation
-- is touched — so it costs nothing to run while the instance is on its knees,
-- which is exactly when it is read.
--
-- Reader: lib/sentinel/maintenance-load.ts. Threshold: 'Maintenance Load' warn_at
-- = minutes a single maintenance operation may run before the arm warns (30).
-- Never critical: a long autovacuum is a fact to know and to wait out, not a page.
--
-- anon-exec: revoked — the sentinel reads it as service_role; nothing else may call it (check_maintenance_load)

CREATE OR REPLACE FUNCTION public.check_maintenance_load()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jsonb_build_object(
    'vacuums', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'relation',           p.relid::regclass::text,
        -- a TOAST relation is named after its OWNER so the line reads
        -- "pg_toast_51873 (net._http_response)" rather than an oid
        'parent',             (SELECT c2.oid::regclass::text FROM pg_class c2 WHERE c2.reltoastrelid = p.relid),
        'phase',              p.phase,
        'heap_blks_total',    p.heap_blks_total,
        'heap_blks_scanned',  p.heap_blks_scanned,
        'heap_blks_vacuumed', p.heap_blks_vacuumed,
        'index_vacuum_count', p.index_vacuum_count,
        'is_autovacuum',      a.backend_type = 'autovacuum worker',
        'wait_event_type',    a.wait_event_type,
        'running_seconds',    extract(epoch from (now() - a.query_start))::bigint
      )) FROM pg_stat_progress_vacuum p JOIN pg_stat_activity a USING (pid)), '[]'::jsonb),
    'clusters', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'relation',          p.relid::regclass::text,
        'command',           p.command,
        'phase',             p.phase,
        'heap_blks_total',   p.heap_blks_total,
        'heap_blks_scanned', p.heap_blks_scanned,
        'running_seconds',   extract(epoch from (now() - a.query_start))::bigint
      )) FROM pg_stat_progress_cluster p JOIN pg_stat_activity a USING (pid)), '[]'::jsonb),
    'index_builds', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'relation',        p.relid::regclass::text,
        'phase',           p.phase,
        'blocks_total',    p.blocks_total,
        'blocks_done',     p.blocks_done,
        'running_seconds', extract(epoch from (now() - a.query_start))::bigint
      )) FROM pg_stat_progress_create_index p JOIN pg_stat_activity a USING (pid)), '[]'::jsonb),
    'autovacuum_workers',     (SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'autovacuum worker'),
    'autovacuum_max_workers', current_setting('autovacuum_max_workers', true)::int,
    'io_waiters',             (SELECT count(*) FROM pg_stat_activity
                               WHERE state = 'active' AND wait_event_type = 'IO' AND backend_type = 'client backend'),
    'measured_at',            now()
  );
$function$;

COMMENT ON FUNCTION public.check_maintenance_load() IS
  'Sentinel "Maintenance Load" arm: every VACUUM / autovacuum, CLUSTER / VACUUM FULL and CREATE INDEX in progress with phase, block progress and running seconds, plus autovacuum worker occupancy and the client IO-waiter count. Catalog views only, no relation touched. Reader: lib/sentinel/maintenance-load.ts. Added 2026-09-13 after the pg_net TOAST first-ever autovacuum ran a multi-hour saturation spell that no arm could name (register #75).';

REVOKE EXECUTE ON FUNCTION public.check_maintenance_load() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_maintenance_load() TO postgres, service_role;

INSERT INTO public.sentinel_threshold_config (check_name, warn_at, crit_at, enabled, note)
VALUES ('Maintenance Load', 30, NULL, true,
  'warn_at = MINUTES a single vacuum / cluster / index build may have been running before the arm warns (default 30). Below it the arm is ok and still NAMES every operation in progress, so the digest carries the cause next to the symptoms. Never critical. Seeded 2026-09-13 after the pg_net TOAST autovacuum spell (register #75).')
ON CONFLICT (check_name) DO NOTHING;
