-- audit_20260726_serial_board_candidates_pooled_edition_id
-- Activates the pooled multi-factor serial-FMV model on the underpriced-serials deal board
-- (/api/public/insights/underpriced-serials) by passing e.id as the new p_edition_id arg to both
-- serial_fmv_estimate() calls, so #1/perfect estimates use pooled_model where the edition's set is
-- well-supported (else power-law, unchanged). Only change vs the prior body: the trailing ", e.id".
-- REVERT: recreate this function without the ", e.id" argument (prior body in migration history).

CREATE OR REPLACE FUNCTION public.topshot_serial_board_candidates(p_min_no1_estimate numeric DEFAULT 0)
 RETURNS TABLE(rpc_edition_id uuid, external_id text, set_id_onchain integer, play_id_onchain integer, series smallint, tier text, circulation_count integer, edition_fmv_usd numeric, confidence text, no1_estimate_usd numeric, perfect_estimate_usd numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH latest_fmv AS (
    SELECT DISTINCT ON (fs.edition_id) fs.edition_id, fs.fmv_usd, fs.confidence::text AS confidence
    FROM fmv_snapshots fs
    WHERE fs.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
    ORDER BY fs.edition_id, fs.computed_at DESC
  ),
  base AS (
    SELECT e.id AS rpc_edition_id, e.external_id,
           e.set_id_onchain, e.play_id_onchain, e.series, e.tier::text AS tier,
           e.circulation_count, lf.fmv_usd AS edition_fmv_usd, lf.confidence,
           (serial_fmv_estimate('95f28a17-224a-4025-96ad-adf8a4c63bfd', 1, e.circulation_count, e.tier::text, lf.fmv_usd, lf.confidence, e.id) ->> 'estimate_usd')::numeric AS no1_estimate_usd,
           (serial_fmv_estimate('95f28a17-224a-4025-96ad-adf8a4c63bfd', e.circulation_count, e.circulation_count, e.tier::text, lf.fmv_usd, lf.confidence, e.id) ->> 'estimate_usd')::numeric AS perfect_estimate_usd
    FROM editions e
    JOIN latest_fmv lf ON lf.edition_id = e.id
    WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
      AND e.set_id_onchain IS NOT NULL
      AND e.play_id_onchain IS NOT NULL
      AND e.circulation_count > 0
      AND lf.confidence IN ('HIGH','MEDIUM')
  )
  SELECT rpc_edition_id, external_id, set_id_onchain, play_id_onchain, series, tier,
         circulation_count, edition_fmv_usd, confidence, no1_estimate_usd, perfect_estimate_usd
  FROM base
  WHERE COALESCE(no1_estimate_usd, perfect_estimate_usd) IS NOT NULL
    AND COALESCE(no1_estimate_usd, 0) >= p_min_no1_estimate
  ORDER BY no1_estimate_usd DESC NULLS LAST;
$function$;
