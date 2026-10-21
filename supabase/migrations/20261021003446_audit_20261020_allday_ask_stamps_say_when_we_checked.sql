-- audit_20261020_allday_ask_stamps_say_when_we_checked
--
-- 2026-10-20 (Claude Code cloud). All Day asks are dated by when we last VERIFIED the floor listing on
-- chain, not by when the seller POSTED it. Roadmap nfl-all-day.md "Next" item 1 (scoped out 10-20, Cowork).
--
-- WHY. Every open All Day row in cached_listings_v2 carries `verified_at` (allday-storefront-reconcile
-- every 2 h for storefront_v2/direct_v2; pg_cron 762 `allday_v1_reverify_tick` weekly for direct_v1; read
-- 10-20 ~5:40 PM PT: 46 NULL of 28,995 open, 38 of them direct_v2 and 8 flowty). Every surface still dated
-- the ask by `listed_at` and worded it "listed N ago", which says nothing about whether the ask is still
-- there; the deals board excluded All Day from its staleness marker entirely because the view had "no
-- verification column to use instead". It has one now.
--
-- WHAT.
--  1. allday_edition_floor_ask gains a LAST column, floor_ask_verified_at = the freshest verified_at of any
--     OPEN row for the floor listing. The max is load-bearing: 594 open storefront_v2 rows (61 sellers,
--     oldest stamp 09-26) are twins of an open direct_v2 row for the SAME listing_resource_id, and the
--     reconciler re-stamps only the direct_v2 twin (read 10-20: all 594 twins' siblings verified at the
--     23:15Z run). The floor row the DISTINCT ON picks can be the stale twin.
--     It is a scalar subquery in the outer target list, NOT a lateral join, so a caller that does not
--     select the column pays nothing (Postgres drops unused subquery outputs). Measured on the full book:
--     baseline 5,283 buffers; lateral form 24,187; this form 5,283 when unread, +~4 per floor row when read.
--     Per-edition probe (get_edition_high_offer's Param path) still pushes into the DISTINCT ON: 45 buffers.
--     Existing columns, order and the ORDER BY are unchanged, so floor_flow_id and every reader's
--     values are identical. security_invoker re-asserted (CREATE OR REPLACE VIEW resets reloptions).
--  2. get_edition_high_offer (edition page "Lowest Ask" sub-stamp; moment pages): for a base edition the
--     stamp is afa.floor_ask_verified_at whenever afa supplies the ask. It previously returned base_x's
--     stamp when base_x.low_ask < afa.floor_ask, although low_ask is COALESCE(afa.floor_ask, ...) and so is
--     ALWAYS afa's when afa exists. Only All Day editions have an afa row; every other collection's output
--     is unchanged. (All Day editions with a badge low_ask and no afa row: 0, read 10-20.)
--     Body otherwise byte-identical to 20261015223418 (live prosrc md5 233984c3740e7c052368a15d322a79e9).
--  3. mv_cross_collection_deals: the All Day arm's ask_updated_at becomes af.floor_ask_verified_at, so the
--     deals board's 12 h staleness marker and deal alerts (build_deal_alerts_for_subscription and
--     dispatch_due_deal_alerts read cross_collection_deals_board) describe a check, as on the Top Shot,
--     Pinnacle and Candy arms. Every other arm is byte-identical to 20260919184828. Materialized views have
--     no CREATE OR REPLACE, so the MV is rebuilt by a rename-swap (see the block below), with the unique
--     index (REFRESH ... CONCURRENTLY needs it) and its ACL re-asserted as it was live: postgres +
--     service_role only (a recreate hands anon a grant back: 20260919190531). The board view is repointed
--     by CREATE OR REPLACE, which keeps its grants; security_invoker re-asserted.
--
-- The app side (same push): askStampKind("nfl_all_day") -> "checked"; the deals board drops its All Day
-- exclusion; the Market tab stops stamping All Day rows with the edition's NEWEST listing's posted date
-- (it never described the floor ask shown beside it).
--
-- anon-exec: intentional — same signature, ACL unchanged (postgres, service_role) (get_edition_high_offer)
--
-- REVERT (exact): re-apply 20261015223418 (get_edition_high_offer); swap the MVs back
--   (ALTER ... mv_cross_collection_deals RENAME TO mv_cross_collection_deals_new; ALTER INDEX ..._key
--   likewise; ALTER ... mv_cross_collection_deals_pre20261020 RENAME TO mv_cross_collection_deals; its
--   index back to mv_cross_collection_deals_key; CREATE OR REPLACE the board view; REFRESH it), or if the
--   old MV was already dropped re-run the MV/board block of 20260919184828 + 20260919190415 +
--   20260919190531; then re-run the view body of 20260922205752 WITH (security_invoker = on) (the added
--   column must go via DROP VIEW ... CASCADE then, so prefer leaving it). Derived objects only.

CREATE OR REPLACE VIEW public.allday_edition_floor_ask WITH (security_invoker = on) AS
 SELECT d.edition_id,
    d.floor_ask,
    d.floor_ask_listed_at,
    d.floor_listing_resource_id,
    d.floor_flow_id,
    ( SELECT max(t.verified_at) AS max
           FROM cached_listings_v2 t
          WHERE ((t.listing_resource_id = d.floor_listing_resource_id) AND (t.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid) AND (t.completed_at IS NULL))) AS floor_ask_verified_at
   FROM ( SELECT DISTINCT ON (cl.edition_id) cl.edition_id,
            cl.price_usd AS floor_ask,
            cl.listed_at AS floor_ask_listed_at,
            cl.listing_resource_id AS floor_listing_resource_id,
            cl.flow_id AS floor_flow_id
           FROM cached_listings_v2 cl
          WHERE ((cl.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid) AND (cl.completed_at IS NULL) AND (cl.price_usd > (0)::numeric) AND ((cl.expiry_at IS NULL) OR (cl.expiry_at > now())) AND (cl.edition_id IS NOT NULL) AND (NOT (EXISTS ( SELECT 1
                   FROM allday_listings_sold_after_listing g
                  WHERE ((g.listing_resource_id = cl.listing_resource_id) AND (g.source = cl.source))))))
          ORDER BY cl.edition_id, cl.price_usd, cl.listed_at DESC) d;

COMMENT ON COLUMN public.allday_edition_floor_ask.floor_ask_verified_at IS
  'When the floor listing was last VERIFIED open on chain (freshest verified_at over its open rows; storefront_v2/direct_v2 every 2 h, direct_v1 weekly). NULL = never verified. floor_ask_listed_at is when the seller POSTED it.';

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
      -- 2026-10-20: the stamp describes the ask returned above. low_ask takes afa.floor_ask whenever it
      -- exists, so the stamp does too (the old `afa <= base_x.low_ask` test could date afa's ask with
      -- base_x's stamp). And it is when the floor listing was last VERIFIED on chain, not when it was posted.
      CASE WHEN afa.floor_ask IS NOT NULL
           THEN afa.floor_ask_verified_at
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
  ) afa ON true;
$function$;

-- RENAME-SWAP, not DROP/CREATE: the Supabase MCP holds any DROP for a human confirmation, and this was
-- applied unattended. The old MV is renamed aside (with its index, whose name the new one reuses), the
-- new one is created under the real name, and the board view is repointed by CREATE OR REPLACE (which
-- keeps its grants). mv_cross_collection_deals_pre20261020 is then an unrefreshed 136 kB orphan with no
-- readers; drop it in an attended session:
--   DROP MATERIALIZED VIEW public.mv_cross_collection_deals_pre20261020;
ALTER MATERIALIZED VIEW public.mv_cross_collection_deals RENAME TO mv_cross_collection_deals_pre20261020;
ALTER INDEX public.mv_cross_collection_deals_key RENAME TO mv_cross_collection_deals_pre20261020_key;

CREATE MATERIALIZED VIEW public.mv_cross_collection_deals AS
 SELECT t.external_id,
    t.name,
    t.player_name,
    t.set_name,
    t.tier::text AS tier,
    t.circulation_count,
    t.fmv_usd,
    t.confidence::text AS confidence,
    t.low_ask,
    t.discount_pct,
    t.discount_usd,
    t.ask_updated_at,
    'nba_top_shot'::text AS collection_slug,
    'NBA Top Shot'::text AS collection_name,
    NULL::text AS render_id,
    '/nba-top-shot/edition/'::text || replace(t.external_id::text, ':'::text, '%3A'::text) AS detail_url,
    NULL::text AS thumbnail_url,
    t.low_ask_serial,
    t.low_ask_nft_id,
    t.low_confidence_fmv
   FROM topshot_deals_vs_fmv t
UNION ALL
 SELECT pc.render_id AS external_id,
    (pc.character_name || ' — '::text) || pc.set_name AS name,
    pc.character_name AS player_name,
    pc.set_name,
    pc.variant AS tier,
    pc.total_minted AS circulation_count,
    pc.fmv_usd,
    pc.fmv_confidence::text AS confidence,
    pc.floor_ask AS low_ask,
    round((pc.fmv_usd - pc.floor_ask) / pc.fmv_usd * 100::numeric, 1) AS discount_pct,
    round(pc.fmv_usd - pc.floor_ask, 2) AS discount_usd,
    pc.floor_ask_updated_at AS ask_updated_at,
    'disney_pinnacle'::text AS collection_slug,
    'Disney Pinnacle'::text AS collection_name,
    pc.render_id,
    '/pinnacle/moment/'::text || pc.render_id AS detail_url,
    '/api/public/pinnacle-image/'::text || pc.render_id AS thumbnail_url,
    NULL::integer AS low_ask_serial,
    NULL::text AS low_ask_nft_id,
    false AS low_confidence_fmv
   FROM pinnacle_catalog pc
  WHERE pc.fmv_usd > 0::numeric AND pc.floor_ask >= 1::numeric AND (pc.fmv_confidence::text = ANY (ARRAY['HIGH'::text, 'MEDIUM'::text])) AND pc.fmv_sales_count_30d >= 8 AND pc.floor_ask_updated_at > (now() - '3 days'::interval) AND pc.floor_ask < pc.fmv_usd
UNION ALL
 SELECT e.external_id,
    e.name,
    e.player_name,
    e.set_name,
    e.tier::text AS tier,
    e.circulation_count,
    f.fmv_usd,
    f.confidence::text AS confidence,
    af.floor_ask AS low_ask,
    round((f.fmv_usd - af.floor_ask) / f.fmv_usd * 100::numeric, 1) AS discount_pct,
    round(f.fmv_usd - af.floor_ask, 2) AS discount_usd,
    af.floor_ask_verified_at AS ask_updated_at,
    'nfl_all_day'::text AS collection_slug,
    'NFL All Day'::text AS collection_name,
    NULL::text AS render_id,
    '/nfl-all-day/edition/'::text || replace(e.external_id::text, ':'::text, '%3A'::text) AS detail_url,
    e.thumbnail_url,
    s.serial_number AS low_ask_serial,
    af.floor_flow_id::text AS low_ask_nft_id,
    false AS low_confidence_fmv
   FROM allday_edition_floor_ask af
     JOIN editions e ON e.id = af.edition_id AND e.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
     JOIN LATERAL ( SELECT fs.fmv_usd,
            fs.confidence
           FROM fmv_snapshots fs
          WHERE fs.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid AND fs.edition_id = e.id AND fs.computed_at <= now()
          ORDER BY fs.computed_at DESC
         LIMIT 1) f ON true
     LEFT JOIN allday_moment_serials s ON s.nft_id = af.floor_flow_id::text
  WHERE f.fmv_usd > 0::numeric AND (f.confidence = ANY (ARRAY['HIGH'::fmv_confidence, 'MEDIUM'::fmv_confidence])) AND af.floor_ask >= 1::numeric AND af.floor_ask < f.fmv_usd
UNION ALL
 SELECT cd.external_id,
    cd.name,
    cd.player_name,
    cd.set_name,
    cd.tier,
    cd.circulation_count,
    cd.fmv_usd,
    cd.confidence,
    cd.low_ask,
    cd.discount_pct,
    cd.discount_usd,
    cd.ask_updated_at,
    'candy_mlb'::text AS collection_slug,
    'Candy MLB'::text AS collection_name,
    NULL::text AS render_id,
    '/candy-mlb/edition/'::text || cd.external_id AS detail_url,
    cd.thumbnail_url,
    cd.low_ask_serial,
    cd.low_ask_nft_id,
    cd.low_confidence_fmv
   FROM ( SELECT DISTINCT ON (d.external_id) d.external_id::character varying AS external_id,
            e.name,
            d.player_name,
            e.set_name,
            d.tier::text AS tier,
            d.circulation_count,
            d.fmv_usd,
            d.confidence::text AS confidence,
            d.ask_usd AS low_ask,
            d.discount_pct,
            round(d.fmv_usd - d.ask_usd, 2) AS discount_usd,
            d.last_seen_at AS ask_updated_at,
            e.thumbnail_url,
            d.serial_number AS low_ask_serial,
            d.token_mint AS low_ask_nft_id,
            COALESCE(d.sales_count, 0::bigint) < 8 AS low_confidence_fmv
           FROM candy_deals_board d
             JOIN editions e ON e.external_id::text = d.external_id::text AND e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
          WHERE d.fmv_usd > 0::numeric AND (d.confidence = ANY (ARRAY['HIGH'::text, 'MEDIUM'::text])) AND d.ask_usd >= 1::numeric AND d.ask_usd < d.fmv_usd AND d.last_seen_at > (now() - '3 days'::interval)
          ORDER BY d.external_id, d.ask_usd) cd;

CREATE UNIQUE INDEX mv_cross_collection_deals_key ON public.mv_cross_collection_deals USING btree (collection_slug, external_id);
REVOKE ALL ON public.mv_cross_collection_deals FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.mv_cross_collection_deals TO service_role;

CREATE OR REPLACE VIEW public.cross_collection_deals_board WITH (security_invoker = on) AS
 SELECT external_id,
    name,
    player_name,
    set_name,
    tier,
    circulation_count,
    fmv_usd,
    confidence,
    low_ask,
    discount_pct,
    discount_usd,
    ask_updated_at,
    collection_slug,
    collection_name,
    render_id,
    detail_url,
    thumbnail_url,
    low_ask_serial,
    low_ask_nft_id,
    low_confidence_fmv
   FROM mv_cross_collection_deals m
  WHERE (collection_slug IN ( SELECT c.slug
           FROM collections c
          WHERE c.is_active IS TRUE));
