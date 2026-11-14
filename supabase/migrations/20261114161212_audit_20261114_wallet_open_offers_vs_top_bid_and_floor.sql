-- audit_20261114_wallet_open_offers_vs_top_bid_and_floor
--
-- Feedback #12361 (mxtthxw): "my open offers" — each OPEN Top Shot offer a wallet has made,
-- set against the best competing bid and the edition floor, so the analytics Offers card can
-- flag outbid / superseded / at-or-above-floor rows.
--
-- One row per open offer by p_wallet (already a normalized Flow address — the route passes
-- normalizeAddress() output; this function does NOT re-case it), newest first, capped at
-- least(p_limit, 500).
--
--   top_other_bid    highest OPEN offer by ANOTHER wallet on the same target. Edition / subedition
--                    offers: non-serial offers on the same edition_id (97 % of subedition offers
--                    already resolve to the parallel edition, so one edition_id is like-for-like).
--                    Serial offers: the greater of other open serial offers on the same moment and
--                    other open edition/subedition offers on its edition — an owner can accept either.
--   own_higher_usd   the SAME wallet's higher open offer on that target (render "superseded by your
--                    $X", never "outbid"); NULL when none is strictly higher.
--   floor_usd        edition_offers.low_ask (+ low_ask_confirmed_at). NULL = unknown, never 0.
--   serial_ask_usd   serial offers only: a listing of that exact Moment seen in ts_listings (the
--                    Atlas 24 h change window, NOT the book). POSITIVE ONLY: NULL means "not seen",
--                    never "not listed".
--
-- Step 0 (2026-11-14 ~8:05 AM PT): "open" was checked against the Atlas offer book before shipping.
-- 10 oldest open: 8 matched Atlas completed=false, 2 unmatched, 0 closed. Random 300 of the open
-- offers older than 90 days: 279 Atlas-open, 2 Atlas-closed, 19 unmatched. So status='open' is shown
-- as open.
--
-- SECURITY INVOKER; the route calls it through supabaseAdmin (service_role).
-- anon-exec: false (get_topshot_wallet_open_offers) — revoked FROM PUBLIC, anon, authenticated below; service_role only.
--
-- Revert: drop function public.get_topshot_wallet_open_offers(text, int);

CREATE OR REPLACE FUNCTION public.get_topshot_wallet_open_offers(p_wallet text, p_limit int DEFAULT 200)
RETURNS TABLE (
  offer_id text,
  offer_type text,
  amount_usd numeric,
  created_at timestamptz,
  edition_id uuid,
  external_id text,
  player_name text,
  set_name text,
  tier text,
  parallel text,
  serial_number int,
  top_other_bid numeric,
  own_higher_usd numeric,
  floor_usd numeric,
  floor_confirmed_at timestamptz,
  serial_ask_usd numeric,
  serial_ask_seen_at timestamptz,
  age_days numeric
)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public, pg_temp
AS $fn$
DECLARE
  c_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_limit int := least(greatest(coalesce(p_limit, 200), 1), 500);
BEGIN
  IF p_wallet IS NULL OR btrim(p_wallet) = '' THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH mine AS MATERIALIZED (
    SELECT o.offer_id, o.offer_type, o.offer_amount_usd, o.created_at, o.edition_id, o.moment_id, o.serial_number
      FROM public.offers o
     WHERE o.collection_id = c_ts
       AND o.buyer_address = p_wallet
       AND o.status = 'open'
     ORDER BY o.created_at DESC, o.offer_id DESC
     LIMIT v_limit
  ),
  ed_comp AS (
    SELECT x.edition_id,
           max(x.offer_amount_usd) FILTER (WHERE x.buyer_address <> p_wallet) AS top_other,
           max(x.offer_amount_usd) FILTER (WHERE x.buyer_address = p_wallet)  AS own_top
      FROM public.offers x
     WHERE x.collection_id = c_ts
       AND x.status = 'open'
       AND x.offer_type <> 'serial'
       AND x.edition_id IN (SELECT m.edition_id FROM mine m WHERE m.edition_id IS NOT NULL)
     GROUP BY x.edition_id
  ),
  ser_comp AS (
    SELECT x.moment_id,
           max(x.offer_amount_usd) FILTER (WHERE x.buyer_address <> p_wallet) AS top_other,
           max(x.offer_amount_usd) FILTER (WHERE x.buyer_address = p_wallet)  AS own_top
      FROM public.offers x
     WHERE x.collection_id = c_ts
       AND x.status = 'open'
       AND x.offer_type = 'serial'
       AND x.moment_id IN (SELECT m.moment_id FROM mine m WHERE m.offer_type = 'serial' AND m.moment_id IS NOT NULL)
     GROUP BY x.moment_id
  )
  SELECT m.offer_id::text,
         m.offer_type::text,
         m.offer_amount_usd,
         m.created_at,
         m.edition_id,
         e.external_id::text,
         e.player_name,
         e.set_name,
         e.tier::text,
         e.subedition_name,
         coalesce(m.serial_number, mo.serial_number),
         CASE WHEN m.offer_type = 'serial' THEN greatest(sc.top_other, ec.top_other) ELSE ec.top_other END,
         CASE
           WHEN m.offer_type = 'serial' THEN
             CASE WHEN greatest(sc.own_top, ec.own_top) > m.offer_amount_usd THEN greatest(sc.own_top, ec.own_top) END
           ELSE
             CASE WHEN ec.own_top > m.offer_amount_usd THEN ec.own_top END
         END,
         eo.low_ask,
         eo.low_ask_confirmed_at,
         sa.ask_usd,
         sa.seen_at,
         round((extract(epoch FROM (now() - m.created_at)) / 86400.0)::numeric, 1)
    FROM mine m
    LEFT JOIN ed_comp ec ON ec.edition_id = m.edition_id
    LEFT JOIN ser_comp sc ON sc.moment_id = m.moment_id AND m.offer_type = 'serial'
    LEFT JOIN public.editions e ON e.id = m.edition_id
    LEFT JOIN public.edition_offers eo ON eo.collection_id = e.collection_id AND eo.external_id = e.external_id
    LEFT JOIN public.moments mo ON mo.id = m.moment_id AND m.offer_type = 'serial'
    LEFT JOIN LATERAL (
      SELECT min(l.price_usd) AS ask_usd, max(l.ingested_at) AS seen_at
        FROM public.ts_listings l
       WHERE mo.nft_id IS NOT NULL
         AND l.flow_id = mo.nft_id::text
    ) sa ON m.offer_type = 'serial'
   ORDER BY m.created_at DESC, m.offer_id DESC;
END
$fn$;

REVOKE EXECUTE ON FUNCTION public.get_topshot_wallet_open_offers(text, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_topshot_wallet_open_offers(text, int) TO postgres, service_role;

COMMENT ON FUNCTION public.get_topshot_wallet_open_offers(text, int) IS
  'Feedback #12361: a wallet''s open Top Shot offers vs the best other-wallet bid, its own higher bid, the edition floor and (serial) a seen listing. NULL floor/ask = unknown. service_role only.';
