-- audit_20260909_client_error_arm_stops_counting_bot_traffic_as_user_facing
--
-- Known-issues #69. The `client_error_burst` arm (added 2026-09-06) counts EVERY
-- `usage_events.feature_name = 'client_error'` row, with no UA predicate, and
-- fires at `paths >= 5 OR count(*) >= 25` in 24 h. That is not the claim it is
-- meant to make: it is supposed to say "readers are hitting a browser-only
-- failure", and as written it says "some client sent us 25 error rows".
--
-- ⭐ WHY NOW, and it is a measurement not a hypothetical: the beacon's first real
-- catch was 17 rows of `SyntaxError: failed to parse` on /nba-top-shot/collection
-- which were filed as a user-facing defect (#69, since RETRACTED). Grouping by
-- `metadata->>'ua'` returns ONE value for all 17 — `Lightpanda/1.0`, a headless
-- automation client. A single crawler produced 17 of the 25 needed to raise a
-- medium alert on traffic containing no human at all.
--
-- THE PREDICATE, and why it is shaped this way:
--   automation := ua IS NOT NULL AND ua NOT LIKE 'Mozilla/%'
-- Every mainstream consumer browser sends a `Mozilla/5.0`-prefixed UA, so this
-- tests a STRUCTURAL property rather than naming known bots. ⚠ A guard that NAMES
-- its instances dies on a rename — three have in this repo — so there is
-- deliberately no bot list here to maintain.
--
-- ⚠ POLARITY IS DELIBERATE AND IS THE LOAD-BEARING CHOICE: a MISSING `ua` counts
-- as HUMAN. Unknown is not automation, and the alternative fails SILENT — if a
-- future beacon change stopped sending `ua`, treating unknown as bot would
-- switch this alarm off with every gate green. It also keeps the 2026-09-06
-- post-flight (which inserts rows carrying no `ua`) a valid positive control.
--
-- ⚠ WHAT THIS IS STRUCTURALLY SILENT ABOUT, stated rather than discovered later:
-- a crawler that SPOOFS a `Mozilla/5.0` UA is still counted as human. This raises
-- the floor on honest automation; it is not a bot filter and must not be
-- described as one.
--
-- ⛔ Excluded rows are NOT dropped from the report — the detail gains
-- "(+N from non-browser UAs, excluded)" so an operator can still see them. An
-- exclusion that hides its own population is the failure mode this repo keeps
-- paying for.
--
-- Guarded splice on the live body (md5 fe8da947ab196d5ea4c02ad1d9acccf5 asserted).
-- REVERT: re-apply migration 20260906185324's body, or splice the two anchors
-- back (the pre-splice text is the `v_old` of each splice below, verbatim).

DO $splice$
DECLARE v_oid oid; v_def text; v_old text; v_new text; v_n int;
BEGIN
  SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_pipeline_alerts_core';
  IF v_oid IS NULL THEN RAISE EXCEPTION 'get_pipeline_alerts_core missing'; END IF;
  IF md5((SELECT prosrc FROM pg_proc WHERE oid = v_oid)) <> 'fe8da947ab196d5ea4c02ad1d9acccf5' THEN
    RAISE EXCEPTION 'get_pipeline_alerts_core drifted (md5 %)', md5((SELECT prosrc FROM pg_proc WHERE oid = v_oid));
  END IF;
  v_def := pg_get_functiondef(v_oid);

  -- SPLICE 1 of 2: count only rows that are not POSITIVELY identified as non-browser.
  v_old := $frag$      SELECT metadata->>'message' AS message,
             count(*) AS hits,
             count(DISTINCT metadata->>'path') AS paths,
             min(metadata->>'path') AS first_path,
             max(occurred_at) AS newest
      FROM public.usage_events
      WHERE feature_name = 'client_error'
        AND occurred_at > now() - interval '24 hours'
      GROUP BY 1
      HAVING count(DISTINCT metadata->>'path') >= 5 OR count(*) >= 25
      ORDER BY count(*) DESC
      LIMIT 5
$frag$;
  v_new := $frag$      SELECT metadata->>'message' AS message,
             count(*) FILTER (WHERE NOT ((metadata->>'ua') IS NOT NULL AND (metadata->>'ua') NOT LIKE 'Mozilla/%')) AS hits,
             count(DISTINCT metadata->>'path') FILTER (WHERE NOT ((metadata->>'ua') IS NOT NULL AND (metadata->>'ua') NOT LIKE 'Mozilla/%')) AS paths,
             count(*) FILTER (WHERE ((metadata->>'ua') IS NOT NULL AND (metadata->>'ua') NOT LIKE 'Mozilla/%')) AS bot_hits,
             min(metadata->>'path') FILTER (WHERE NOT ((metadata->>'ua') IS NOT NULL AND (metadata->>'ua') NOT LIKE 'Mozilla/%')) AS first_path,
             max(occurred_at) FILTER (WHERE NOT ((metadata->>'ua') IS NOT NULL AND (metadata->>'ua') NOT LIKE 'Mozilla/%')) AS newest
      FROM public.usage_events
      WHERE feature_name = 'client_error'
        AND occurred_at > now() - interval '24 hours'
      GROUP BY 1
      HAVING count(DISTINCT metadata->>'path') FILTER (WHERE NOT ((metadata->>'ua') IS NOT NULL AND (metadata->>'ua') NOT LIKE 'Mozilla/%')) >= 5
          OR count(*) FILTER (WHERE NOT ((metadata->>'ua') IS NOT NULL AND (metadata->>'ua') NOT LIKE 'Mozilla/%')) >= 25
      ORDER BY count(*) FILTER (WHERE NOT ((metadata->>'ua') IS NOT NULL AND (metadata->>'ua') NOT LIKE 'Mozilla/%')) DESC
      LIMIT 5
$frag$;
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'splice 1 anchor count %', v_n; END IF;
  v_def := replace(v_def, v_old, v_new);

  -- SPLICE 2 of 2: surface the excluded automation rows in the detail. Excluding
  -- them from the THRESHOLD without SHOWING them would make the arm quietly
  -- lossy, which is the failure this repo keeps paying for.
  v_old := $frag$                  ' — first ' || COALESCE(left(ce.first_path, 60), '?') || '; newest ' || to_char(ce.newest, 'HH24:MI') || 'Z'
$frag$;
  v_new := $frag$                  ' — first ' || COALESCE(left(ce.first_path, 60), '?') || '; newest ' || to_char(ce.newest, 'HH24:MI') || 'Z' ||
                  CASE WHEN ce.bot_hits > 0 THEN ' (+' || ce.bot_hits || ' from non-browser UAs, excluded)' ELSE '' END
$frag$;
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'splice 2 anchor count %', v_n; END IF;
  v_def := replace(v_def, v_old, v_new);

  IF position('NOT LIKE ''Mozilla/%''' IN v_def) = 0 THEN RAISE EXCEPTION 'post-condition: predicate missing'; END IF;
  IF position('bot_hits' IN v_def) = 0 THEN RAISE EXCEPTION 'post-condition: bot_hits missing'; END IF;
  EXECUTE v_def;
END
$splice$;

-- Post-flight: CONTROLS IN BOTH DIRECTIONS. A one-sided control here would be
-- worthless — "it no longer fires" is equally consistent with a correct fix and
-- with an arm that can never fire again.
DO $verify$
DECLARE v jsonb; v_hits int; v_detail text;
BEGIN
  -- (1) POSITIVE: a browser-UA burst must still raise the alarm.
  INSERT INTO public.usage_events (wallet_address, feature_name, occurred_at, metadata)
  SELECT 'anon', 'client_error', now(),
         jsonb_build_object('message', 'SYNTHETIC-HUMAN-20260909', 'path', '/synthetic-h/' || g,
                            'ua', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36')
  FROM generate_series(1, 6) g;
  v := coalesce(public.get_pipeline_alerts_core(), '[]'::jsonb);
  SELECT count(*) INTO v_hits FROM jsonb_array_elements(v) a
   WHERE a->>'type' = 'client_error_burst' AND a->>'detail' LIKE '%SYNTHETIC-HUMAN-20260909%';
  IF v_hits <> 1 THEN RAISE EXCEPTION 'positive control: browser burst did not fire (got %)', v_hits; END IF;

  -- (2) NEGATIVE: the SAME burst from a non-browser UA must NOT raise it. This is
  --     the control that proves the fix rather than a broken arm.
  DELETE FROM public.usage_events WHERE feature_name = 'client_error' AND metadata->>'message' = 'SYNTHETIC-HUMAN-20260909';
  INSERT INTO public.usage_events (wallet_address, feature_name, occurred_at, metadata)
  SELECT 'anon', 'client_error', now(),
         jsonb_build_object('message', 'SYNTHETIC-BOT-20260909', 'path', '/synthetic-b/' || g, 'ua', 'Lightpanda/1.0')
  FROM generate_series(1, 30) g;
  v := coalesce(public.get_pipeline_alerts_core(), '[]'::jsonb);
  SELECT count(*) INTO v_hits FROM jsonb_array_elements(v) a
   WHERE a->>'type' = 'client_error_burst' AND a->>'detail' LIKE '%SYNTHETIC-BOT-20260909%';
  IF v_hits <> 0 THEN RAISE EXCEPTION 'negative control: bot-only burst STILL fires (got %)', v_hits; END IF;

  -- (3) MISSING ua must still count as human (the fail-loud polarity above).
  DELETE FROM public.usage_events WHERE feature_name = 'client_error' AND metadata->>'message' = 'SYNTHETIC-BOT-20260909';
  INSERT INTO public.usage_events (wallet_address, feature_name, occurred_at, metadata)
  SELECT 'anon', 'client_error', now(), jsonb_build_object('message', 'SYNTHETIC-NOUA-20260909', 'path', '/synthetic-n/' || g)
  FROM generate_series(1, 6) g;
  v := coalesce(public.get_pipeline_alerts_core(), '[]'::jsonb);
  SELECT count(*) INTO v_hits FROM jsonb_array_elements(v) a
   WHERE a->>'type' = 'client_error_burst' AND a->>'detail' LIKE '%SYNTHETIC-NOUA-20260909%';
  IF v_hits <> 1 THEN RAISE EXCEPTION 'polarity control: missing-ua burst must still fire (got %)', v_hits; END IF;

  -- (4) The excluded population must remain VISIBLE in the detail.
  INSERT INTO public.usage_events (wallet_address, feature_name, occurred_at, metadata)
  SELECT 'anon', 'client_error', now(), jsonb_build_object('message', 'SYNTHETIC-NOUA-20260909', 'path', '/synthetic-n/bot', 'ua', 'Lightpanda/1.0')
  FROM generate_series(1, 3) g;
  v := coalesce(public.get_pipeline_alerts_core(), '[]'::jsonb);
  SELECT a->>'detail' INTO v_detail FROM jsonb_array_elements(v) a
   WHERE a->>'type' = 'client_error_burst' AND a->>'detail' LIKE '%SYNTHETIC-NOUA-20260909%';
  IF v_detail IS NULL OR v_detail NOT LIKE '%non-browser UAs, excluded%' THEN
    RAISE EXCEPTION 'visibility control: excluded rows are not reported (detail: %)', coalesce(v_detail, '(none)');
  END IF;

  DELETE FROM public.usage_events WHERE feature_name = 'client_error' AND metadata->>'message' LIKE 'SYNTHETIC-%-20260909';
  SELECT count(*) INTO v_hits FROM public.usage_events WHERE feature_name = 'client_error' AND metadata->>'message' LIKE 'SYNTHETIC-%-20260909';
  IF v_hits <> 0 THEN RAISE EXCEPTION 'synthetic rows survived'; END IF;
  RAISE NOTICE 'client_errors arm: positive, negative, polarity and visibility controls all held';
END
$verify$;
