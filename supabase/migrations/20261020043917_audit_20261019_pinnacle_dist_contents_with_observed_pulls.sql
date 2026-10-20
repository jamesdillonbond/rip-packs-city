-- audit_20261019: a Disney Pinnacle pack page lists the pins in the drop, with how often each was pulled
--
-- WHY. The pack-dist page's "What's Inside" and "Top pulls by EV" read pack_drop_pool,
-- which has 0 Pinnacle rows, so a Pinnacle pack page showed no contents at all — and the
-- Top-pulls block said "Drop-pool contents aren't indexed for this distribution yet. Older/
-- depleted packs are re-pooled from Dapper Atlas…", Top Shot copy that is false here.
-- Yet pack_distributions.metadata.edition_ids lists each Pinnacle drop's editions (154 of
-- 159 dists carry the key, 100 non-empty, 608 editions, every one a single
-- pinnacle_catalog render). Validated 2026-10-19 ~8:55 PM PT against the complete open
-- history: of 31,495 pulls over 66 listed dists in the last 400 days, 27,900 are named on
-- chain and ALL 27,900 are in their dist's list (0 dists with an off-list pull).
--
-- WHAT. One row per listed pin: name, set, edition type, mint size, image, catalog FMV,
-- and the OBSERVED pull count from pinnacle_pack_opens (complete open history; a pull is
-- counted by its mint event's editionID, else the on-chain read at the open — the first
-- two rungs of the pricing lane's ladder), plus the dist's named-pull total. That is a
-- measured share of what was pulled so far, NOT pull odds: there is no weight data, and
-- the page labels it so. An unnamed pull counts toward neither column.
--
-- REVERT: DROP FUNCTION public.get_pinnacle_dist_contents(text);
--
-- Superseded the same evening by …_pinnacle_dist_contents_includes_observed_pins.sql
-- (adds pins seen in pulls, for the dists that carry no list).
--
-- anon-exec: no (get_pinnacle_dist_contents) — EXECUTE revoked from PUBLIC, anon and authenticated; service_role only (read by the pack page through the service-role client).

CREATE OR REPLACE FUNCTION public.get_pinnacle_dist_contents(p_dist_id text)
 RETURNS TABLE(render_id text, pin_name text, set_name text, edition_type text, total_minted integer, thumbnail_url text, fmv_usd numeric, pulls_observed bigint, pulls_named_total bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH listed AS (
    SELECT DISTINCT e.eid
      FROM public.pack_distributions pd
      CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(pd.metadata->'edition_ids') = 'array' THEN pd.metadata->'edition_ids' ELSE '[]'::jsonb END
      ) AS e(eid)
     WHERE pd.collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714'
       AND pd.dist_id = p_dist_id
  ),
  pulled AS (
    SELECT COALESCE(m.edition_id, cr.edition_id)::text AS eid
      FROM public.pinnacle_pack_opens o
      CROSS JOIN LATERAL unnest(o.nft_ids) AS u(nft_id)
      LEFT JOIN public.pinnacle_mint_events m ON m.nft_id = u.nft_id
      LEFT JOIN LATERAL (
        SELECT r.edition_id FROM public.pinnacle_pull_chain_reads r
         WHERE m.nft_id IS NULL AND r.nft_id = u.nft_id
      ) cr ON true
     WHERE o.dist_id = p_dist_id
  ),
  counts AS (
    SELECT eid, count(*) AS n FROM pulled WHERE eid IS NOT NULL GROUP BY eid
  ),
  total AS (
    SELECT COALESCE(sum(n), 0)::bigint AS t FROM counts
  )
  SELECT c.render_id, c.character_name, c.set_name, c.edition_type, c.total_minted,
         c.thumbnail_url, c.fmv_usd, COALESCE(k.n, 0)::bigint, t.t
    FROM listed l
    JOIN public.pinnacle_catalog c ON c.edition_id = l.eid
    LEFT JOIN counts k ON k.eid = l.eid
    CROSS JOIN total t
   ORDER BY c.fmv_usd DESC NULLS LAST, c.render_id;
$function$;

REVOKE ALL ON FUNCTION public.get_pinnacle_dist_contents(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_pinnacle_dist_contents(text) TO service_role;
