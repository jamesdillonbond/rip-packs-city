-- audit_20260906_client_error_beacon_arm
--
-- Known-issues #34 / go-live bar M7: a CLIENT-ONLY failure was captured by
-- nothing (Sentry dropping every event since 08-18; Vercel sees only server
-- execution). `components/telemetry/ClientErrorBeacon.tsx` (same-day ship) now
-- POSTs `window.onerror` / `unhandledrejection` to /api/telemetry as
-- `usage_events.feature_name = 'client_error'`. A beacon nobody reads is the
-- silent-failure class one level up, so this is its READER: a `client_errors`
-- arm in get_pipeline_alerts_core(), grouped by message over 24 h.
--
--   medium  — one message on >= 5 distinct paths, or >= 25 occurrences
--   high    — >= 15 distinct paths, or >= 100 occurrences
--
-- Cost: usage_events is ~8K rows with idx_usage_events_recent on occurred_at;
-- the arm is a single indexed range scan + one GROUP BY. Guarded splice on the
-- live body (md5 asserted); revert = re-apply the pre-splice body, md5
-- 2d0d20c365ed097401a037802f836ee3 (recoverable from schema_migrations).
--
-- ⚠ A watcher must be PROVEN able to see a failure before it is trusted: the
-- post-flight below inserts a synthetic burst, asserts the arm fires, then
-- deletes it in the same transaction.

DO $splice$
DECLARE v_oid oid; v_def text; v_old text; v_new text; v_n int;
BEGIN
  SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_pipeline_alerts_core';
  IF v_oid IS NULL THEN RAISE EXCEPTION 'get_pipeline_alerts_core missing'; END IF;
  IF md5((SELECT prosrc FROM pg_proc WHERE oid = v_oid)) <> '2d0d20c365ed097401a037802f836ee3' THEN
    RAISE EXCEPTION 'get_pipeline_alerts_core drifted (md5 %)', md5((SELECT prosrc FROM pg_proc WHERE oid = v_oid));
  END IF;
  v_def := pg_get_functiondef(v_oid);

  v_old := E'    FROM public.v_pipeline_failure_rates f\n'
        || E'    WHERE f.pipeline NOT IN (SELECT pipeline FROM active_suppressions)\n'
        || E'  )\n';
  v_new := E'    FROM public.v_pipeline_failure_rates f\n'
        || E'    WHERE f.pipeline NOT IN (SELECT pipeline FROM active_suppressions)\n'
        || E'\n'
        || E'    UNION ALL\n'
        || E'\n'
        || E'    -- CLIENT-ERROR arm (added 2026-09-06, #34): the reader for the window.onerror\n'
        || E'    -- beacon. One row per recurring message over 24 h; nothing else on the\n'
        || E'    -- platform can see a browser-only failure.\n'
        || E'    SELECT jsonb_build_object(\n'
        || E'      ''severity'', CASE WHEN ce.paths >= 15 OR ce.hits >= 100 THEN ''high'' ELSE ''medium'' END,\n'
        || E'      ''type'',     ''client_error_burst'',\n'
        || E'      ''pipeline'', ''client-errors'',\n'
        || E'      ''detail'',   ce.hits || '' client error(s) on '' || ce.paths || '' path(s) in 24h: '' ||\n'
        || E'                  COALESCE(left(ce.message, 140), ''(no message)'') ||\n'
        || E'                  '' — first '' || COALESCE(left(ce.first_path, 60), ''?'') || ''; newest '' || to_char(ce.newest, ''HH24:MI'') || ''Z''\n'
        || E'    )\n'
        || E'    FROM (\n'
        || E'      SELECT metadata->>''message'' AS message,\n'
        || E'             count(*) AS hits,\n'
        || E'             count(DISTINCT metadata->>''path'') AS paths,\n'
        || E'             min(metadata->>''path'') AS first_path,\n'
        || E'             max(occurred_at) AS newest\n'
        || E'      FROM public.usage_events\n'
        || E'      WHERE feature_name = ''client_error''\n'
        || E'        AND occurred_at > now() - interval ''24 hours''\n'
        || E'      GROUP BY 1\n'
        || E'      HAVING count(DISTINCT metadata->>''path'') >= 5 OR count(*) >= 25\n'
        || E'      ORDER BY count(*) DESC\n'
        || E'      LIMIT 5\n'
        || E'    ) ce\n'
        || E'    WHERE ''client-errors'' NOT IN (SELECT pipeline FROM active_suppressions)\n'
        || E'  )\n';
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'anchor count %', v_n; END IF;
  v_def := replace(v_def, v_old, v_new);
  IF position('client_error_burst' IN v_def) = 0 THEN RAISE EXCEPTION 'post-condition: arm missing'; END IF;
  EXECUTE v_def;
END
$splice$;

-- Post-flight: the arm must SEE a burst (positive control) and stay silent on
-- the real table's current contents once the synthetic rows are gone.
DO $verify$
DECLARE v jsonb; v_hits int;
BEGIN
  INSERT INTO public.usage_events (wallet_address, feature_name, occurred_at, metadata)
  SELECT 'anon', 'client_error', now(), jsonb_build_object('message', 'SYNTHETIC-POSTFLIGHT-20260906', 'path', '/synthetic/' || g)
  FROM generate_series(1, 6) g;
  v := coalesce(public.get_pipeline_alerts_core(), '[]'::jsonb);
  SELECT count(*) INTO v_hits FROM jsonb_array_elements(v) a
   WHERE a->>'type' = 'client_error_burst' AND a->>'detail' LIKE '%SYNTHETIC-POSTFLIGHT-20260906%';
  IF v_hits <> 1 THEN RAISE EXCEPTION 'positive control: expected 1 client_error_burst row, got %', v_hits; END IF;
  DELETE FROM public.usage_events WHERE feature_name = 'client_error' AND metadata->>'message' = 'SYNTHETIC-POSTFLIGHT-20260906';
  v := coalesce(public.get_pipeline_alerts_core(), '[]'::jsonb);
  SELECT count(*) INTO v_hits FROM jsonb_array_elements(v) a WHERE a->>'detail' LIKE '%SYNTHETIC-POSTFLIGHT%';
  IF v_hits <> 0 THEN RAISE EXCEPTION 'synthetic rows survived'; END IF;
  RAISE NOTICE 'client_errors arm: positive control fired and cleared';
END
$verify$;
