-- audit_20261020_golazos_edition_ask_reads_the_onchain_floor
--
-- 2026-10-20 (Claude Code cloud). Golazos edition pages get their Lowest Ask from the on-chain floor, dated by
-- its last on-chain verification. Follow-on to 20261021003446 (All Day, same evening).
--
-- WHY. get_edition_high_offer read the All Day floor view but not Golazos': for a Golazos base edition the ask
-- came only from edition_offers / badge_editions. Measured 10-20 ~5:55 PM PT on 400 Golazos editions WITH a
-- live floor in golazos_edition_floor_ask: 275 got NO low_ask from the RPC, and on the other 125 (all equal to
-- the floor) the stamp was a badge-sync time that the page worded "listed N ago" (0 of 125 equal to the
-- listing's listed_at). The Golazos book is reconciled on chain every 2 h by
-- golazos-storefront-reconcile: all 496 floor listings carry verified_at, p90 age 1.9 h (read 10-20).
--
-- WHAT.
--  1. golazos_edition_floor_ask gains a LAST column floor_ask_verified_at (freshest verified_at over the floor
--     listing's open rows), as a scalar subquery so callers that do not read it pay nothing; existing columns,
--     order and ORDER BY unchanged; security_invoker re-asserted.
--  2. get_edition_high_offer: low_ask = COALESCE(afa.floor_ask, gfa.floor_ask, base_x.low_ask); the stamp is
--     gfa.floor_ask_verified_at when gfa supplies the ask. An edition belongs to one collection, so afa and gfa
--     are never both non-null. Other collections unchanged. Body otherwise byte-identical to 20261021003446.
--  App (same push): askStampKind("laliga_golazos") -> "checked"; the Market tab's Golazos rows lose their
--  "listed" stamp (it dated the edition's NEWEST listing, never the floor shown).
--
-- anon-exec: intentional — same signature, ACL unchanged (postgres, service_role) (get_edition_high_offer)
--
-- REVERT: re-apply the get_edition_high_offer block of 20261021003446. The view column can stay (unread).

CREATE OR REPLACE VIEW public.golazos_edition_floor_ask WITH (security_invoker = on) AS
 SELECT d.edition_id,
    d.floor_ask,
    d.floor_ask_listed_at,
    d.floor_listing_resource_id,
    d.floor_flow_id,
    ( SELECT max(t.verified_at) AS max
           FROM cached_listings_v2 t
          WHERE ((t.listing_resource_id = d.floor_listing_resource_id) AND (t.collection_id = '06248cc4-b85f-47cd-af67-1855d14acd75'::uuid) AND (t.completed_at IS NULL))) AS floor_ask_verified_at
   FROM ( SELECT DISTINCT ON (cl.edition_id) cl.edition_id,
            cl.price_usd AS floor_ask,
            cl.listed_at AS floor_ask_listed_at,
            cl.listing_resource_id AS floor_listing_resource_id,
            cl.flow_id AS floor_flow_id
           FROM cached_listings_v2 cl
          WHERE ((cl.collection_id = '06248cc4-b85f-47cd-af67-1855d14acd75'::uuid) AND (cl.completed_at IS NULL) AND (cl.price_usd > (0)::numeric) AND ((cl.expiry_at IS NULL) OR (cl.expiry_at > now())) AND (cl.edition_id IS NOT NULL))
          ORDER BY cl.edition_id, cl.price_usd, cl.listed_at DESC) d;

COMMENT ON COLUMN public.golazos_edition_floor_ask.floor_ask_verified_at IS
  'When the floor listing was last VERIFIED open on chain (freshest verified_at over its open rows; golazos-storefront-reconcile every 2 h). NULL = never verified. floor_ask_listed_at is when the seller POSTED it.';

CREATE OR REPLACE FUNCTION public.get_edition_high_offer(p_edition_id uuid)
 RETURNS TABLE(highest_offer numeric, low_ask numeric, updated_at timestamp with time zone, offer_scope text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH ed AS (
    SELECT id, external_id, collection_id,
           (external_id LIKE '%::%') AS is_sub,
           split_part(external_id, '::', 1) AS base_ext
    FROM editions WHERE id = p_edition_id
  ),
  -- The edition's OWN GQL marketplace row (per-printing for :: rows).
  own AS (
    SELECT eo.highest_offer, eo.low_ask, eo.updated_at
    FROM edition_offers eo JOIN ed ON eo.external_id = ed.external_id AND eo.collection_id = ed.collection_id
  ),
  -- Base-pair fallback (edition_offers then badge_editions) — base pages only.
  base_x AS (
    SELECT x.highest_offer, x.low_ask, x.updated_at
    FROM ed
    LEFT JOIN LATERAL (
      SELECT eo.highest_offer, eo.low_ask, eo.updated_at, 1 AS pri
      FROM edition_offers eo
      WHERE eo.external_id = ed.base_ext AND eo.collection_id = ed.collection_id
      UNION ALL
      SELECT be.highest_offer, be.low_ask, be.updated_at, 2 AS pri
      FROM badge_editions be
      WHERE be.external_id = ed.base_ext AND be.collection_id = ed.collection_id
      ORDER BY pri
      LIMIT 1
    ) x ON true
  ),
  -- This printing's own on-chain standing subedition offers.
  chain_sub AS (
    SELECT max(o.offer_amount_usd) AS amt, max(o.created_at) AS at
    FROM ed
    JOIN offers o ON o.edition_id = ed.id
    WHERE ed.is_sub AND o.status = 'open' AND o.offer_type = 'subedition' AND o.offer_amount_usd > 0
  ),
  -- True edition-grain standing offer on-chain (fillable by ANY printing).
  chain_ed AS (
    SELECT max(o.offer_amount_usd) AS amt, max(o.created_at) AS at
    FROM ed
    JOIN editions b ON b.collection_id = ed.collection_id AND b.external_id = ed.base_ext
    JOIN offers o ON o.edition_id = b.id
    WHERE ed.is_sub AND o.status = 'open' AND o.offer_type = 'edition' AND o.offer_amount_usd > 0
  ),
  par AS (
    SELECT
      CASE WHEN own.highest_offer IS NULL AND chain_sub.amt IS NULL THEN NULL
           ELSE GREATEST(COALESCE(own.highest_offer, 0), COALESCE(chain_sub.amt, 0)) END AS amt,
      CASE WHEN COALESCE(own.highest_offer, 0) >= COALESCE(chain_sub.amt, 0)
           THEN COALESCE(own.updated_at, chain_sub.at) ELSE COALESCE(chain_sub.at, own.updated_at) END AS at
    FROM own FULL JOIN chain_sub ON true
  )
  SELECT
    CASE WHEN ed.is_sub THEN
      CASE WHEN par.amt IS NULL AND chain_ed.amt IS NULL THEN NULL
           ELSE GREATEST(COALESCE(par.amt, 0), COALESCE(chain_ed.amt, 0)) END
    ELSE base_x.highest_offer END AS highest_offer,
    CASE WHEN ed.is_sub THEN own.low_ask
         ELSE COALESCE(afa.floor_ask, gfa.floor_ask, base_x.low_ask) END AS low_ask,
    CASE WHEN ed.is_sub THEN
      CASE WHEN COALESCE(par.amt, 0) >= COALESCE(chain_ed.amt, 0) THEN COALESCE(par.at, chain_ed.at)
           ELSE COALESCE(chain_ed.at, par.at) END
    ELSE
      -- 2026-10-20: the stamp describes the ask returned above. low_ask takes afa.floor_ask whenever it
      -- exists, so the stamp does too (the old `afa <= base_x.low_ask` test could date afa's ask with
      -- base_x's stamp). And it is when the floor listing was last VERIFIED on chain, not when it was posted.
      -- 2026-10-20 (later): Golazos the same way, from its own on-chain floor view.
      CASE WHEN afa.floor_ask IS NOT NULL THEN afa.floor_ask_verified_at
           WHEN gfa.floor_ask IS NOT NULL THEN gfa.floor_ask_verified_at
           ELSE base_x.updated_at END
    END AS updated_at,
    CASE WHEN NOT ed.is_sub THEN 'edition'
         WHEN par.amt IS NULL AND chain_ed.amt IS NULL THEN NULL
         WHEN COALESCE(par.amt, 0) >= COALESCE(chain_ed.amt, 0) THEN 'parallel'
         ELSE 'edition' END AS offer_scope
  FROM ed
  LEFT JOIN own ON true
  LEFT JOIN base_x ON true
  LEFT JOIN par ON true
  LEFT JOIN chain_ed ON true
  -- 2026-10-15: filtered on the PARAMETER, inside a LATERAL. Joined as
  -- `afa.edition_id = ed.id` the planner cannot push the filter into the view's
  -- DISTINCT ON (a reference to another relation is not pushdown-safe; a Param
  -- is), so it built the whole All Day floor book on every call — 29k listings,
  -- ~6.3k buffers, ~57-73 ms — for EVERY collection's edition page, which made
  -- get_edition_market_bundle the estate's #1 consumer (9.1k blocks/call). `ed`
  -- is exactly the row `id = p_edition_id`, and the view holds at most one row
  -- per edition_id, so the result is identical (compared on 470 editions — All Day
  -- with and without a floor, Top Shot base and parallels, Panini/Candy/UFC — 0 differences). Measured 57.0 -> 3.3 ms/call.
  LEFT JOIN LATERAL (
    SELECT f.floor_ask, f.floor_ask_verified_at
    FROM allday_edition_floor_ask f
    WHERE f.edition_id = p_edition_id
  ) afa ON true
  -- 2026-10-20: Golazos' on-chain floor, filtered on the Param for the same pushdown reason.
  LEFT JOIN LATERAL (
    SELECT g.floor_ask, g.floor_ask_verified_at
    FROM golazos_edition_floor_ask g
    WHERE g.edition_id = p_edition_id
  ) gfa ON true;
$function$;
