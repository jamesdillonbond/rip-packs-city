-- Fix: get_wallet_total_fmv cross-collection-inflated wallet totals.
--
-- BUG: the editions join `e.external_id = wmc.edition_key` was NOT scoped by
-- collection. external_id is unique WITHIN a collection but COLLIDES across
-- collections (e.g. a Golazos moment's key also exists as a Top Shot edition's
-- external_id), so every colliding moment fanned out to 2 edition rows and the
-- SUM added a second, unrelated collection's FMV. Measured on a live Golazos
-- wallet (0x4ba45c2312086820): $95,769 returned vs $30,599 collection-correct
-- — ~3.1x inflated. This is the §1 "renders a number we know is wrong" class on
-- the portfolio-value number (roadmap-2026-08-03 §1).
--
-- FIX: add `AND e.collection_id = wmc.collection_id` to the editions join. This
-- is correct for BOTH call shapes — the per-collection call (WHERE filters
-- wmc.collection_id) and the whole-wallet call (p_collection_id NULL: each moment
-- now prices only against an edition in its OWN collection). The TS integer-pair
-- sibling_fmv logic is unaffected (a TS moment's edition + its UUID sibling are
-- both Top Shot, so scoping to the TS collection keeps the sibling match).
--
-- Revert: re-apply 20260801160300_audit_20260801_snapshot_get_wallet_total_fmv.sql
-- (the prior, unscoped definition).

CREATE OR REPLACE FUNCTION public.get_wallet_total_fmv(p_wallet text, p_collection_id uuid DEFAULT NULL::uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE
 SET statement_timeout TO '30s'
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH latest_fmv AS (
    SELECT DISTINCT ON (edition_id)
      edition_id, fmv_usd
    FROM fmv_snapshots
    ORDER BY edition_id, computed_at DESC
  ),
  sibling_fmv AS (
    SELECT DISTINCT ON (int_ed.id)
      int_ed.id AS int_edition_id,
      lf.fmv_usd
    FROM editions int_ed
    JOIN editions uuid_ed ON uuid_ed.name = int_ed.name
      AND uuid_ed.series = int_ed.series
      AND uuid_ed.id != int_ed.id
    JOIN latest_fmv lf ON lf.edition_id = uuid_ed.id
    WHERE int_ed.external_id ~ '^\d+:\d+$'
    ORDER BY int_ed.id, lf.fmv_usd DESC NULLS LAST
  )
  SELECT COALESCE(SUM(COALESCE(lf.fmv_usd, sf.fmv_usd, wmc.fmv_usd)), 0)
  FROM wallet_moments_cache wmc
  LEFT JOIN editions e ON e.external_id = wmc.edition_key AND e.collection_id = wmc.collection_id
  LEFT JOIN latest_fmv lf ON lf.edition_id = e.id
  LEFT JOIN sibling_fmv sf ON sf.int_edition_id = e.id AND lf.edition_id IS NULL
  WHERE wmc.wallet_address = p_wallet
    AND (p_collection_id IS NULL OR wmc.collection_id = p_collection_id);
$function$;
