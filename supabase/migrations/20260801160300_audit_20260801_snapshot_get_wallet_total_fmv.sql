-- Snapshot migration: public.get_wallet_total_fmv(text, uuid).
--
-- Applied to prod historically via the Supabase MCP with no committed migration
-- file (making it UNPINNABLE). This commits the CURRENT LIVE definition verbatim
-- (pulled via pg_get_functiondef on 2026-08-01) so it can carry a pinned
-- invariant test. Applying it is a no-op against prod (byte-identical).
--
-- What it does: totals the FMV of a wallet's holdings (optionally scoped to one
-- collection). Per moment it uses a 3-tier COALESCE:
--   1. the latest fmv_snapshot for the wmc row's edition (edition_key→external_id),
--   2. else, for legacy INTEGER-keyed editions (external_id ~ '^\d+:\d+$') with no
--      snapshot of their own, the highest latest-FMV of a UUID-keyed SIBLING
--      edition sharing the same name+series, and
--   3. else the FMV denormalized onto the wallet_moments_cache row itself.
-- This is the number behind wallet/portfolio total-value displays.

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
  LEFT JOIN editions e ON e.external_id = wmc.edition_key
  LEFT JOIN latest_fmv lf ON lf.edition_id = e.id
  LEFT JOIN sibling_fmv sf ON sf.int_edition_id = e.id AND lf.edition_id IS NULL
  WHERE wmc.wallet_address = p_wallet
    AND (p_collection_id IS NULL OR wmc.collection_id = p_collection_id);
$function$;
