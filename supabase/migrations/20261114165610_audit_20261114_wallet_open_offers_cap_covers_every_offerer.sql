-- audit_20261114_wallet_open_offers_cap_covers_every_offerer
--
-- Follow-up to 20261114161212 (#12361). The requester (mxtthxw) has 1,668 open Top Shot offers; the
-- function capped at 500, so the card's outbid / stale / at-floor flags covered under a third of the
-- book the feature exists to manage. The cap becomes 3000: every wallet measured on 2026-11-14 (the
-- heaviest has 2,208 open) is covered whole.
--
-- Cost, measured before writing this (pg_temp copy, cap 3000, heaviest wallet, all 2,208 rows):
-- 30.1k buffers / 918 ms COLD (2.0k reads); the 500-row body was 11.1k / 42 ms warm. Inside the
-- route's 8 s bounded read.
--
-- ONLY the cap changes. Base verified before writing: live prosrc md5(normalized) 4c7bb46a…
-- = 20261114161212's body. CREATE OR REPLACE keeps the ACL.
-- anon-exec: unchanged (get_topshot_wallet_open_offers) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false.
--
-- Revert: re-apply the function block of 20261114161212 (cap 500).

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
  v_limit int := least(greatest(coalesce(p_limit, 200), 1), 3000);
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
