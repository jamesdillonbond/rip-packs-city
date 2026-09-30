-- 2026-09-29 (PT, follow-up to 20260929270000): name a pre-spork Pinnacle pull from its recorded SALE or
-- live LISTING too, not only from a wallet that still holds it.
--
-- After 20260929270000, a pre-spork pull was nameable only while some cached wallet still held the pin, so a
-- pull that had since been sold on to an un-walked wallet stayed unnamed (a seeded whale: 119 of 226 opens
-- still unpriced). pinnacle_sales.render_id and pinnacle_live_listings.render_id name the exact pin by nft_id
-- (both indexed on nft_id). Measured against the mint events on every pin both know: sales 36,217 / 36,217
-- agree, listings 9,519 / 9,519, 0 disagreements, and no nft_id carries two render_ids in sales.
--
-- The fallback now pools all three secondary sources (Pinnacle wallet cache, sales, live listings) and names
-- the pin only when EVERY row across them names one render — a conflict between sources leaves it unnamed.
-- The mint event still wins where it exists; the whole-pack rule is unchanged. Measured before shipping:
-- 15,287 more packs priceable estate-wide (16,784 priced before 20260929270000), 16 more of that whale's.
--
-- Revert: re-run the CREATE OR REPLACE FUNCTION block of
--   supabase/migrations/20260929270000_audit_20260929_pinnacle_pack_opens_priced_via_held_pins.sql
--   (packs this version priced keep their value; to clear them, the un-price UPDATE in that file's header).

CREATE OR REPLACE FUNCTION public.price_pinnacle_pack_opens(p_limit integer DEFAULT 3000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE v_cand int := 0; v_priced int := 0; v_left int := 0;
BEGIN
  DROP TABLE IF EXISTS _pppo;
  CREATE TEMP TABLE _pppo ON COMMIT DROP AS
  SELECT o.pack_nft_id, o.moments_pulled, o.nft_ids
    FROM public.pinnacle_pack_opens o
   WHERE o.pull_value_usd IS NULL AND o.moments_pulled > 0
     AND (o.priced_at IS NULL OR o.priced_at < now() - interval '6 hours')
   -- least-recently-tried first: an order on a column this job writes, so no row is starved
   ORDER BY o.priced_at NULLS FIRST, o.opened_at DESC NULLS LAST
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 3000), 1), 10000);
  GET DIAGNOSTICS v_cand = ROW_COUNT;

  WITH pulls AS (
    SELECT c.pack_nft_id, c.moments_pulled, u.nft_id
      FROM _pppo c CROSS JOIN LATERAL unnest(c.nft_ids) AS u(nft_id)
  ), named AS (
    -- the pin: its mint event, else (pre-spork opens) what every other record of that nft_id names —
    -- a wallet walk, a recorded sale, a live listing — only when they all name ONE render
    SELECT p.pack_nft_id, p.moments_pulled, COALESCE(m.render_id, w.render_id) AS render_id
      FROM pulls p
      LEFT JOIN public.pinnacle_mint_events m ON m.nft_id = p.nft_id
      LEFT JOIN LATERAL (
        SELECT min(x.render_id) AS render_id
          FROM (
            SELECT wm.render_id FROM public.wallet_moments_cache wm
             WHERE wm.collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid
               AND wm.moment_id = p.nft_id AND wm.render_id IS NOT NULL
            UNION ALL
            SELECT s.render_id FROM public.pinnacle_sales s
             WHERE s.nft_id = p.nft_id AND s.render_id IS NOT NULL
            UNION ALL
            SELECT l.render_id FROM public.pinnacle_live_listings l
             WHERE l.nft_id = p.nft_id AND l.render_id IS NOT NULL
          ) x
         WHERE m.render_id IS NULL
        HAVING count(DISTINCT x.render_id) = 1
      ) w ON true
  ), pv AS (
    SELECT n.pack_nft_id, SUM(pc.fmv_usd)::numeric(14,2) AS v
      FROM named n
      LEFT JOIN public.pinnacle_catalog pc ON pc.render_id = n.render_id
     GROUP BY n.pack_nft_id, n.moments_pulled
    HAVING count(*) = count(pc.fmv_usd) AND count(*) = n.moments_pulled
  ), upd AS (
    UPDATE public.pinnacle_pack_opens o SET pull_value_usd = pv.v, priced_at = now()
      FROM pv WHERE o.pack_nft_id = pv.pack_nft_id AND o.pull_value_usd IS NULL AND pv.v > 0
    RETURNING 1
  )
  SELECT count(*) INTO v_priced FROM upd;

  UPDATE public.pinnacle_pack_opens o SET priced_at = now()
    FROM _pppo c WHERE o.pack_nft_id = c.pack_nft_id AND o.pull_value_usd IS NULL;

  SELECT count(*) INTO v_left FROM public.pinnacle_pack_opens WHERE pull_value_usd IS NULL;
  RETURN jsonb_build_object('candidates', v_cand, 'priced', v_priced, 'still_null', v_left);
END
$fn$;

REVOKE ALL ON FUNCTION public.price_pinnacle_pack_opens(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.price_pinnacle_pack_opens(integer) TO service_role, postgres;
