-- audit_20260928_pinnacle_wmc_fmv_follows_the_catalog_to_null
--
-- populate_pinnacle_wmc_fmv copies pinnacle_catalog.fmv_usd onto each held
-- pin's wallet_moments_cache row, but only where the catalog HAS a price
-- (`pc.fmv_usd IS NOT NULL`). When the recalc drops a pin to NO_DATA the
-- wallet row kept its last price forever: live 2026-09-28, 339 pins in 20
-- wallets carried $9,705.10 the catalog no longer stands behind, and wallet
-- 0x5f71947aea94eb43's Collection total ($71,930.66) disagreed with its
-- Analytics total ($71,355.56), which reads the catalog.
--
-- Two changes, both needed (each proven by a planted defect in the pin):
--   1. The candidate set drops `pc.fmv_usd IS NOT NULL`, so IS DISTINCT FROM
--      sets a de-priced pin back to NULL (counted as `cleared`).
--   2. The early-exit probe also looks for a priced wallet row over an
--      unpriced catalog row. The watermark max reads priced rows only, so a
--      pin going to NULL alone never moves it; without this probe the run
--      exits early and never clears it.
-- The run below the function clears the 339 rows now rather than at the next
-- tick. Sole DB writer of this column for Pinnacle (grepped prosrc 09-28;
-- scan-pinnacle-wallet writes no fmv).
--
-- anon-exec: revoked (populate_pinnacle_wmc_fmv) — REVOKEd from PUBLIC, anon, authenticated below and re-GRANTed to the pg_cron role and service_role.
--
-- Pin: supabase/tests/populate_pinnacle_wmc_fmv.sql (DDL verbatim).
-- Revert: re-apply the body from 20260830153801 (it re-prices, never clears).

CREATE OR REPLACE FUNCTION public.populate_pinnacle_wmc_fmv(p_limit integer DEFAULT 5000)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '300s'
AS $function$
DECLARE
  v_collection_id uuid; v_updated int := 0; v_examined int := 0; v_cleared int := 0;
  v_catalog_max timestamptz; v_synced timestamptz; v_has_work boolean;
BEGIN
  SELECT id INTO v_collection_id FROM collections WHERE slug = 'disney_pinnacle';

  -- 2026-08-30 watermark: skip the ~55k-row scan when the catalog has not
  -- moved since the last draining run and no out-of-sync row is waiting.
  -- 2026-09-28: "out of sync" includes a priced wallet row over a pin the
  -- catalog no longer prices (NO_DATA) — the probe below looks for both.
  SELECT max(fmv_computed_at) INTO v_catalog_max
  FROM pinnacle_catalog WHERE fmv_usd IS NOT NULL;
  SELECT synced_catalog_fmv_at INTO v_synced
  FROM populate_pinnacle_wmc_fmv_state WHERE id = 1;
  IF v_synced IS NOT NULL AND v_catalog_max IS NOT NULL AND v_catalog_max <= v_synced THEN
    SELECT EXISTS (
      SELECT 1
      FROM wallet_moments_cache w
      JOIN pinnacle_catalog pc ON pc.render_id = w.render_id
      WHERE w.collection_id = v_collection_id
        AND w.render_id IS NOT NULL
        AND ((w.fmv_usd IS NULL AND w.edition_key IS NOT NULL AND pc.fmv_usd IS NOT NULL)
          OR (w.fmv_usd IS NOT NULL AND pc.fmv_usd IS NULL))
    ) INTO v_has_work;
    IF NOT v_has_work THEN
      RETURN json_build_object('examined', 0, 'updated', 0, 'cleared', 0,
        'collection', 'disney_pinnacle', 'algo', 'render-catalog-2.0',
        'reason', 'catalog_unchanged', 'catalog_fmv_max', v_catalog_max);
    END IF;
  END IF;

  -- 2026-09-28: the catalog's price is the wallet's price, INCLUDING its
  -- absence. A pin the catalog no longer prices (NO_DATA) is set back to NULL;
  -- this writer used to skip those rows, so the last price stuck forever
  -- (339 pins / 20 wallets / $9,705 on 09-28) and the Collection total
  -- disagreed with Analytics, which reads the catalog.
  WITH candidates AS (
    SELECT wmc.wallet_address, wmc.moment_id, wmc.collection_id, pc.fmv_usd AS new_fmv
    FROM wallet_moments_cache wmc
    JOIN pinnacle_catalog pc ON pc.render_id = wmc.render_id
    WHERE wmc.collection_id = v_collection_id
      AND wmc.render_id IS NOT NULL
      AND wmc.fmv_usd IS DISTINCT FROM pc.fmv_usd
    LIMIT p_limit
  ),
  upd AS (
    UPDATE wallet_moments_cache wmc SET fmv_usd = c.new_fmv
    FROM candidates c
    WHERE wmc.wallet_address = c.wallet_address AND wmc.moment_id = c.moment_id
      AND wmc.collection_id = c.collection_id
    RETURNING wmc.moment_id, c.new_fmv
  )
  SELECT (SELECT COUNT(*) FROM candidates), (SELECT COUNT(*) FROM upd),
         (SELECT COUNT(*) FROM upd WHERE new_fmv IS NULL)
    INTO v_examined, v_updated, v_cleared;

  -- Drained: everything the catalog max at the start of this run implied is
  -- now synced. A run that hit its limit leaves the watermark for the next.
  IF v_examined < COALESCE(p_limit, 5000) AND v_catalog_max IS NOT NULL THEN
    INSERT INTO populate_pinnacle_wmc_fmv_state (id, synced_catalog_fmv_at, synced_at)
    VALUES (1, v_catalog_max, now())
    ON CONFLICT (id) DO UPDATE SET synced_catalog_fmv_at = EXCLUDED.synced_catalog_fmv_at,
                                   synced_at = EXCLUDED.synced_at;
  END IF;

  RETURN json_build_object('examined', v_examined, 'updated', v_updated, 'cleared', v_cleared,
    'collection', 'disney_pinnacle', 'algo', 'render-catalog-2.0',
    'reason', 'scanned', 'catalog_fmv_max', v_catalog_max);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.populate_pinnacle_wmc_fmv(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.populate_pinnacle_wmc_fmv(integer) TO cron_heavy, service_role;

-- Clear the stale rows now, and prove it: none may remain.
DO $verify$
DECLARE v_res json; v_left int;
BEGIN
  v_res := public.populate_pinnacle_wmc_fmv(20000);
  RAISE NOTICE 'populate_pinnacle_wmc_fmv: %', v_res;
  SELECT count(*) INTO v_left
  FROM wallet_moments_cache w JOIN pinnacle_catalog pc ON pc.render_id = w.render_id
  WHERE w.collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714'
    AND w.fmv_usd IS DISTINCT FROM pc.fmv_usd;
  IF v_left > 0 THEN RAISE EXCEPTION '% wallet rows still disagree with the catalog', v_left; END IF;
END
$verify$;
