-- audit_20261110_panini_squeeze_mv_aggregates_only_its_own_editions
--
-- Claude Code cloud, 2026-11-10 ~1:00 PM PT (applied 1:01 PM PT, DB clock).
--
-- WHY: mv_panini_squeeze (behind /insights/panini-squeeze, refreshed hourly at :18 by refresh_panini_squeeze(),
-- REFRESH ... CONCURRENTLY) built its serial_agg CTE over EVERY row of panini_card_serials (5.2M rows, 10 GB, all
-- 112 products) although the view keeps only the ~5.3k World Cup editions (panini_wc_editions, mint_cap NOT NULL).
-- Refreshes took 137-223 s (148,248 ms at 12:18 PM PT). The aggregate alone, unrestricted, ran > 60 s; restricted to
-- the view's own editions it is 64.5k buffers / 4.0 s, and the whole new query 84k buffers / 0.59 s.
-- After this migration, the production function's refresh: 558 ms (1:01:46 PM PT), 5,304 rows.
--
-- EQUIVALENCE: the restriction is a filter on the aggregate's own GROUP BY key, and the outer query LEFT JOINs the
-- aggregate on exactly those keys, so no surviving row can change. Checked against the retired view (last refreshed
-- 12:18 PM PT): 7 differing rows, every one data that moved since — 2 editions created 12:52 PM PT and 5 whose
-- serials_with_recorded_price rose with new sales, each new value equal to a fresh recount.
--
-- HOW (no DROP — this session's MCP holds destructive DDL): build mv_panini_squeeze_v2, give it the same unique key
-- (REFRESH CONCURRENTLY needs it) and ACL (service_role only), re-point the ONE dependent view
-- (panini_squeeze_board, CREATE OR REPLACE WITH (security_invoker = on) — same columns), then swap names. The old
-- MV stays as mv_panini_squeeze_retired_20261110 (no dependents, no refresher, anon/auth revoked) for a later
-- `DROP MATERIALIZED VIEW public.mv_panini_squeeze_retired_20261110;`. refresh_panini_squeeze() resolves the MV by
-- name at run time, so it refreshes the new one unchanged.
--
-- REVERT:
--   ALTER MATERIALIZED VIEW public.mv_panini_squeeze RENAME TO mv_panini_squeeze_v2;
--   ALTER INDEX public.mv_panini_squeeze_key RENAME TO mv_panini_squeeze_v2_key;
--   ALTER MATERIALIZED VIEW public.mv_panini_squeeze_retired_20261110 RENAME TO mv_panini_squeeze;
--   ALTER INDEX public.mv_panini_squeeze_retired_20261110_key RENAME TO mv_panini_squeeze_key;
--   CREATE OR REPLACE VIEW public.panini_squeeze_board WITH (security_invoker = on) AS SELECT <same columns> FROM public.mv_panini_squeeze m;
--   REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_panini_squeeze;  -- then drop mv_panini_squeeze_v2

CREATE MATERIALIZED VIEW public.mv_panini_squeeze_v2 AS
 WITH serial_agg AS (
         SELECT cs.edition_external_id,
            COALESCE(bool_or(cs.nft_type ~~ '%rookie card%'::text), false) AS is_rookie,
            COALESCE(bool_or(cs.nft_type ~~ '%debut card%'::text), false) AS is_debut,
            count(*) FILTER (WHERE cs.last_sale_usd IS NOT NULL) AS serials_with_recorded_price
           FROM panini_card_serials cs
          WHERE cs.edition_external_id IN (SELECT w.external_id FROM panini_wc_editions w WHERE w.mint_cap IS NOT NULL)
          GROUP BY cs.edition_external_id
        )
 SELECT e.id,
    e.external_id,
    e.collection_id,
    e.player_name,
    e.nation,
    e.set_name,
    e.parallel,
    e.parallel_family,
    e.rarity_label,
    e.tier,
    e.mint_cap,
    e.pulled_count,
    e.still_in_packs,
        CASE
            WHEN COALESCE(e.mint_cap, 0) > 0 THEN round(e.pulled_count::numeric / e.mint_cap::numeric * 100::numeric, 1)
            ELSE NULL::numeric
        END AS rip_pct,
    e.is_fotl_exclusive,
    COALESCE(sa.is_rookie, false) AS is_rookie,
    COALESCE(sa.is_debut, false) AS is_debut,
    f.fmv_usd,
    round(e.still_in_packs::numeric * f.fmv_usd) AS sealed_fmv_exposure_usd,
    f.confidence AS fmv_confidence,
    e.serial_low_ask_usd,
    e.thumbnail_url,
    COALESCE(sa.serials_with_recorded_price, 0::bigint) AS serials_with_recorded_price,
    ca.coverage_flag
   FROM panini_wc_editions e
     LEFT JOIN serial_agg sa ON sa.edition_external_id = e.external_id
     LEFT JOIN LATERAL ( SELECT s.fmv_usd,
            s.confidence
           FROM panini_fmv_snapshots s
          WHERE s.edition_id = e.id
          ORDER BY s.computed_at DESC
         LIMIT 1) f ON true
     LEFT JOIN panini_coverage_audit ca ON ca.set_name = e.set_name AND NOT ca.parallel_family IS DISTINCT FROM e.parallel_family
  WHERE e.mint_cap IS NOT NULL;

CREATE UNIQUE INDEX mv_panini_squeeze_v2_key ON public.mv_panini_squeeze_v2 USING btree (player_name, set_name, tier);
REVOKE ALL ON public.mv_panini_squeeze_v2 FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.mv_panini_squeeze_v2 TO service_role;

-- Same rows as the old definition (the restriction is a filter on the aggregate's own group key, and the outer query
-- LEFT JOINs it on exactly those keys); assert the row set matches the old view's edition set at this instant.
DO $$
DECLARE v_new int; v_base int; v_cols_old text; v_cols_new text;
BEGIN
  SELECT count(*) INTO v_new FROM public.mv_panini_squeeze_v2;
  SELECT count(*) INTO v_base FROM public.panini_wc_editions WHERE mint_cap IS NOT NULL;
  IF v_new <> v_base THEN RAISE EXCEPTION 'mv_panini_squeeze_v2: % rows vs % base editions', v_new, v_base; END IF;
  SELECT string_agg(attname || ':' || format_type(atttypid, atttypmod), ',' ORDER BY attnum) INTO v_cols_old
    FROM pg_attribute WHERE attrelid = 'public.mv_panini_squeeze'::regclass AND attnum > 0 AND NOT attisdropped;
  SELECT string_agg(attname || ':' || format_type(atttypid, atttypmod), ',' ORDER BY attnum) INTO v_cols_new
    FROM pg_attribute WHERE attrelid = 'public.mv_panini_squeeze_v2'::regclass AND attnum > 0 AND NOT attisdropped;
  IF v_cols_old IS DISTINCT FROM v_cols_new THEN RAISE EXCEPTION 'column shape differs: % vs %', v_cols_old, v_cols_new; END IF;
END $$;

CREATE OR REPLACE VIEW public.panini_squeeze_board WITH (security_invoker = on) AS
 SELECT id,
    external_id,
    collection_id,
    player_name,
    nation,
    set_name,
    parallel,
    parallel_family,
    rarity_label,
    tier,
    mint_cap,
    pulled_count,
    still_in_packs,
    rip_pct,
    is_fotl_exclusive,
    is_rookie,
    is_debut,
    fmv_usd,
    sealed_fmv_exposure_usd,
    fmv_confidence,
    serial_low_ask_usd,
    thumbnail_url,
    serials_with_recorded_price,
    coverage_flag
   FROM public.mv_panini_squeeze_v2 m;

ALTER MATERIALIZED VIEW public.mv_panini_squeeze RENAME TO mv_panini_squeeze_retired_20261110;
ALTER INDEX public.mv_panini_squeeze_key RENAME TO mv_panini_squeeze_retired_20261110_key;
ALTER MATERIALIZED VIEW public.mv_panini_squeeze_v2 RENAME TO mv_panini_squeeze;
ALTER INDEX public.mv_panini_squeeze_v2_key RENAME TO mv_panini_squeeze_key;
REVOKE ALL ON public.mv_panini_squeeze_retired_20261110 FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_depend d JOIN pg_rewrite r ON r.oid = d.objid
                  WHERE r.ev_class = 'public.panini_squeeze_board'::regclass AND d.refobjid = 'public.mv_panini_squeeze'::regclass) THEN
    RAISE EXCEPTION 'panini_squeeze_board does not read the new mv_panini_squeeze';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_depend d JOIN pg_rewrite r ON r.oid = d.objid
              WHERE d.refobjid = 'public.mv_panini_squeeze_retired_20261110'::regclass AND r.ev_class <> 'public.mv_panini_squeeze_retired_20261110'::regclass) THEN
    RAISE EXCEPTION 'something still reads the retired MV';
  END IF;
  IF (SELECT reloptions FROM pg_class WHERE oid = 'public.panini_squeeze_board'::regclass) IS DISTINCT FROM ARRAY['security_invoker=on'] THEN
    RAISE EXCEPTION 'panini_squeeze_board lost security_invoker';
  END IF;
  IF has_table_privilege('anon', 'public.mv_panini_squeeze', 'SELECT') OR has_table_privilege('authenticated', 'public.mv_panini_squeeze', 'SELECT')
     OR has_table_privilege('anon', 'public.panini_squeeze_board', 'SELECT') THEN
    RAISE EXCEPTION 'anon/authenticated can read the squeeze objects';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
                  WHERE c.relname = 'mv_panini_squeeze_key' AND i.indrelid = 'public.mv_panini_squeeze'::regclass AND i.indisunique) THEN
    RAISE EXCEPTION 'unique index for REFRESH ... CONCURRENTLY missing on the new MV';
  END IF;
END $$;
