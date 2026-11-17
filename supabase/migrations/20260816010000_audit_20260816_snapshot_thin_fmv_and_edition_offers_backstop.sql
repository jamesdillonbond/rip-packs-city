-- Snapshot migration: two scheduled SECDEF writers that had no committed DDL.
--
--   public.refresh_topshot_thin_fmv_editions()   pg_cron `30 8 * * *`
--   public.raise_edition_offers_from_chain()     pg_cron `34 * * * *`
--
-- Both were applied to prod via the Supabase MCP with no committed migration
-- file, which made them UNPINNABLE — the DB-invariant drift guard has nothing to
-- compare a test copy against, and `npm run db:pins:check` has no committed body
-- to diff live `prosrc` against. This commits the CURRENT LIVE definitions
-- verbatim (pg_get_functiondef, 2026-08-16):
--   refresh_topshot_thin_fmv_editions  md5 3e0f8218dca4bbee1ecdbeb4ee219f2b
--   raise_edition_offers_from_chain    md5 c3a32f8a0cb02b285dbe0ef7ea7087e5
-- Applying it is a no-op against prod (byte-identical to what already runs).
--
-- ── WHY THESE TWO ──────────────────────────────────────────────────────────
--
-- refresh_topshot_thin_fmv_editions is an FMV HONESTY instrument. It rebuilds
-- the set of Top Shot editions whose published FMV is inflated relative to what
-- the market actually paid: thin (<15 sales in 90d) AND FMV more than 1.5x the
-- 90-day median print. Its two constants ARE the definition — move either and
-- the platform's own notion of "this price is not well supported" moves with it,
-- silently, on a surface collectors read as a price.
--
-- ⚠ It TRUNCATEs and rebuilds in one transaction, which is why it is worth a pin
-- at all: a rebuild that inserts nothing leaves the table EMPTY, and an empty
-- table reads exactly like "no edition has an unsupported FMV" — the most
-- reassuring possible answer, produced by a broken instrument.
--
-- raise_edition_offers_from_chain is a BACKSTOP for the offers indexer, and it
-- is RAISE-ONLY by construction: `GREATEST(existing, incoming)` plus a
-- `WHERE EXCLUDED.highest_offer > COALESCE(existing, 0)` guard, so it can never
-- LOWER a recorded best offer. That asymmetry is deliberate (a backstop must not
-- undo the primary writer on a partial chain read) and is exactly the kind of
-- thing a future editor "fixes" into a plain upsert.
--
-- REVERT: these are snapshots of what is already live, so reverting the FILE
-- changes nothing in prod. To remove the functions themselves:
--   DROP FUNCTION public.refresh_topshot_thin_fmv_editions();
--   DROP FUNCTION public.raise_edition_offers_from_chain();
-- (which would also require unscheduling pg_cron `rpc-refresh-thin-fmv-guard`
-- and `rpc-raise-edition-offers-backstop`).

CREATE OR REPLACE FUNCTION public.refresh_topshot_thin_fmv_editions()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_count integer;
BEGIN
  TRUNCATE public.topshot_thin_fmv_editions;

  INSERT INTO public.topshot_thin_fmv_editions (edition_id, fmv_usd, median_90d, n_90d, computed_at)
  WITH cand AS (
    -- Cheap prefilter using the stored snapshot column: HIGH/MEDIUM editions that are already thin
    -- (sales_count_30d 1..14) -- narrows the median-scan set without touching the sales table.
    SELECT e.id AS edition_id, lf.fmv_usd
    FROM public.editions e
    JOIN LATERAL (
      SELECT fs.confidence, fs.sales_count_30d, fs.fmv_usd
      FROM public.fmv_snapshots fs
      WHERE fs.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
        AND fs.edition_id = e.id
      ORDER BY fs.computed_at DESC
      LIMIT 1
    ) lf ON true
    WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
      AND lf.confidence IN ('HIGH','MEDIUM')
      AND lf.fmv_usd > 0
      AND lf.sales_count_30d BETWEEN 1 AND 14
  )
  SELECT c.edition_id, c.fmv_usd, m.median_90d, m.n_90d, now()
  FROM cand c
  JOIN LATERAL (
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY s.price_usd)::numeric AS median_90d,
           count(*)::integer AS n_90d
    FROM public.sales s
    WHERE s.edition_id = c.edition_id
      AND s.sold_at >= now() - interval '90 days'
      AND s.price_usd > 0
  ) m ON true
  -- Precise definition: thin (<15 sales/90d) AND FMV inflated >1.5x above the 90d median.
  WHERE m.n_90d < 15
    AND m.median_90d > 0
    AND c.fmv_usd > 1.5 * m.median_90d;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;

CREATE OR REPLACE FUNCTION public.raise_edition_offers_from_chain()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '600s'
AS $function$
DECLARE
  v_n integer;
BEGIN
  WITH chain AS (
    SELECT e.external_id::text AS external_id, max(o.offer_amount_usd) AS chain_edition_max
    FROM offers o
    JOIN editions e ON e.id = o.edition_id
    WHERE o.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
      AND o.status = 'open'
      AND o.offer_type NOT IN ('subedition','serial')
      AND o.offer_amount_usd > 0
    GROUP BY e.external_id
  ), upserted AS (
    INSERT INTO edition_offers (collection_id, external_id, highest_offer, updated_at)
    SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, c.external_id, c.chain_edition_max, now()
    FROM chain c
    ON CONFLICT (collection_id, external_id) DO UPDATE
      SET highest_offer = GREATEST(COALESCE(edition_offers.highest_offer, 0), EXCLUDED.highest_offer),
          updated_at = now()
      WHERE EXCLUDED.highest_offer > COALESCE(edition_offers.highest_offer, 0)
    RETURNING 1
  )
  SELECT count(*) INTO v_n FROM upserted;
  RETURN v_n;
END;
$function$;
