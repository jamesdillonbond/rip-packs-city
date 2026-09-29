-- 2026-09-29 (PT): Disney Pinnacle pack opens from BEFORE the 2025-12-29 spork could never be priced.
--
-- price_pinnacle_pack_opens() names each pulled pin through pinnacle_mint_events (nft_id -> render_id),
-- and that table starts at the spork floor (2025-12-29). So every open older than that — 70,808 of the
-- 73,376 unpriced opens — had NO path to a value, and the wallet pack history showed them all without one
-- (a seeded whale: 226 of 226 Pinnacle opens unpriced, 2023-12 .. 2025-12).
--
-- (1) A second, independent source for the pin: wallet_moments_cache.render_id, the pin a wallet walk
--     read from the NFT itself. Measured: on the 11,433 pins BOTH sources name, they agree 11,433 / 11,433
--     (0 disagreements), and no Pinnacle moment_id sits on two cache rows with different render_ids. The
--     mint event still wins where it exists; the cache is read only when it does not, is scoped to the
--     Pinnacle collection (a moment_id is unique only within a collection), and is used only when every
--     cache row for that id names ONE render. The pack is still priced only when EVERY pull resolves and
--     is priced (unchanged — never a partial sum). Measured before shipping: 2,652 packs newly priceable
--     estate-wide (175 of that whale's 226).
--
-- (2) The retry order. Candidates were taken newest-first (opened_at DESC), 3,000 a run, 2 runs/h, each
--     re-eligible 6 h after its last try: ~36k tries per 6 h against ~73k unpriced rows, so the newest
--     half was re-read every cycle and the OLDEST half — exactly the pre-spork opens this fix can now
--     price — was never reached again. Candidates now go LEAST-RECENTLY-TRIED first (priced_at NULLS
--     FIRST, a column this job writes), newest open as the tiebreak, so every unpriced row is revisited.
--
-- Revert: re-run the CREATE OR REPLACE FUNCTION public.price_pinnacle_pack_opens block from
--   supabase/migrations/20260924050538_audit_20260923_pinnacle_pack_opens_and_mint_batch_view_retracted.sql
--   and, to un-price what this version priced:
--   UPDATE public.pinnacle_pack_opens o SET pull_value_usd = NULL
--    WHERE o.pull_value_usd IS NOT NULL
--      AND EXISTS (SELECT 1 FROM unnest(o.nft_ids) u(nft_id)
--                   WHERE NOT EXISTS (SELECT 1 FROM public.pinnacle_mint_events m WHERE m.nft_id = u.nft_id));

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
    -- the pin: its mint event, else the pin a wallet walk read off the NFT (pre-spork opens)
    SELECT p.pack_nft_id, p.moments_pulled, COALESCE(m.render_id, w.render_id) AS render_id
      FROM pulls p
      LEFT JOIN public.pinnacle_mint_events m ON m.nft_id = p.nft_id
      LEFT JOIN LATERAL (
        SELECT min(wm.render_id) AS render_id
          FROM public.wallet_moments_cache wm
         WHERE m.render_id IS NULL
           AND wm.collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid
           AND wm.moment_id = p.nft_id
           AND wm.render_id IS NOT NULL
        HAVING count(DISTINCT wm.render_id) = 1
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
