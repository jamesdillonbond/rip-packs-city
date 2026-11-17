-- audit_20260906_get_collection_stats_reads_edition_fmv_current_46s_to_sub_second
--
-- The collection Overview tab (the landing tab of every collection) reads
-- /api/collection-stats, which is get_collection_stats(p_slug) behind an 8 s
-- boundedRead and a 5-minute CDN cache. Measured 2026-09-06, real Chromium,
-- signed out: /nba-top-shot/overview and /ufc/overview rendered "Couldn't load
-- collection stats right now" + "Couldn't load this right now" (Top 5 sniper
-- deals) because the route answered 503 — the RPC took 8.6 s on the first
-- request, 6.0 s on the second, 0.3 s only once the CDN had it. On the DB:
--
--     explain (analyze, buffers) select get_collection_stats('nba_top_shot');
--     Buffers: shared hit=264,008 read=28,261 · Execution Time: 46,601 ms
--
-- Three of its reads walk fmv_snapshots with a per-edition ORDER BY computed_at
-- DESC LIMIT 1 lateral — the DISTINCT-ON-per-row shape this repo has already
-- retired from the boards (ledger 2026-09-03, `edition_fmv_current`). This
-- migration points those three reads at `edition_fmv_current`, the maintained
-- latest-per-edition table, which is the same population at the same grain:
--
--     collection       old (live API)                  new (edition_fmv_current)
--     nba_top_shot     16,916 / 82.1% · 7,633 / 37.0%  16,915 / 82.1% · 7,625 / 37.0%
--     nfl_all_day       5,312 / 85.8% · 1,486 / 24.0%   5,311 / 85.8% · 1,486 / 24.0%
--     laliga_golazos      502 / 87.3% ·     2 /  0.3%     502 / 87.3% ·     2 /  0.3%
--     ufc_strike          381 / 73.6% ·     0 /  0.0%     381 / 73.6% ·     0 /  0.0%
--   (the ±1–8 rows are FMV moving between the two readings, minutes apart)
--
-- The coverage read alone: 292,269 → 5,906 buffers, 46.6 s → 0.10 s.
-- Guarded splice: md5 of the live body asserted, each anchor exactly once,
-- post-conditions asserted, pg_get_functiondef preserves SECURITY/SET clauses.
--
-- Revert: the pre-splice body is in supabase_migrations.schema_migrations for
-- 20260813* (`get_collection_stats` D13b) / recoverable by md5
-- aea159ad08918b358348e092c24657ef; nothing else changes.

DO $splice$
DECLARE
  v_oid oid;
  v_def text;
  v_old text;
  v_new text;
  v_n int;
BEGIN
  SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_collection_stats';
  IF v_oid IS NULL THEN RAISE EXCEPTION 'get_collection_stats missing'; END IF;
  IF md5((SELECT prosrc FROM pg_proc WHERE oid = v_oid)) <> 'aea159ad08918b358348e092c24657ef' THEN
    RAISE EXCEPTION 'get_collection_stats body drifted (md5 %)', md5((SELECT prosrc FROM pg_proc WHERE oid = v_oid));
  END IF;
  v_def := pg_get_functiondef(v_oid);

  -- (1) FMV coverage: per-edition lateral → edition_fmv_current join
  v_old := E'    FROM editions e\n'
        || E'    CROSS JOIN LATERAL (\n'
        || E'      SELECT fs.confidence\n'
        || E'      FROM fmv_snapshots fs\n'
        || E'      WHERE fs.collection_id = v_collection_id AND fs.edition_id = e.id\n'
        || E'      ORDER BY fs.computed_at DESC\n'
        || E'      LIMIT 1\n'
        || E'    ) latest\n'
        || E'    WHERE e.collection_id = v_collection_id;\n';
  v_new := E'    FROM editions e\n'
        || E'    -- 2026-09-06: latest-per-edition is maintained in edition_fmv_current;\n'
        || E'    -- the lateral over fmv_snapshots cost 292K buffers / 46 s per call.\n'
        || E'    JOIN edition_fmv_current latest\n'
        || E'      ON latest.edition_id = e.id AND latest.collection_id = e.collection_id\n'
        || E'    WHERE e.collection_id = v_collection_id;\n';
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'anchor 1 count % (expected 1)', v_n; END IF;
  v_def := replace(v_def, v_old, v_new);

  -- (2) Top Shot sniper deals: lateral → edition_fmv_current
  v_old := E'      JOIN LATERAL (\n'
        || E'        SELECT fmv_usd, confidence FROM fmv_snapshots\n'
        || E'        WHERE edition_id = e.id AND fmv_usd > 0 AND computed_at <= now()\n'
        || E'        ORDER BY computed_at DESC\n'
        || E'        LIMIT 1\n'
        || E'      ) latest_fmv ON true\n';
  v_new := E'      JOIN edition_fmv_current latest_fmv\n'
        || E'        ON latest_fmv.edition_id = e.id AND latest_fmv.fmv_usd > 0 AND latest_fmv.computed_at <= now()\n';
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'anchor 2 count % (expected 1)', v_n; END IF;
  v_def := replace(v_def, v_old, v_new);

  -- (3) All Day sniper deals: lateral → edition_fmv_current
  v_old := E'      JOIN LATERAL (\n'
        || E'        SELECT fmv_usd, confidence FROM fmv_snapshots\n'
        || E'        WHERE edition_id = e.id AND fmv_usd > 0 AND computed_at <= now()\n'
        || E'        ORDER BY computed_at DESC\n'
        || E'        LIMIT 1\n'
        || E'      ) f ON true\n';
  v_new := E'      JOIN edition_fmv_current f\n'
        || E'        ON f.edition_id = e.id AND f.fmv_usd > 0 AND f.computed_at <= now()\n';
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'anchor 3 count % (expected 1)', v_n; END IF;
  v_def := replace(v_def, v_old, v_new);

  IF position('CROSS JOIN LATERAL' IN v_def) > 0 THEN RAISE EXCEPTION 'post-condition: a lateral over fmv_snapshots survived'; END IF;
  IF (length(v_def) - length(replace(v_def, 'edition_fmv_current', ''))) / length('edition_fmv_current') <> 4 THEN
    RAISE EXCEPTION 'post-condition: expected 4 edition_fmv_current references';
  END IF;
  EXECUTE v_def;
END
$splice$;

-- Post-flight: the function must answer every published collection inside the
-- route's 8 s budget from a cold-ish cache, and coverage must agree with the
-- direct read. RAISE (roll back) if it does not.
DO $verify$
DECLARE
  v_t0 timestamptz; v_ms numeric; v_out jsonb; v_direct int; v_slug text;
BEGIN
  FOREACH v_slug IN ARRAY ARRAY['nba_top_shot','nfl_all_day','laliga_golazos','ufc_strike','disney_pinnacle'] LOOP
    v_t0 := clock_timestamp();
    v_out := public.get_collection_stats(v_slug);
    v_ms := extract(epoch from (clock_timestamp() - v_t0)) * 1000;
    RAISE NOTICE '% → % ms, fmv_pct %, hm %, sniper %', v_slug, round(v_ms), v_out->>'fmv_pct', v_out->>'fmv_high_medium_count', jsonb_array_length(coalesce(v_out->'sniper_deals','[]'::jsonb));
    IF v_ms > 8000 THEN RAISE EXCEPTION '% still takes % ms', v_slug, round(v_ms); END IF;
    IF v_slug <> 'disney_pinnacle' THEN
      SELECT count(*) INTO v_direct FROM editions e JOIN edition_fmv_current f ON f.edition_id = e.id AND f.collection_id = e.collection_id
       JOIN collections c ON c.id = e.collection_id WHERE c.slug = v_slug AND f.confidence <> 'NO_DATA';
      IF abs((v_out->>'fmv_covered')::int - v_direct) > 50 THEN
        RAISE EXCEPTION '% coverage disagrees: function % vs direct %', v_slug, v_out->>'fmv_covered', v_direct;
      END IF;
    END IF;
  END LOOP;
END
$verify$;
