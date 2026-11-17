-- audit_20261009_smoke_fmv_freshness_is_stale_only_when_a_sale_outran_the_fmv
--
-- analytics_smoke_run()'s `freshness_fmv_per_collection` check read WARN on every scheduled run of
-- 10-09 (three in a row sampled at 12:13, 12:43 and 1:13 PM PT), always for the same reason:
-- ufc_strike's newest fmv_snapshots row was 4,048 min old against a 1,800 min threshold. UFC is a
-- FROZEN market — its last sale is 2026-05-13 — and its snapshots are rewritten only by the 7-day
-- cold-tail/historical rule (snapshot days in the 30 d before this: 09-14..16, 09-21..23, 09-26,
-- 09-28..30, 10-03..07), so the check goes yellow several days of every week with nothing to price.
-- A permanently-yellow check cannot tell that from a dead FMV writer. v_rpc_trust_health already
-- retired its UFC freshness arm for the same reason (08-08, repointed to the revival detector).
--
-- The property the check exists for is "the market moved and the FMV did not follow". So a
-- collection now reads stale only when its latest FMV is past threshold AND a sale landed after
-- that FMV (or it has no FMV at all). Over threshold with no newer sale is reported, not hidden, as
-- `quiet_markets` in the detail; it does not change severity. Pinnacle keeps the plain age test
-- (its recalc is scheduled, not sale-driven). Cost of the new EXISTS: 17 buffers over the 5
-- non-Pinnacle collections (index-only on sales_<year>_collection_id_sold_at_idx).
-- ⚠ A dead FMV writer on a LIVE market still trips it: sales keep landing after the last FMV.
--
-- Applied as an md5-gated server-side rewrite of the live body (the 20260920143546 pattern; the
-- function is unpinned). Four anchors, each asserted to occur exactly once.
--
-- REVERT: the same four replacements in reverse, gated on the post-change md5 (e83d23aa71beed901b104fffaa581057, read 10-09 after apply).

DO $$
DECLARE
  v_oid oid;
  v_src text;
  v_def text;
  a1 constant text := E'        SELECT c.slug, EXTRACT(EPOCH FROM now() - lf.computed_at) / 60 AS minutes_stale\n        FROM collections c';
  b1 constant text := E'        SELECT c.slug, EXTRACT(EPOCH FROM now() - lf.computed_at) / 60 AS minutes_stale,\n               -- 2026-10-09: stale needs a sale NEWER than the FMV (a frozen market is quiet, not stale)\n               (lf.computed_at IS NULL OR EXISTS (SELECT 1 FROM sales s WHERE s.collection_id = c.id AND s.sold_at > lf.computed_at)) AS has_newer_sale\n        FROM collections c';
  a2 constant text := E'SELECT ''disney_pinnacle'' AS slug, EXTRACT(EPOCH FROM now() - max(fmv_computed_at)) / 60 AS minutes_stale\n        FROM pinnacle_catalog)';
  b2 constant text := E'SELECT ''disney_pinnacle'' AS slug, EXTRACT(EPOCH FROM now() - max(fmv_computed_at)) / 60 AS minutes_stale,\n               true AS has_newer_sale\n        FROM pinnacle_catalog)';
  a3 constant text := E'               (cb.minutes_stale > COALESCE(th.threshold_min, 360)) AS is_stale';
  b3 constant text := E'               (cb.minutes_stale > COALESCE(th.threshold_min, 360) AND cb.has_newer_sale) AS is_stale,\n               (cb.minutes_stale > COALESCE(th.threshold_min, 360) AND NOT cb.has_newer_sale) AS is_quiet';
  a4 constant text := E'        ''stale_count'', count(*) FILTER (WHERE is_stale)\n      ) INTO v_detail FROM scored;';
  b4 constant text := E'        ''quiet_markets'', COALESCE(jsonb_agg(slug ORDER BY slug) FILTER (WHERE is_quiet), ''[]''::jsonb),\n        ''stale_count'', count(*) FILTER (WHERE is_stale)\n      ) INTO v_detail FROM scored;';
  v_a text;
BEGIN
  SELECT p.oid, p.prosrc INTO v_oid, v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'analytics_smoke_run' AND pg_get_function_identity_arguments(p.oid) = '';
  IF v_oid IS NULL THEN RAISE EXCEPTION 'analytics_smoke_run() not found'; END IF;
  IF md5(v_src) <> '6a6f777ae7580e408d5a644bcc34e508' THEN
    RAISE EXCEPTION 'analytics_smoke_run body changed since it was read (md5 %) — re-read before rewriting', md5(v_src);
  END IF;
  FOREACH v_a IN ARRAY ARRAY[a1, a2, a3, a4] LOOP
    IF (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a) <> 1 THEN
      RAISE EXCEPTION 'anchor does not occur exactly once: %', left(v_a, 80);
    END IF;
  END LOOP;
  v_def := pg_get_functiondef(v_oid);
  v_def := replace(replace(replace(replace(v_def, a1, b1), a2, b2), a3, b3), a4, b4);
  EXECUTE v_def;
END $$;

DO $$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'analytics_smoke_run';
  IF strpos(v_src, 'AS has_newer_sale') = 0 OR strpos(v_src, 'AND cb.has_newer_sale) AS is_stale') = 0
     OR strpos(v_src, '''quiet_markets''') = 0 OR strpos(v_src, 'true AS has_newer_sale') = 0 THEN
    RAISE EXCEPTION 'analytics_smoke_run rewrite did not land';
  END IF;
  RAISE NOTICE 'analytics_smoke_run new md5 %', md5(v_src);
END $$;
