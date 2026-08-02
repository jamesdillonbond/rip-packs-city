-- Snapshot migration: public.apply_topshot_supply(text, boolean, integer, integer, boolean, boolean, jsonb, jsonb, text).
--
-- MCP-applied to prod with no committed migration → UNPINNABLE. This commits the
-- CURRENT LIVE body verbatim (pg_get_functiondef 2026-08-02) so it can carry a
-- drift-guarded pinned test. Applying it is a no-op vs prod (byte-identical).
--
-- Records a TopShot pack distribution's on-chain supply. On success it upserts
-- topshot_pack_supply with derived counters — total_opened = GREATEST(minted -
-- unopened, 0) and depletion_pct = round(100*(minted-opened)/minted) — and
-- WRITES THROUGH the minted/opened counts to the seeder-owned pack_distributions
-- row, SCOPED to the TopShot collection so a same-dist_id row in another
-- collection is never touched. On failure it records supply_ok=false + the error
-- and leaves pack_distributions alone. A regression in the derived counters
-- corrupts every pack-EV/depletion surface; a mis-scoped write-through leaks TS
-- supply onto another collection's distribution.
--
-- Pinned by supabase/tests/apply_topshot_supply.sql.

CREATE OR REPLACE FUNCTION public.apply_topshot_supply(p_dist_id text, p_ok boolean, p_minted integer DEFAULT NULL::integer, p_unopened integer DEFAULT NULL::integer, p_for_sale boolean DEFAULT NULL::boolean, p_is_sold_out boolean DEFAULT NULL::boolean, p_remaining jsonb DEFAULT NULL::jsonb, p_original jsonb DEFAULT NULL::jsonb, p_err text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF p_ok THEN
    INSERT INTO public.topshot_pack_supply
      (dist_id, total_minted, total_opened, total_sealed, depletion_pct, for_sale, is_sold_out, remaining_by_tier, original_by_tier, supply_ok, supply_err, updated_at)
    VALUES (p_dist_id, COALESCE(p_minted,0),
            GREATEST(COALESCE(p_minted,0)-COALESCE(p_unopened,0),0), COALESCE(p_unopened,0),
            (CASE WHEN COALESCE(p_minted,0)>0 THEN round(100.0*(p_minted-COALESCE(p_unopened,0))/p_minted) ELSE 0 END)::smallint,
            p_for_sale, p_is_sold_out, p_remaining, p_original, true, NULL, now())
    ON CONFLICT (dist_id) DO UPDATE SET
      total_minted=EXCLUDED.total_minted, total_opened=EXCLUDED.total_opened, total_sealed=EXCLUDED.total_sealed,
      depletion_pct=EXCLUDED.depletion_pct, for_sale=EXCLUDED.for_sale, is_sold_out=EXCLUDED.is_sold_out,
      remaining_by_tier=EXCLUDED.remaining_by_tier, original_by_tier=EXCLUDED.original_by_tier,
      supply_ok=true, supply_err=NULL, updated_at=now();
    -- write-through to the seeder-owned counters (preserved on re-seed; total_sealed+depletion_pct are GENERATED)
    UPDATE public.pack_distributions
      SET total_minted = COALESCE(p_minted,0),
          total_opened = GREATEST(COALESCE(p_minted,0)-COALESCE(p_unopened,0),0)
      WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' AND dist_id = p_dist_id;
  ELSE
    INSERT INTO public.topshot_pack_supply (dist_id, supply_ok, supply_err, updated_at)
    VALUES (p_dist_id, false, COALESCE(p_err,'unknown'), now())
    ON CONFLICT (dist_id) DO UPDATE SET supply_ok=false, supply_err=COALESCE(p_err,'unknown'), updated_at=now();
  END IF;
END;
$function$;
