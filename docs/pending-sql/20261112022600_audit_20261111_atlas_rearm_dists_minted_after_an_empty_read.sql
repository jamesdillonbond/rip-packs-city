-- audit 2026-11-11 (Rookie Debut verify, scheduled cloud pass, ~6:30 PM PT)
--
-- A Top Shot dist that Dapper lists BEFORE it mints reads totalPackCount 0 from the
-- DistributionService. topshot_pack_supply_tick treats "nothing left, nothing for sale,
-- no end_time" as a CLOSED drop and parks it for 30 days. So a pre-listed drop that
-- then mints keeps reading zero for a month: no tier counts, no Chase-left row, no
-- pack-chase alert.
--
-- Found live on Rookie Debut day: dist 8918 "Rookie Debut Trade Ticket Pack" was read
-- once on 11-05 3:33 PM PT (0 packs), parked to 12-05, then minted 5,000 packs and had
-- 2,758 rips on 11-11 while topshot_atlas_dists still said 0. Two older dists had the
-- same shape (8896 "Canada Punches the Ticket", 8784 "WNBA Rookie Revelation Courtside
-- Box Topper"). All three were re-armed by hand on 11-11 ~6:25 PM PT.
--
-- Fix, without rewriting the tick: an hourly re-arm. Any Top Shot Atlas row that read
-- zero packs, is parked into the future, and has on-chain mints (pack_nft_mints, filled
-- by the mint tail lane) from within 6 h before its last read or later, is made due at
-- its own last-read stamp, which puts it ahead of the ordinary due queue
-- (topshot_atlas_dists_due_idx, next_due_at NULLS FIRST). The 6 h window covers an Atlas
-- read that lagged the mint; after that it stays parked like any closed drop, so a dist
-- that truly reads 0 after minting costs at most six extra reads.
--
-- pack_nft_mints had no dist_id index (PK is collection_id, pack_nft_id; ~470k rows).
--
-- Revert: SELECT cron.unschedule('rpc-atlas-rearm-minted-dists');
--         DROP FUNCTION public.rearm_atlas_dists_minted_after_empty_read(integer);
--         DROP INDEX IF EXISTS public.pack_nft_mints_dist_id_idx;

CREATE INDEX IF NOT EXISTS pack_nft_mints_dist_id_idx ON public.pack_nft_mints (dist_id);

CREATE OR REPLACE FUNCTION public.rearm_atlas_dists_minted_after_empty_read(p_limit integer DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_ids text[];
BEGIN
  WITH cand AS (
    SELECT a.dist_id
    FROM public.topshot_atlas_dists a
    WHERE coalesce(a.total_pack_count, 0) = 0
      AND a.next_due_at > now()
      AND a.summary_fetched_at IS NOT NULL
      AND EXISTS (SELECT 1 FROM public.pack_nft_mints m
                   WHERE m.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
                     AND m.dist_id = a.dist_id
                     AND m.minted_at > a.summary_fetched_at - interval '6 hours')
    ORDER BY a.dist_id
    LIMIT greatest(1, least(coalesce(p_limit, 50), 500))
  ), upd AS (
    UPDATE public.topshot_atlas_dists a
       SET next_due_at = a.summary_fetched_at
      FROM cand c
     WHERE a.dist_id = c.dist_id
    RETURNING a.dist_id
  )
  SELECT array_agg(dist_id ORDER BY dist_id) INTO v_ids FROM upd;

  PERFORM public.log_pipeline_run('atlas-rearm-minted-dists', v_started, coalesce(cardinality(v_ids), 0),
                                  coalesce(cardinality(v_ids), 0), 0, true, NULL, NULL, NULL, NULL,
                                  jsonb_build_object('rearmed', coalesce(cardinality(v_ids), 0),
                                                     'dist_ids', coalesce(to_jsonb(v_ids), '[]'::jsonb)));
  RETURN jsonb_build_object('ok', true, 'rearmed', coalesce(cardinality(v_ids), 0),
                            'dist_ids', coalesce(to_jsonb(v_ids), '[]'::jsonb));
END
$function$;

REVOKE EXECUTE ON FUNCTION public.rearm_atlas_dists_minted_after_empty_read(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rearm_atlas_dists_minted_after_empty_read(integer) TO postgres, service_role;

SELECT cron.schedule('rpc-atlas-rearm-minted-dists', '29 * * * *',
  $cron$SELECT public.rearm_atlas_dists_minted_after_empty_read(50)$cron$);
