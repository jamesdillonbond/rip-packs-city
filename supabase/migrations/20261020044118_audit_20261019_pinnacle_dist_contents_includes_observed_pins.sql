-- audit_20261019: get_pinnacle_dist_contents also lists pins seen in pulls
--
-- WHY. 59 of 159 Pinnacle dists carry no metadata.edition_ids (e.g. the PDS-seeded 8874
-- "Summer Sunset - Premium Distribution"), so the listed-only body (20261020043917)
-- returned nothing for them although pinnacle_pack_opens holds every pull. The body now
-- returns listed pins UNION pins observed in a pull; the page titles a dist with no list
-- "pins pulled so far" (from metadata, which it holds), never "what's inside".
-- Same signature and return type (CREATE OR REPLACE; ACL preserved).
--
-- REVERT: re-apply 20261020043917_audit_20261019_pinnacle_dist_contents_with_observed_pulls.sql.
--
-- anon-exec: unchanged (get_pinnacle_dist_contents) — CREATE OR REPLACE, same signature; ACL preserved (service_role only).

CREATE OR REPLACE (first the listed-only body,
-- then this union body, ~9:00 PM PT); this file holds the final body.
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
  -- Listed pins, plus any pin observed in a pull that the list lacks (0 measured, and
  -- the whole set for the 59 dists with no list — the page tells those apart from
  -- metadata.edition_ids, which it already holds).
  , keys AS (
    SELECT eid FROM listed
    UNION
    SELECT k.eid FROM counts k
  )
  SELECT c.render_id, c.character_name, c.set_name, c.edition_type, c.total_minted,
         c.thumbnail_url, c.fmv_usd, COALESCE(k.n, 0)::bigint, t.t
    FROM keys ky
    JOIN public.pinnacle_catalog c ON c.edition_id = ky.eid
    LEFT JOIN counts k ON k.eid = ky.eid
    CROSS JOIN total t
   ORDER BY c.fmv_usd DESC NULLS LAST, c.render_id;
$function$;
