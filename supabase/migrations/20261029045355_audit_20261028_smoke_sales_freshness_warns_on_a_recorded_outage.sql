-- audit_20261028_smoke_sales_freshness_warns_on_a_recorded_outage
--
-- analytics-smoke (every 30 min, Telegram on any `fail`) began failing 10-28 ~9:30 AM PT,
-- 27 of 44 runs that day, 0 ok in the 6 h to 9:45 PM PT. The one failing check is
-- freshness_sales_per_collection: nfl_all_day's newest sale is 10-27 8:33 AM PT (>24 h).
-- That is TRUE — Dapper's All Day marketplace is still in maintenance — and it is already
-- RECORDED: collection_config.metadata.marketplace.status = 'degraded' with the public
-- notice up (20261029025944, lifts per collection on its own sales, backstop 11-04).
-- A permanently red alarm on a recorded fact teaches the operator to skim (UFC 08-08).
--
-- Change: a collection whose marketplace status is 'degraded' AND whose record was
-- re-verified within 7 days moves from the failing count to a new
-- `stale_count_recorded_outage`, which makes the check WARN (no Telegram; still in the
-- envelope, `recorded_outage` lists the slugs). The 7-day gate is the suppression's own
-- age: a record nobody refreshes stops suppressing and the check fails again. An
-- unrecorded silence on any other collection still FAILS, unchanged.
-- Measured before apply: outage = {nba_top_shot, nfl_all_day, disney_pinnacle};
-- hard stale 0, recorded stale 1 (nfl_all_day) → warn. Positive control: today's runs,
-- where the same All Day row counts as a fail.
--
-- Applied as the 10-09 / 10-19 md5-gated anchor rewrite (function unpinned); three
-- anchors, each asserted to occur exactly once in prosrc.
-- anon-exec: unchanged (analytics_smoke_run) — rewritten via pg_get_functiondef; ACL preserved.
--
-- REVERT: re-apply 20261019153030's analytics_smoke_run section (md5 aafd63ad82ca9164789fac13f0b4a665).

DO $$
DECLARE
  v_oid oid; v_src text; v_def text; v_a text;
  a1 constant text := E'      combined AS (SELECT * FROM freshness UNION ALL SELECT * FROM pinnacle UNION ALL SELECT * FROM panini)\n      SELECT jsonb_build_object(';
  b1 constant text := E'      combined AS (SELECT * FROM freshness UNION ALL SELECT * FROM pinnacle UNION ALL SELECT * FROM panini),\n      -- 2026-10-28: a collection whose marketplace outage is RECORDED (collection_config\n      -- marketplace.status = ''degraded'', re-verified within 7 days; the public notice is up)\n      -- warns instead of failing, so a known Dapper outage stops paging every 30 min. The\n      -- 7-day gate is the suppression''s own age: an unrefreshed record pages again.\n      outage AS (\n        SELECT COALESCE(array_agg(c.slug::text), ''{}''::text[]) AS a\n        FROM collection_config cc JOIN collections c ON c.id = cc.collection_id\n        WHERE cc.metadata #>> ''{marketplace,status}'' = ''degraded''\n          AND (cc.metadata #>> ''{marketplace,last_verified_at}'')::timestamptz > now() - interval ''7 days'')\n      SELECT jsonb_build_object(';
  a2 constant text := E'''stale_count_excl_low_volume'', count(*) FILTER (WHERE minutes_stale > CASE WHEN slug = ''panini_blockchain'' THEN 4320 ELSE 1440 END AND NOT (slug = ANY(v_low_volume_collections)))';
  b2 constant text := E'''stale_count_excl_low_volume'', count(*) FILTER (WHERE minutes_stale > CASE WHEN slug = ''panini_blockchain'' THEN 4320 ELSE 1440 END AND NOT (slug = ANY(v_low_volume_collections)) AND NOT (slug = ANY((SELECT a FROM outage)::text[]))),\n        ''recorded_outage'', to_jsonb((SELECT a FROM outage)::text[]),\n        ''stale_count_recorded_outage'', count(*) FILTER (WHERE minutes_stale > CASE WHEN slug = ''panini_blockchain'' THEN 4320 ELSE 1440 END AND NOT (slug = ANY(v_low_volume_collections)) AND slug = ANY((SELECT a FROM outage)::text[]))';
  a3 constant text := E'''severity'', CASE WHEN (v_detail->>''stale_count_excl_low_volume'')::int > 0 THEN ''fail'' ELSE ''ok'' END,';
  b3 constant text := E'''severity'', CASE WHEN (v_detail->>''stale_count_excl_low_volume'')::int > 0 THEN ''fail'' WHEN (v_detail->>''stale_count_recorded_outage'')::int > 0 THEN ''warn'' ELSE ''ok'' END,';
BEGIN
  SELECT p.oid, p.prosrc INTO v_oid, v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'analytics_smoke_run' AND pg_get_function_identity_arguments(p.oid) = '';
  IF v_oid IS NULL THEN RAISE EXCEPTION 'analytics_smoke_run() not found'; END IF;
  IF md5(v_src) <> 'aafd63ad82ca9164789fac13f0b4a665' THEN
    RAISE EXCEPTION 'analytics_smoke_run changed since read (md5 %)', md5(v_src);
  END IF;
  FOREACH v_a IN ARRAY ARRAY[a1, a2, a3] LOOP
    IF (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a) <> 1 THEN
      RAISE EXCEPTION 'smoke anchor does not occur exactly once: %', left(v_a, 80);
    END IF;
  END LOOP;
  v_def := pg_get_functiondef(v_oid);
  v_def := replace(replace(replace(v_def, a1, b1), a2, b2), a3, b3);
  EXECUTE v_def;
END $$;

DO $$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'analytics_smoke_run';
  IF strpos(v_src, 'stale_count_recorded_outage') = 0 OR strpos(v_src, 'outage AS (') = 0 THEN
    RAISE EXCEPTION 'recorded-outage arm did not land';
  END IF;
  RAISE NOTICE 'analytics_smoke_run md5 %', md5(v_src);
END $$;
