-- audit_20261104_pinnacle_wmc_fmv_sees_in_place_reprices — 2026-11-04 ~7:03 PM PT (Claude Code cloud; autonomous pass).
--
-- populate_pinnacle_wmc_fmv (pg_cron hourly :09) copies pinnacle_catalog.fmv_usd onto wallet_moments_cache.
-- Its early exit trusted one watermark: max(pinnacle_catalog.fmv_computed_at) <= the last drained run's,
-- plus a probe that only finds a price GAINED or LOST. A price changed IN PLACE -- a re-price migration
-- that does not bump fmv_computed_at -- passed both and never reached a wallet. 20261105010815 (Pinnacle
-- _histcap, 59 pins, Pedro $1,620 -> $300) was exactly that shape; it reached 633 wallet rows only because
-- the 5:37 PM PT recalc re-stamped every pin. The early exit now also requires a fingerprint of every pin's
-- price (md5 over 2,893 render_id:fmv_usd pairs; measured 8 ms, 2.2k buffers, once an hour) to equal the one
-- the last draining run stored. First run after this migration: stored fp is NULL -> one full scan (the
-- ~55k-row scan the watermark normally skips), then the early exit resumes.
--
-- anon-exec: unchanged — EXECUTE is false for anon/authenticated (granted to cron_heavy, 20260830154447); CREATE OR REPLACE keeps the ACL (populate_pinnacle_wmc_fmv)
--
-- REVERT: re-apply the function body in 20260929021346, then
--   ALTER TABLE public.populate_pinnacle_wmc_fmv_state DROP COLUMN synced_catalog_fp;

DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.populate_pinnacle_wmc_fmv(integer)'::regprocedure)
     <> 'fd407f440145e92e24fca91c495fd411' THEN
    RAISE EXCEPTION 'live body is not the 20260929021346 body this migration was written against; re-read it';
  END IF;
END
$guard$;

ALTER TABLE public.populate_pinnacle_wmc_fmv_state ADD COLUMN IF NOT EXISTS synced_catalog_fp text;

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
  v_fp text; v_synced_fp text;
BEGIN
  SELECT id INTO v_collection_id FROM collections WHERE slug = 'disney_pinnacle';

  -- 2026-08-30 watermark: skip the ~55k-row scan when the catalog has not
  -- moved since the last draining run and no out-of-sync row is waiting.
  -- 2026-09-28: "out of sync" includes a priced wallet row over a pin the
  -- catalog no longer prices (NO_DATA) — the probe below looks for both.
  SELECT max(fmv_computed_at) INTO v_catalog_max
  FROM pinnacle_catalog WHERE fmv_usd IS NOT NULL;
  -- 2026-11-04: the watermark alone misses a price changed IN PLACE (a re-price migration that
  -- does not bump fmv_computed_at: 20261105010815 capped 59 pins and reached wallets only because
  -- the next recalc re-stamped every pin). A fingerprint of every pin's price (2,893 rows, ~8 ms)
  -- must also match the one the last draining run synced, or the run scans.
  SELECT md5(string_agg(render_id || ':' || coalesce(fmv_usd::text, ''), ',' ORDER BY render_id))
    INTO v_fp FROM pinnacle_catalog;
  SELECT synced_catalog_fmv_at, synced_catalog_fp INTO v_synced, v_synced_fp
  FROM populate_pinnacle_wmc_fmv_state WHERE id = 1;
  IF v_synced IS NOT NULL AND v_catalog_max IS NOT NULL AND v_catalog_max <= v_synced
     AND v_synced_fp IS NOT NULL AND v_synced_fp = v_fp THEN
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
    INSERT INTO populate_pinnacle_wmc_fmv_state (id, synced_catalog_fmv_at, synced_at, synced_catalog_fp)
    VALUES (1, v_catalog_max, now(), v_fp)
    ON CONFLICT (id) DO UPDATE SET synced_catalog_fmv_at = EXCLUDED.synced_catalog_fmv_at,
                                   synced_at = EXCLUDED.synced_at,
                                   synced_catalog_fp = EXCLUDED.synced_catalog_fp;
  END IF;

  RETURN json_build_object('examined', v_examined, 'updated', v_updated, 'cleared', v_cleared,
    'collection', 'disney_pinnacle', 'algo', 'render-catalog-2.0',
    'reason', 'scanned', 'catalog_fmv_max', v_catalog_max);
END;
$function$;
