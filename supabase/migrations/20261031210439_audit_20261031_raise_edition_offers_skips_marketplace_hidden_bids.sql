-- audit_20261031_raise_edition_offers_skips_marketplace_hidden_bids
-- anon-exec: unchanged (raise_edition_offers_from_chain) — CREATE OR REPLACE keeps the existing ACL.
--
-- Known issue #220 (2026-10-31). The published "top offer" for Ben Simmons Holo
-- Icon (28:880) flip-flopped every hour between $180 and $18 with no market
-- event behind it. Both numbers are "true" readings of different books:
--
--   • `offers` (our on-chain DapperOffersV2 indexer) holds an open $180 edition
--     offer (id 259484746834122, since 2026-06-22) — chain-verified live on
--     2026-10-31 (`borrowOffer(offerId:).getDetails()` → purchased=false).
--   • Top Shot's own marketplace index (Atlas) walked this edition at 1:56 AM PT
--     2026-10-31 and lists exactly ONE open offer: the $18 one. The $180 offer has
--     NEVER appeared in Atlas under its resource id (0 events, any kind). Top
--     Shot hides a bid its marketplace will not honour (an unfunded Dapper balance
--     is the usual reason — the chain cannot see funding).
--
-- A collector can only ACCEPT a bid through Top Shot's UI, and Top Shot does not
-- show this one, so publishing $180 as the edition's top offer is a number
-- nobody can act on. The hourly backstop (`raise_edition_offers_from_chain`,
-- pg_cron 216 @ :34) lifted it to $180; `sync_edition_offers_from_atlas` step (b)
-- put it back to $18 at :36. 200 chain-open edition offers across the catalogue
-- are in this state (walked by Atlas after the bid landed, absent from Atlas);
-- 28:880 is the one that set a per-edition max. The other 13 editions the trust
-- leg flagged today are $1 bid-ups from this morning that Atlas DOES carry and
-- the next :34 tick raises — latency, not disagreement.
--
-- Rule (one SQL home, applied in both readers below): a chain offer counts toward
-- the published edition max ONLY unless Atlas has walked that edition AFTER the
-- offer was created AND still shows no open offer with that resource id. An offer
-- newer than the last walk is honoured as before (Atlas simply has not seen it
-- yet); an edition Atlas has never mapped or walked is honoured as before (the
-- backstop's original purpose: editions the sweep never reaches).
--
--   1. `raise_edition_offers_from_chain`: candidates are narrowed FIRST to offers
--      that would actually raise the stored value (`amount > COALESCE(stored,0)`,
--      the same predicate the ON CONFLICT guard already applies — 12 rows today
--      out of 22k open offers), then the hidden test runs per candidate as two
--      LATERAL ... LIMIT 1 probes (verified pkey; idx_tame_open_by_edition_any_kind).
--      Measured on prod before apply: 49,542 buffers / 108 ms, against the prior
--      body's ~48,300 — the first draft (EXISTS over all candidates) hashed 70k
--      Atlas offer events and cost 168k buffers / 16 s; do not "simplify" back.
--      The RAISE-ONLY contract (WHERE guard + GREATEST) is unchanged.
--   2. `v_offer_sanity_flags` (feeds `offer_edition_gap_max_usd` on the trust
--      board): a flagged edition whose TOP chain offer is marketplace-hidden is
--      dropped from the view, so the leg stops reporting a disagreement the raise
--      no longer acts on. Same columns, same order; the LATERAL probes run only
--      on the already-flagged rows (14 today). `security_invoker=on` re-set
--      because CREATE OR REPLACE VIEW resets reloptions.
--
-- Pinned: supabase/tests/raise_edition_offers_from_chain.sql (re-pointed to this
-- file; new block for the hidden / seen / unwalked cases).
--
-- Revert: re-apply the 20260816010000 body of raise_edition_offers_from_chain and
-- the 20260731145906 body of v_offer_sanity_flags (+ SET security_invoker = on).

-- >>> BEGIN verbatim raise_edition_offers_from_chain (keep byte-identical to the pin) >>>
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
  WITH cand AS MATERIALIZED (
    -- Only offers that would RAISE the stored value can matter (the ON CONFLICT
    -- guard below admits nothing else), so the marketplace-hidden test runs on a
    -- dozen rows, not 22k. #220, 2026-10-31.
    SELECT e.external_id::text AS external_id, o.offer_amount_usd, o.offer_id, o.created_at, m.atlas_edition_id
    FROM offers o
    JOIN editions e ON e.id = o.edition_id
    LEFT JOIN edition_offers eo
           ON eo.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid AND eo.external_id = e.external_id::text
    LEFT JOIN topshot_atlas_edition_map m ON m.external_id = e.external_id::text
    WHERE o.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
      AND o.status = 'open'
      AND o.offer_type NOT IN ('subedition','serial')
      AND o.offer_amount_usd > 0
      AND o.offer_amount_usd > COALESCE(eo.highest_offer, 0)
  ), chain AS (
    -- A chain offer Top Shot's own index has walked past and does not carry is a
    -- bid no collector can accept through the marketplace; it must not become the
    -- published top offer. Unwalked-since-bid and unmapped editions are honoured.
    SELECT c.external_id, max(c.offer_amount_usd) AS chain_edition_max
    FROM cand c
    LEFT JOIN LATERAL (SELECT 1 AS walked FROM topshot_atlas_edition_verified v
                        WHERE v.atlas_edition_id = c.atlas_edition_id AND v.verified_at > c.created_at
                        LIMIT 1) w ON true
    LEFT JOIN LATERAL (SELECT 1 AS seen FROM topshot_atlas_market_events ev
                        WHERE ev.product = 'nba' AND ev.atlas_edition_id = c.atlas_edition_id
                          AND ev.kind = 'offer' AND NOT ev.completed
                          AND ev.listing_resource_id = c.offer_id
                        LIMIT 1) s ON w.walked IS NOT NULL
    WHERE NOT (w.walked IS NOT NULL AND s.seen IS NULL)
    GROUP BY c.external_id
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
-- <<< END verbatim raise_edition_offers_from_chain <<<

COMMENT ON FUNCTION public.raise_edition_offers_from_chain() IS
  'Hourly backstop (pg_cron 216 @ :34): lifts edition_offers.highest_offer to the max OPEN edition-grain chain offer; RAISE-ONLY. Since 2026-10-31 (#220) it skips a chain offer that Top Shot''s own index (Atlas) has walked past and does not carry — a bid no collector can accept through the marketplace. Pinned: supabase/tests/raise_edition_offers_from_chain.sql.';

-- Same columns, same order as 20260731145906; only the trailing WHERE changes.
CREATE OR REPLACE VIEW public.v_offer_sanity_flags AS
 WITH onchain AS (
         SELECT o.edition_id,
            max(o.offer_amount_usd) AS chain_max_offer,
            count(*) AS chain_open_offers,
            bool_or(o.offer_type::text = ANY (ARRAY['subedition'::character varying, 'serial'::character varying]::text[])) AS has_sub_serial,
            (array_agg(o.created_at ORDER BY o.offer_amount_usd DESC, o.created_at DESC))[1] AS top_offer_created_at,
            (array_agg(o.offer_id ORDER BY o.offer_amount_usd DESC, o.created_at DESC))[1] AS top_offer_id
           FROM offers o
          WHERE o.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid AND o.status::text = 'open'::text
          GROUP BY o.edition_id
        ), flagged AS (
         SELECT e.external_id,
            e.player_name,
            e.name AS edition_name,
            oc.chain_open_offers,
            oc.has_sub_serial,
            oc.chain_max_offer,
            eo.highest_offer AS gql_highest_offer,
                CASE
                    WHEN eo.highest_offer IS NULL THEN 'gql_blank_chain_has'::text
                    WHEN oc.chain_max_offer > (eo.highest_offer + 0.01) THEN 'chain_exceeds_gql'::text
                    ELSE 'ok'::text
                END AS flag,
            round(oc.chain_max_offer - COALESCE(eo.highest_offer, 0::numeric), 2) AS gap_usd,
            oc.top_offer_created_at,
            eo.updated_at AS offers_refreshed_at,
            oc.top_offer_id
           FROM onchain oc
             JOIN editions e ON e.id = oc.edition_id
             LEFT JOIN edition_offers eo ON eo.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid AND eo.external_id = e.external_id::text
          WHERE eo.highest_offer IS NULL OR oc.chain_max_offer > (eo.highest_offer + 0.01)
        )
 SELECT f.external_id,
    f.player_name,
    f.edition_name,
    f.chain_open_offers,
    f.has_sub_serial,
    f.chain_max_offer,
    f.gql_highest_offer,
    f.flag,
    f.gap_usd,
    f.top_offer_created_at,
    f.offers_refreshed_at
   FROM flagged f
     LEFT JOIN topshot_atlas_edition_map m ON m.external_id = f.external_id::text
     LEFT JOIN LATERAL (SELECT 1 AS walked FROM topshot_atlas_edition_verified v
                         WHERE v.atlas_edition_id = m.atlas_edition_id AND v.verified_at > f.top_offer_created_at
                         LIMIT 1) w ON true
     LEFT JOIN LATERAL (SELECT 1 AS seen FROM topshot_atlas_market_events ev
                         WHERE ev.product = 'nba' AND ev.atlas_edition_id = m.atlas_edition_id
                           AND ev.kind = 'offer' AND NOT ev.completed
                           AND ev.listing_resource_id = f.top_offer_id
                         LIMIT 1) s ON w.walked IS NOT NULL
  -- #220 (2026-10-31): a top chain offer that Atlas walked past and does not carry
  -- is marketplace-hidden; the raise no longer publishes it, so it is not a gap.
  WHERE NOT (w.walked IS NOT NULL AND s.seen IS NULL);

ALTER VIEW public.v_offer_sanity_flags SET (security_invoker = on);

COMMENT ON VIEW public.v_offer_sanity_flags IS
'Editions where the on-chain open-offer max exceeds the surfaced edition_offers.highest_offer.
Read the two trailing columns before treating a row as a defect: if offers_refreshed_at <= top_offer_created_at, offers-sweep simply has not reached this edition since the offer landed -- that is latency, not a miss. A real surfacing failure is offers_refreshed_at > top_offer_created_at (swept, still wrong), or a top offer older than the sweep cadence with no refresh at all (sweep stalled). offer_edition_gap_max_usd applies exactly that pair of tests.
has_sub_serial=true rows are serial/subedition-grain offers that are not comparable at edition grain; the trust metric excludes them by design (920 flagged, 839 older than 2h, max gap $1,552 on 2026-07-31 -- all expected).
2026-10-31 (#220): an edition whose TOP chain offer Top Shot''s own index (Atlas) has walked past and does not carry is EXCLUDED -- that bid is marketplace-hidden (unfunded, most likely), raise_edition_offers_from_chain no longer publishes it, and a seller cannot accept it; it is a disagreement between books, not a surfacing miss.';

-- Post-flight (read-only): the one disagreement row is gone from the view and the
-- next :34 tick leaves 28:880 at Atlas''s number.
DO $$
DECLARE v_rows int;
BEGIN
  SELECT count(*) INTO v_rows FROM public.v_offer_sanity_flags WHERE external_id = '28:880';
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'post-flight: 28:880 still flagged (% rows) — the marketplace-hidden exclusion did not take', v_rows;
  END IF;
END $$;
