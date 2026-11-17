-- audit_20261110_insider_early_buyer_candidate_count_reads_the_recent_window
--
-- WHY. /api/cron/run-insider-detectors samples candidate counts (count_insider_detector_candidates) every few hours;
-- the `early_buyers` branch found "editions first sold in the last 7 days" by grouping EVERY sale of the collection
-- by edition. On All Day that runs past the function's own 60 s statement_timeout: candidates_status = "failed" on
-- 4 of the last 5 sampled runs (Top Shot 2 of 5), so the run log's early-buyer funnel is blank exactly where it is
-- read. The detector itself (detect_new_edition_early_buyers) was moved off this shape on 2026-07-16; its counter
-- was not.
--
-- WHAT. Only the early_buyers branch's `efs` CTE changes, to the detector's own form: an edition whose first-ever
-- sale is < 7 d old is exactly one with a sale in the last 7 d and none at or before now() - 7 d; its first_sale_at
-- is the same min(). Measured 1:48 PM PT: All Day 3.0 s (old > 55 s), Top Shot 13.1 s, and on Top Shot the OLD
-- function returned 11 and the new query 11 at the same instant. Every other branch, the signature, plpgsql,
-- SECURITY DEFINER, statement_timeout 60s, search_path and ACL are unchanged.
-- Base = live body (md5 8d62f8852a97482fa24783b8b54aa002, = 20261004004247's), asserted below.
--
-- anon-exec: unchanged (count_insider_detector_candidates) -- CREATE OR REPLACE of an existing fn, same signature; ACL preserved (postgres, service_role).
-- REVERT: re-apply the count_insider_detector_candidates block of 20261004004247_audit_20261003_buyer_signals_exclude_buyback_wallets.sql.

DO $$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.count_insider_detector_candidates(text,text)'::regprocedure)
     <> '8d62f8852a97482fa24783b8b54aa002' THEN
    RAISE EXCEPTION 'count_insider_detector_candidates live body drifted from the 20261004004247 base; re-read before replacing';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.count_insider_detector_candidates(
  p_slug text,
  p_detector text
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '60s'
AS $function$
DECLARE
  v_collection_id uuid;
  v_count int := 0;
BEGIN
  SELECT id INTO v_collection_id FROM public.collections WHERE slug = p_slug;
  IF v_collection_id IS NULL THEN
    RETURN -1;
  END IF;

  IF p_detector = 'unusual_volume' THEN
    SELECT COUNT(*) INTO v_count FROM (
      SELECT s.edition_id
      FROM public.sales_market s
      WHERE s.collection_id = v_collection_id
        AND s.sold_at > NOW() - INTERVAL '24 hours'
        AND s.edition_id IS NOT NULL
      GROUP BY s.edition_id
      HAVING COUNT(*) >= 5
    ) t;
  ELSIF p_detector = 'floor_drops' THEN
    SELECT COUNT(*) INTO v_count FROM (
      SELECT s.edition_id
      FROM public.sales_market s
      WHERE s.collection_id = v_collection_id
        AND s.sold_at > NOW() - INTERVAL '24 hours'
        AND s.edition_id IS NOT NULL
      GROUP BY s.edition_id
      HAVING COUNT(*) >= 3
    ) t;
  ELSIF p_detector = 'concentration_buys' THEN
    SELECT COUNT(*) INTO v_count FROM (
      SELECT s.edition_id, s.buyer_address
      FROM public.sales_market s
      WHERE s.collection_id = v_collection_id
        AND s.sold_at > NOW() - INTERVAL '24 hours'
        AND s.edition_id IS NOT NULL
        AND s.buyer_address IS NOT NULL
        AND s.buyer_address NOT IN ('0x3cdbb3d569211ff3','0xedf9df96c92f4595','0xc1e4f4f4c4257510')
      GROUP BY s.edition_id, s.buyer_address
      HAVING COUNT(*) >= 5
    ) t;
  ELSIF p_detector = 'early_buyers' THEN
    SELECT COUNT(*) INTO v_count FROM (
      -- 2026-11-10: the detector's own shape (detect_new_edition_early_buyers, parity-verified 07-16):
      -- "first-ever sale < 7 d old" == has a sale in the last 7 d AND none before. The full-history
      -- GROUP BY grouped every sale of the collection and ran past the 60 s limit on 4 of the last 5
      -- sampled All Day runs (candidates_status "failed"); this form is 3 s there, 13 s on Top Shot.
      WITH efs_recent AS (
        SELECT DISTINCT s.edition_id
        FROM public.sales_market s
        WHERE s.collection_id = v_collection_id AND s.edition_id IS NOT NULL
          AND s.sold_at > NOW() - INTERVAL '7 days'
      ),
      efs AS (
        SELECT r.edition_id,
               (SELECT min(s2.sold_at) FROM public.sales_market s2
                 WHERE s2.edition_id = r.edition_id AND s2.collection_id = v_collection_id) AS first_sale_at
        FROM efs_recent r
        WHERE NOT EXISTS (
          SELECT 1 FROM public.sales_market s3
          WHERE s3.edition_id = r.edition_id AND s3.collection_id = v_collection_id
            AND s3.sold_at <= NOW() - INTERVAL '7 days'
        )
      )
      SELECT s.edition_id, s.buyer_address
      FROM public.sales_market s
      JOIN efs ON efs.edition_id = s.edition_id
      WHERE s.collection_id = v_collection_id
        AND s.sold_at <= efs.first_sale_at + INTERVAL '48 hours'
        AND s.buyer_address IS NOT NULL
        AND s.buyer_address NOT IN ('0x3cdbb3d569211ff3','0xedf9df96c92f4595','0xc1e4f4f4c4257510')
      GROUP BY s.edition_id, s.buyer_address
      HAVING COUNT(*) >= 3
    ) t;
  ELSE
    RETURN -1;
  END IF;

  RETURN v_count;
END;
$function$;
