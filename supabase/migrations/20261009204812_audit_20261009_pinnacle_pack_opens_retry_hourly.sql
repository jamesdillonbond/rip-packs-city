-- audit_20261009_pinnacle_pack_opens_retry_hourly
--
-- price_pinnacle_pack_opens re-tries an unpriced open only after 6 hours. Measured 2026-10-09: the
-- Star Wars drop (dist 8891) opened 414 packs 9:00-9:40 AM PT; the pricer tried them at 9:46-11:16 AM
-- PT, when their 5 new renders had no FMV yet, so every pull stayed unpriced. The renders were
-- priced at 12:55 PM PT (and the full recalc now runs every 3 h, 20261009195532), but the opens
-- could not be re-tried until ~3:46-5:16 PM PT. On the day a drop opens, its pull values were blank
-- for the whole afternoon.
--
-- One change: the retry interval 6 h -> 1 h. The rest of the body is the committed body of
-- 20260930010000 VERBATIM (live prosrc md5 51ebf796ce107c45b9ae38a148a84102 = that file, read
-- 10-09 ~1:50 PM PT). Cost: the still-unpriced set is ~450 opens, each a mint-event lookup; the job
-- runs at :16 and :46, so each open is re-tried at most twice an hour instead of every 6 h.
-- Least-recently-tried order is unchanged and still pinned.
--
-- Pin: supabase/tests/price_pinnacle_pack_opens.sql (verbatim copy updated; section 8 pins the
-- 1-hour gate both ways). Drift guard re-pointed to this file.
--
-- REVERT: re-apply the price_pinnacle_pack_opens block of 20260930010000 and re-point the pin.

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
     -- re-tried hourly (was 6 h until 2026-10-09): a drop's pulls price within ~1 h of their pins gaining an FMV
     AND (o.priced_at IS NULL OR o.priced_at < now() - interval '1 hour')
   -- least-recently-tried first: an order on a column this job writes, so no row is starved
   ORDER BY o.priced_at NULLS FIRST, o.opened_at DESC NULLS LAST
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 3000), 1), 10000);
  GET DIAGNOSTICS v_cand = ROW_COUNT;

  WITH pulls AS (
    SELECT c.pack_nft_id, c.moments_pulled, u.nft_id
      FROM _pppo c CROSS JOIN LATERAL unnest(c.nft_ids) AS u(nft_id)
  ), named AS (
    -- the pin: its mint event; else its editionID read off the NFT on chain (run_pinnacle_pull_chain_lane);
    -- else what every other record of that nft_id names — a wallet walk, a recorded sale, a live
    -- listing — only when they all name ONE render
    SELECT p.pack_nft_id, p.moments_pulled, COALESCE(m.render_id, ch.render_id, w.render_id) AS render_id
      FROM pulls p
      LEFT JOIN public.pinnacle_mint_events m ON m.nft_id = p.nft_id
      LEFT JOIN LATERAL (
        SELECT pc.render_id
          FROM public.pinnacle_pull_chain_reads cr
          JOIN public.pinnacle_catalog pc ON pc.edition_id = cr.edition_id::text
         WHERE m.render_id IS NULL AND cr.nft_id = p.nft_id
      ) ch ON true
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
         WHERE m.render_id IS NULL AND ch.render_id IS NULL
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

-- anon-exec: already revoked — price_pinnacle_pack_opens is EXECUTE for service_role + postgres only (read live 10-09), and CREATE OR REPLACE keeps that ACL; its only caller is pg_cron run_price_pinnacle_pack_opens.
