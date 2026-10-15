-- 2026-10-15 (Claude Code cloud). get_edition_high_offer: read the All Day floor view for THIS edition only.
--
-- WHY. get_edition_market_bundle (every edition page, all collections) was the estate's #1 consumer:
-- 701,722 calls at 182 ms / 9,099 blocks per call (pg_stat_statements, 10-15), ~50 calls/min. Split by
-- part, get_edition_high_offer was ~all of it (77.8 of 78.2 ms). Its last join,
-- `LEFT JOIN allday_edition_floor_ask afa ON afa.edition_id = ed.id`, could not be pushed into the view's
-- DISTINCT ON (a reference to another relation is not pushdown-safe), so EVERY call built the whole All Day
-- floor book: 29,271 listings sorted + deduped, 6,312 buffers, ~73 ms — including for Top Shot / Panini
-- editions, which can never match it. Filtering on the PARAMETER (a Param IS pushdown-safe) makes it an
-- index probe (idx_cl_v2_edition).
--
-- EQUIVALENCE. `ed` is exactly the editions row `id = p_edition_id`, and the view holds at most one row per
-- edition_id, so the lateral returns what the join matched. Compared old vs new on 470 editions (150 All Day
-- with a floor ask, 60 All Day sampled, 80 Top Shot base, 60 Top Shot parallels, 120 Panini/Candy/UFC):
-- 0 differences. Timing, 40 mixed editions, same session: 57.0 -> 3.3 ms/call.
--
-- Only the final join changes; the rest of the body is byte-identical to the live one (md5 875b93eb...).
-- anon-exec: intentional — same signature, ACL unchanged (postgres, service_role) (get_edition_high_offer)
-- REVERT: re-apply this function with its last line restored to
--   `LEFT JOIN allday_edition_floor_ask afa ON afa.edition_id = ed.id;` (live md5 875b93eb1dad8e669c54d965d236ee4e).
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
         ELSE COALESCE(afa.floor_ask, base_x.low_ask) END AS low_ask,
    CASE WHEN ed.is_sub THEN
      CASE WHEN COALESCE(par.amt, 0) >= COALESCE(chain_ed.amt, 0) THEN COALESCE(par.at, chain_ed.at)
           ELSE COALESCE(chain_ed.at, par.at) END
    ELSE
      CASE WHEN afa.floor_ask IS NOT NULL AND (base_x.low_ask IS NULL OR afa.floor_ask <= base_x.low_ask)
           THEN afa.floor_ask_listed_at
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
    SELECT f.floor_ask, f.floor_ask_listed_at
    FROM allday_edition_floor_ask f
    WHERE f.edition_id = p_edition_id
  ) afa ON true;
$function$;
