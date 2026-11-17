-- audit_20261019: Pinnacle pack distributions are discovered from the opens, not only from Studio
--
-- THE GAP (measured 2026-10-19 ~9:00 AM PT). `pack_distributions` gets Pinnacle rows from one
-- writer, the `compute-pinnacle-pack-ev` edge function, which upserts every distribution Studio
-- Platform's `searchDistributions(byProductID: "Pinnacle")` lists. That search has answered the
-- same 156 nodes for weeks and lists nothing released since mid-August. The 09-25 "Summer Sunset"
-- dists (8872–8874) exist only because that day's session seeded them by hand from the PDS
-- contract (20260926032644, whose post-condition "no pack event points at a missing
-- distribution" nothing kept true). Today:
--   * dist 8891 "Star Wars Halloween Vol.1" (the 10-09 drop): 414 opens, no pack_distributions row;
--   * dist 8871 "Summer Sunset - Standard - Genesis": 1 open, no row.
-- A missing row means the wallet pack history, the pack page and the pack tables have no title,
-- price or slot count for those packs. The next drop (24 Pixar renders catalogued 10-17) would
-- repeat it.
--
-- THE FIX. (1) `discover_missing_pinnacle_pack_distributions(p_days)` inserts a placeholder row
-- (title NULL) for every dist a recent `pinnacle_pack_opens` row references and the table lacks —
-- the Top Shot pattern (`discover_missing_topshot_pack_distributions`). The new daily route
-- `/api/cron/pinnacle-pack-dist-names-onchain` calls it, then names every untitled Pinnacle row
-- from `PDS.getDistInfo` (0xb6f2481eba4df97b), fill-only. (2) The two missing rows are seeded now
-- with the facts PDS returned at ~9:00 AM PT (read through Flow REST; productID "disney" on both):
--   8891  "Star Wars Halloween Vol.1"  limited_edition, 1 slot, $49.95,
--         uuid a56ee674-5373-4f2b-8cb4-67c8854b5c2e, 2026-10-08 16:00 → 2027-10-16 16:00 UTC
--   8871  "Summer Sunset - Standard - Genesis"  limited_edition, 1 slot, $4.99,
--         uuid c1637e62-88b0-40e0-909e-50189f5ef8da, 2026-09-25 16:00 → 2026-10-02 16:00 UTC,
--         "Contains the Nemo & Dory Genesis pin."
-- Counts stay unknown (0/0) as for every PDS-seeded dist; no pack art exists for Pinnacle.
-- compute-pinnacle-pack-ev's upsert owns the row if Studio ever lists it.
--
-- REVERT: DELETE FROM public.pack_distributions WHERE metadata->>'seeded_from' IN
--   ('pds_missing_dists_20261019', 'discovered_from_pinnacle_opens');
--   DROP FUNCTION public.discover_missing_pinnacle_pack_distributions(integer);
--
-- anon-exec: revoked (discover_missing_pinnacle_pack_distributions) — new SECDEF writer; REVOKE FROM PUBLIC, anon, authenticated below; GRANT to service_role.

CREATE OR REPLACE FUNCTION public.discover_missing_pinnacle_pack_distributions(p_days integer DEFAULT 14)
 RETURNS integer
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH src AS (
    SELECT DISTINCT o.dist_id
      FROM public.pinnacle_pack_opens o
     WHERE o.dist_id IS NOT NULL
       AND o.opened_at > now() - make_interval(days => GREATEST(LEAST(COALESCE(p_days, 14), 60), 1))
  ), ins AS (
    INSERT INTO public.pack_distributions (collection_id, dist_id, nft_type, metadata)
    SELECT '7dd9dd11-e8b6-45c4-ac99-71331f959714', s.dist_id, 'Pinnacle',
           jsonb_build_object('seeded_from', 'discovered_from_pinnacle_opens')
      FROM src s
     WHERE s.dist_id ~ '^[0-9]+$'
       AND NOT EXISTS (SELECT 1 FROM public.pack_distributions pd
                        WHERE pd.collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714' AND pd.dist_id = s.dist_id)
    ON CONFLICT (dist_id, collection_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::integer FROM ins;
$function$;

REVOKE EXECUTE ON FUNCTION public.discover_missing_pinnacle_pack_distributions(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.discover_missing_pinnacle_pack_distributions(integer) TO service_role;

COMMENT ON FUNCTION public.discover_missing_pinnacle_pack_distributions(integer) IS
  'Placeholder pack_distributions row (title NULL) for every dist a pinnacle_pack_opens row of the last p_days (1..60) references and the table lacks. Called by /api/cron/pinnacle-pack-dist-names-onchain, which then names it from the PDS contract. Studio searchDistributions stopped listing new Pinnacle dists in Aug 2026.';

INSERT INTO public.pack_distributions (collection_id, dist_id, title, nft_type, image_url, metadata)
VALUES
  ('7dd9dd11-e8b6-45c4-ac99-71331f959714', '8891', 'Star Wars Halloween Vol.1', 'Pinnacle', NULL,
   jsonb_build_object('tier', 'limited_edition', 'number_of_pack_slots', 1, 'retail_price_usd', 49.95,
     'uuid', 'a56ee674-5373-4f2b-8cb4-67c8854b5c2e', 'start_time', '2026-10-08 16:00:00 +0000 UTC',
     'end_time', '2027-10-16 16:00:00 +0000 UTC', 'source', 'pds_contract', 'seeded_from', 'pds_missing_dists_20261019')),
  ('7dd9dd11-e8b6-45c4-ac99-71331f959714', '8871', 'Summer Sunset - Standard - Genesis', 'Pinnacle', NULL,
   jsonb_build_object('tier', 'limited_edition', 'number_of_pack_slots', 1, 'retail_price_usd', 4.99,
     'uuid', 'c1637e62-88b0-40e0-909e-50189f5ef8da', 'start_time', '2026-09-25 16:00:00 +0000 UTC',
     'end_time', '2026-10-02 16:00:00 +0000 UTC', 'description', 'Contains the Nemo & Dory Genesis pin.',
     'source', 'pds_contract', 'seeded_from', 'pds_missing_dists_20261019'))
ON CONFLICT (dist_id, collection_id) DO NOTHING;
