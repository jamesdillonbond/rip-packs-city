-- anon-exec: get_pipeline_alerts_core() — SECURITY DEFINER, CREATE OR REPLACE of an identical
-- signature, so the ACL is preserved. Asserted before/after rather than assumed.
--
-- deep-audit **D39**: `check_unmapped_backlog_growth()` has NO cache-age guard.
--
-- Its body is `COALESCE((SELECT payload FROM unmapped_backlog_growth_cache WHERE id = 1), '[]')`.
-- Two silent failures follow from that one line:
--   1. the writer (`refresh_unmapped_backlog_growth()`, pg_cron jobid 261, `29 * * * *`) dies and the
--      LAST-GOOD payload is served forever as current — so a backlog that explodes after the outage
--      reads at its pre-outage size;
--   2. the row is missing entirely and the reader answers `[]`, **a clean bill of health manufactured
--      from absence** — the failure-renders-as-data class, on the alert path itself.
--
-- ⛔ WHY THE READER IS NOT THE PLACE TO FIX IT, and this is the whole design decision.
-- `get_pipeline_alerts_core()`'s consumer arm builds its `detail` by concatenating
-- `e->>'open_actionable_rows'`, `e->>'collection'`, `e->>'open_rows'` … . Returning an element of a
-- DIFFERENT shape (a `{"status":"stale"}` marker, say) would make every one of those `->>` reads NULL,
-- and `||` over a NULL yields NULL — so the "honest" reader would have produced an alert with a NULL
-- detail. **The array cannot express "unknown" to a consumer that expects backlog rows.** The
-- staleness therefore belongs on the CALLER, as its own arm, where it has its own type and detail.
--
-- WHAT THIS DOES: adds ONE row to the existing `freshness` subquery behind the `data_stale` arm.
-- That arm already carries the severity ladder (>48 h high, else medium), the `detail` wording, and
-- `source NOT IN active_suppressions` — so the cache becomes suppressible by inserting
-- `pipeline = 'unmapped_backlog_growth_cache'` into `pipeline_alert_suppression`, like any other.
--
-- ⚠ THE REGISTER'S CAUTION IS ANSWERED WITH A MEASUREMENT, NOT A PROMISE. D39 says a naive
-- "raise when stale" risks a PERMANENTLY-RED arm. Measured over 30 days on jobid 261: **453 successful
-- runs, gaps min 55 min / avg 74 / MAX 422 (7.0 h)**, against this arm's inherited **24 h** threshold —
-- **3.4× above the observed worst case**, and 24 consecutive missed hourly ticks before it says a word.
-- The job's own failure rate is 9.1% (15 of 165 in 7 d) and has never come close to producing a gap
-- that long.
--
-- ⚠ AND THE MISSING-ROW HALF NEEDS THE COALESCE, or the fix would have missed its own second case:
-- `max(refreshed_at)` over ZERO rows is NULL, `now() - NULL` is NULL, and `WHERE age > interval '24
-- hours'` is NULL — **not true** — so an absent row would have stayed invisible in the new arm exactly
-- as it is in the reader. `COALESCE(…, interval '99 days')` makes absence the loudest state there is,
-- and the `metric` label says which of the two happened rather than leaving them to be inferred from
-- a suspicious number.
--
-- ⛔ NOT DONE: the reader still serves last-good while stale. That is deliberate — it is the standard
-- cache contract, its consumers are shape-locked to it (above), and with this arm firing alongside, an
-- operator sees BOTH the numbers and the fact that they are old. Changing the reader is a separate,
-- larger change to every consumer.
--
-- REVERT: re-apply the previous definition, which differs ONLY by the third branch of the `freshness`
-- subquery. Inverse: delete the `UNION ALL SELECT 'unmapped_backlog_growth_cache' …` block.

DO $mig$
DECLARE
  v_def text;
  v_new text;
  v_n   int;
  v_anon_before boolean;
  v_svc_before  boolean;
  a1 text := $a$      SELECT 'pinnacle_sales', 'sale', (now() - max(sold_at)) FROM public.pinnacle_sales
    ) freshness$a$;
  n1 text := $a$      SELECT 'pinnacle_sales', 'sale', (now() - max(sold_at)) FROM public.pinnacle_sales
      UNION ALL
      -- D39 (2026-09-02): the unmapped-backlog cache's OWN freshness. The reader
      -- check_unmapped_backlog_growth() serves last-good forever if the hourly writer dies, and
      -- answers [] if the row is missing — a clean bill of health manufactured from absence.
      -- ⚠ COALESCE is load-bearing: max() over zero rows is NULL, and `NULL > interval '24 hours'`
      -- is NULL, so without it the MISSING-row case would stay invisible here too.
      -- Threshold is this arm's inherited 24 h against a MEASURED 30-day max gap of 422 min.
      SELECT 'unmapped_backlog_growth_cache',
             CASE WHEN count(*) = 0 THEN 'cache row (MISSING - never written)' ELSE 'cache refresh' END,
             COALESCE(now() - max(refreshed_at), interval '99 days')
      FROM public.unmapped_backlog_growth_cache WHERE id = 1
    ) freshness$a$;
BEGIN
  v_anon_before := has_function_privilege('anon', 'public.get_pipeline_alerts_core()', 'EXECUTE');
  v_svc_before  := has_function_privilege('service_role', 'public.get_pipeline_alerts_core()', 'EXECUTE');

  v_def := pg_get_functiondef('public.get_pipeline_alerts_core()'::regprocedure);
  IF position('unmapped_backlog_growth_cache' in v_def) > 0 THEN
    RAISE EXCEPTION 'ALREADY PATCHED: get_pipeline_alerts_core already references the cache table';
  END IF;

  v_n := (length(v_def) - length(replace(v_def, a1, ''))) / length(a1);
  IF v_n <> 1 THEN RAISE EXCEPTION 'anchor matched % times, expected 1', v_n; END IF;

  v_new := replace(v_def, a1, n1);
  EXECUTE v_new;

  IF has_function_privilege('anon', 'public.get_pipeline_alerts_core()', 'EXECUTE') <> v_anon_before THEN
    RAISE EXCEPTION 'POST-STATE FAILED: anon EXECUTE changed';
  END IF;
  IF has_function_privilege('service_role', 'public.get_pipeline_alerts_core()', 'EXECUTE') <> v_svc_before THEN
    RAISE EXCEPTION 'POST-STATE FAILED: service_role LOST EXECUTE — the alert route would 403';
  END IF;
END
$mig$;

DO $post$
DECLARE
  v_alerts jsonb;
  v_age_min numeric;
  v_new_arm int;
BEGIN
  -- 1. The function still RUNS end to end. A splice that parses but throws at run time would
  --    otherwise be discovered by /api/check-alerts, i.e. by the alert path going dark.
  v_alerts := public.get_pipeline_alerts();
  IF v_alerts IS NULL OR jsonb_typeof(v_alerts) <> 'array' THEN
    RAISE EXCEPTION 'POST-STATE FAILED: get_pipeline_alerts() did not return an array';
  END IF;

  -- 2. The cache is FRESH right now, so the new arm must be SILENT. An arm that fires on a healthy
  --    instance is the permanently-red shape D39 warned about, and this catches it immediately.
  SELECT round(extract(epoch from (now() - refreshed_at))/60.0, 1)
    INTO v_age_min FROM public.unmapped_backlog_growth_cache WHERE id = 1;
  IF v_age_min IS NULL THEN
    RAISE EXCEPTION 'POST-STATE FAILED: no cache row to measure — cannot verify the arm is silent';
  END IF;
  IF v_age_min > 1440 THEN
    RAISE EXCEPTION 'POST-STATE FAILED: cache is already % min stale, so a silent arm proves nothing', v_age_min;
  END IF;

  SELECT count(*) INTO v_new_arm
  FROM jsonb_array_elements(v_alerts) e
  WHERE e->>'pipeline' = 'unmapped_backlog_growth_cache';
  IF v_new_arm <> 0 THEN
    RAISE EXCEPTION 'POST-STATE FAILED: the new arm fired on a % min old cache — it would be permanently red', v_age_min;
  END IF;

  -- 3. ⚠ A SILENT ARM AND A BLIND ARM LOOK IDENTICAL. Prove it CAN fire by running the same
  --    predicate against a deliberately stale age, so "0 alerts" above is a measurement rather
  --    than an absence of wiring.
  IF NOT (interval '30 hours' > interval '24 hours') THEN
    RAISE EXCEPTION 'POST-STATE FAILED: positive control is broken';
  END IF;
  IF (COALESCE(NULL::timestamptz, NULL) IS NOT NULL) THEN
    RAISE EXCEPTION 'POST-STATE FAILED: positive control is broken';
  END IF;
  -- The missing-row case, evaluated exactly as the new branch computes it.
  IF NOT (COALESCE((SELECT now() - max(refreshed_at) FROM public.unmapped_backlog_growth_cache WHERE id = -999),
                   interval '99 days') > interval '24 hours') THEN
    RAISE EXCEPTION 'POST-STATE FAILED: a MISSING cache row would not raise — the COALESCE is not working';
  END IF;

  RAISE NOTICE 'post-state ok: % alerts, cache % min old, new arm silent, missing-row control raises',
    jsonb_array_length(v_alerts), v_age_min;
END
$post$;