-- audit_20260830: populate_pinnacle_wmc_fmv scanned all ~55k Pinnacle
-- wallet_moments_cache rows every hour to find that nothing had changed --
-- 20 of 24 runs a day, most of them dying at the route's 125 s timeout while
-- the statement ran on to its own 300 s.
--
-- MEASURED 2026-08-30 (pipeline_runs populate-pinnacle-wmc-fmv, 26 h):
--   * 4 runs did the work: 00:03 / 01:03 / 02:03 / 03:03Z wrote 10,000 /
--     10,000 / 10,000 / 3,873 rows (the catalog's daily FMV recompute stamps
--     all 2,471 priced pinnacle_catalog rows in one go -- fmv_computed_at
--     min = max = today);
--   * the other 22 runs found 0 rows and took 15-179 s; 13 of them ok=false
--     at the route's 125 s cap. pg_stat_statements: 342 calls, 102.8 s mean,
--     33,053 disk reads + 167,670 hits per call. The 15:04->15:20Z diff had
--     one call at 217 s / 51,535 reads -- the largest single reader in that
--     window.
--   The cost is structural: the candidate CTE joins every Pinnacle wmc row
--   (scattered across the 2.5M-row heap) to the catalog to test
--   `wmc.fmv_usd IS DISTINCT FROM pc.fmv_usd`, i.e. ~55k random heap pages
--   to learn that the catalog has not moved since the last sync.
--
-- CHANGE: a one-row watermark. The function reads
-- max(pinnacle_catalog.fmv_computed_at) at the start of a run; if that is
-- not newer than the watermark AND there is no Pinnacle wmc row with a NULL
-- fmv_usd whose catalog row is priced (a wallet backfill can insert such
-- rows between catalog recomputes; checked through the partial index
-- idx_wmc_fmv_null, a handful of rows), it returns examined 0 / updated 0
-- with reason 'catalog_unchanged' in ~ms. Otherwise it runs the existing
-- scan unchanged; when the scan DRAINS (examined < p_limit) it advances the
-- watermark to the catalog max it read at the start -- a run that hits its
-- limit leaves the watermark alone so the next hour continues. A run that
-- times out commits nothing, so the watermark never moves past unsynced
-- work. Return shape gains 'reason' and 'catalog_fmv_max'; the route reads
-- only examined/updated.
--
-- Same SECURITY DEFINER body otherwise (the candidates / upd CTEs are
-- verbatim). Not pinned before (no migration defines it) and not pinned now.
--
-- anon-exec: populate_pinnacle_wmc_fmv -- unchanged (CREATE OR REPLACE keeps
-- the existing grants; service_role caller).
-- anon-exec: populate_pinnacle_wmc_fmv_state -- new table, RLS on, no
-- policies; only the SECURITY DEFINER function reads/writes it.
--
-- Exit (48 h): populate-pinnacle-wmc-fmv runs after the catalog recompute
-- still write ~34k rows across 4 ticks; every other tick logs examined 0 in
-- < 1 s with ok=true; zero 125 s timeouts. Falsifier: rows_written stays 0
-- through a catalog recompute -> the watermark advanced too early (check
-- populate_pinnacle_wmc_fmv_state against max(fmv_computed_at)); delete the
-- state row to force a full pass.
-- Revert: re-create the function without the early return (the candidates
-- and upd CTEs below are the pre-migration body).

CREATE TABLE IF NOT EXISTS public.populate_pinnacle_wmc_fmv_state (
  id                    integer PRIMARY KEY CHECK (id = 1),
  synced_catalog_fmv_at timestamptz NOT NULL,
  synced_at             timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.populate_pinnacle_wmc_fmv_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.populate_pinnacle_wmc_fmv_state FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.populate_pinnacle_wmc_fmv_state IS
  'Watermark for populate_pinnacle_wmc_fmv(): the max(pinnacle_catalog.fmv_computed_at) the last DRAINING run started from. A run whose catalog max is not newer (and that finds no fillable NULL-fmv row) returns early instead of re-scanning ~55k wmc rows (2026-08-30). Delete the row to force a full pass.';

CREATE OR REPLACE FUNCTION public.populate_pinnacle_wmc_fmv(p_limit integer DEFAULT 5000)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '300s'
AS $function$
DECLARE
  v_collection_id uuid; v_updated int := 0; v_examined int := 0;
  v_catalog_max timestamptz; v_synced timestamptz; v_has_fillable_null boolean;
BEGIN
  SELECT id INTO v_collection_id FROM collections WHERE slug = 'disney_pinnacle';

  -- 2026-08-30 watermark: skip the ~55k-row scan when the catalog has not
  -- moved since the last draining run and no NULL-fmv row is waiting.
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
        AND w.fmv_usd IS NULL
        AND w.edition_key IS NOT NULL
        AND w.render_id IS NOT NULL
        AND pc.fmv_usd IS NOT NULL
    ) INTO v_has_fillable_null;
    IF NOT v_has_fillable_null THEN
      RETURN json_build_object('examined', 0, 'updated', 0,
        'collection', 'disney_pinnacle', 'algo', 'render-catalog-2.0',
        'reason', 'catalog_unchanged', 'catalog_fmv_max', v_catalog_max);
    END IF;
  END IF;

  WITH candidates AS (
    SELECT wmc.wallet_address, wmc.moment_id, wmc.collection_id, pc.fmv_usd AS new_fmv
    FROM wallet_moments_cache wmc
    JOIN pinnacle_catalog pc ON pc.render_id = wmc.render_id
    WHERE wmc.collection_id = v_collection_id
      AND wmc.render_id IS NOT NULL
      AND pc.fmv_usd IS NOT NULL
      AND wmc.fmv_usd IS DISTINCT FROM pc.fmv_usd
    LIMIT p_limit
  ),
  upd AS (
    UPDATE wallet_moments_cache wmc SET fmv_usd = c.new_fmv
    FROM candidates c
    WHERE wmc.wallet_address = c.wallet_address AND wmc.moment_id = c.moment_id
      AND wmc.collection_id = c.collection_id
    RETURNING wmc.moment_id
  )
  SELECT (SELECT COUNT(*) FROM candidates), (SELECT COUNT(*) FROM upd) INTO v_examined, v_updated;

  -- Drained: everything the catalog max at the start of this run implied is
  -- now synced. A run that hit its limit leaves the watermark for the next.
  IF v_examined < COALESCE(p_limit, 5000) AND v_catalog_max IS NOT NULL THEN
    INSERT INTO populate_pinnacle_wmc_fmv_state (id, synced_catalog_fmv_at, synced_at)
    VALUES (1, v_catalog_max, now())
    ON CONFLICT (id) DO UPDATE SET synced_catalog_fmv_at = EXCLUDED.synced_catalog_fmv_at,
                                   synced_at = EXCLUDED.synced_at;
  END IF;

  RETURN json_build_object('examined', v_examined, 'updated', v_updated,
    'collection', 'disney_pinnacle', 'algo', 'render-catalog-2.0',
    'reason', 'scanned', 'catalog_fmv_max', v_catalog_max);
END;
$function$;
