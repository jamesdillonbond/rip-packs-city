-- audit_20261127_sold_pack_pulls_seeded_for_naming
--
-- 2026-11-27 (PT, early afternoon; Claude Code cloud; Trevor: "Keep digging and probing").
--
-- WHY: after v4 (marketplace sales recognized), Trevor's sold All Day packs showed 55 of 92 opened packs
-- with their pull IDS known but UNNAMED (e.g. 42 packs "0 of 5 priced"): the ids come from
-- moment_acquisitions (source_pack_rip_id), but no moments / allday_pack_pull row names them. Top Shot
-- sold packs had the same class (548 pulls; the at-rip chain hydrator reaches them by walking back in
-- time). The estate already has a lane that names an unnamed pull from its id --
-- collect_wallet_pack_pulls step (2) (moments, allday_pack_pull, wallet cache, sales, on-chain
-- ownership, nft->edition map, Atlas market events) and step (3) (Atlas NFTService/GetNFTs for All Day
-- and Golazos), plus run_topshot_pull_chain_lane for Top Shot at the rip block -- but it only looks in
-- pack_open_pulls, which holds the packs SAVED wallets opened.
--
-- WHAT: seed_sold_pack_pulls(p_max) copies the linked pull ids of packs a saved wallet SOLD (on-chain
-- storefront or marketplace history, Top Shot and All Day; a box's inner packs too) into
-- pack_open_pulls when at least one of them is unnamed and the pack has no pack_open_pulls rows yet.
-- Only acquisitions from the open transaction itself (the v3 mis-link rule). Edition is set where a
-- moments row already names it; the rest is named by the lanes above. Its own pg_cron job
-- (rpc-sold-pack-pull-seed, 9-59/10, 300 packs a tick) -- not folded into run_sold_pack_open_tx_reads,
-- whose 60 s budget the 39k-pack scope scan would crowd.
--
-- WRITES: pack_open_pulls (additive, ON CONFLICT DO NOTHING) -- true chain facts; the rows carry
-- resolved_via 'sold_pack_seed' until a naming lane overwrites it.
-- REVERT: SELECT cron.unschedule('rpc-sold-pack-pull-seed');
--   DELETE FROM public.pack_open_pulls WHERE resolved_via = 'sold_pack_seed';  (named rows keep
--   the naming lane's resolved_via -- find them by first_seen_at >= the apply time with an opener that
--   is not a saved wallet); DROP FUNCTION public.run_seed_sold_pack_pulls();
--   DROP FUNCTION public.seed_sold_pack_pulls(integer).

CREATE OR REPLACE FUNCTION public.seed_sold_pack_pulls(p_max integer DEFAULT 300)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_ad constant uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';
  v_n integer := 0;
BEGIN
  WITH RECURSIVE sold AS (
    SELECT pp.collection_id, pp.pack_nft_id
      FROM public.pack_purchases pp
     WHERE pp.collection_id IN (v_ts, v_ad)
       AND pp.pack_nft_id IS NOT NULL
       AND pp.custom_id IS DISTINCT FROM 'nba'
       AND pp.seller_address IN (SELECT DISTINCT wallet_addr FROM public.saved_wallets)
    UNION
    SELECT v_ts, h.pack_nft_id FROM public.topshot_pack_sales_history h
     WHERE h.purchased AND h.storefront_address IN (SELECT DISTINCT wallet_addr FROM public.saved_wallets)
    UNION
    SELECT v_ad, h.pack_nft_id FROM public.allday_pack_sales_history h
     WHERE h.purchased AND h.storefront_address IN (SELECT DISTINCT wallet_addr FROM public.saved_wallets)
  ), scope(collection_id, pack_nft_id, depth) AS (
    SELECT collection_id, pack_nft_id, 0 FROM sold
    UNION
    SELECT s.collection_id, b.pack_nft_id, s.depth + 1
      FROM scope s
      JOIN public.pack_box_contents b ON b.collection_id = s.collection_id AND b.box_pack_nft_id = s.pack_nft_id
     WHERE s.depth < 2
  ), cand AS MATERIALIZED (
    SELECT r.collection_id, r.pack_nft_id, r.id AS rip_id, r.tx_hash, r.opener_address
      FROM (SELECT DISTINCT collection_id, pack_nft_id FROM scope) s
      -- per-id probe of pack_rips' unique pack_nft_id index (a plain join hashes every rip)
      CROSS JOIN LATERAL (SELECT r0.* FROM public.pack_rips r0
                           WHERE r0.pack_nft_id = s.pack_nft_id AND r0.collection_id = s.collection_id
                           LIMIT 1) r
     WHERE r.opener_address ~ '^0x[0-9a-f]{16}$'
       AND NOT EXISTS (SELECT 1 FROM public.pack_open_pulls o
                        WHERE o.collection_id = r.collection_id AND o.pack_nft_id = r.pack_nft_id)
       -- at least one linked pull that nothing names yet
       AND EXISTS (SELECT 1 FROM public.moment_acquisitions ma
                    WHERE ma.source_pack_rip_id = r.id AND ma.collection_id = r.collection_id
                      AND ma.acquisition_method = 'pack_pull'
                      AND (r.tx_hash IS NULL OR ma.transaction_hash IS NULL OR ma.transaction_hash = r.tx_hash)
                      AND NOT EXISTS (SELECT 1 FROM public.moments m
                                       WHERE m.collection_id = ma.collection_id AND m.nft_id = ma.nft_id)
                      AND NOT EXISTS (SELECT 1 FROM public.allday_pack_pull a
                                       WHERE r.collection_id = v_ad AND a.pack_nft_id = r.pack_nft_id
                                         AND a.moment_nft_id = ma.nft_id AND a.edition_id IS NOT NULL))
     LIMIT GREATEST(p_max, 0)
  ), ins AS (
    INSERT INTO public.pack_open_pulls (collection_id, pack_nft_id, nft_id, opener_address, edition_id, resolved_via, resolved_at)
    SELECT c.collection_id, c.pack_nft_id, ma.nft_id, c.opener_address, m.edition_id,
           CASE WHEN m.edition_id IS NOT NULL THEN 'moments' ELSE 'sold_pack_seed' END,
           CASE WHEN m.edition_id IS NOT NULL THEN now() END
      FROM cand c
      JOIN public.moment_acquisitions ma
        ON ma.source_pack_rip_id = c.rip_id AND ma.collection_id = c.collection_id
       AND ma.acquisition_method = 'pack_pull'
       AND (c.tx_hash IS NULL OR ma.transaction_hash IS NULL OR ma.transaction_hash = c.tx_hash)
      LEFT JOIN LATERAL (SELECT mo.edition_id FROM public.moments mo
                          WHERE mo.collection_id = c.collection_id AND mo.nft_id = ma.nft_id
                            AND mo.edition_id IS NOT NULL LIMIT 1) m ON true
     WHERE ma.nft_id ~ '^[0-9]{1,15}$'
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_n FROM ins;
  RETURN v_n;
END
$fn$;

COMMENT ON FUNCTION public.seed_sold_pack_pulls(integer) IS
  'Copies the unnamed linked pulls of packs saved wallets SOLD into pack_open_pulls so the existing naming lanes name them (audit_20261127_sold_pack_pulls_seeded_for_naming). Run by run_seed_sold_pack_pulls (pg_cron rpc-sold-pack-pull-seed).';
REVOKE ALL ON FUNCTION public.seed_sold_pack_pulls(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.seed_sold_pack_pulls(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.run_seed_sold_pack_pulls()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '90s'
AS $fn$
DECLARE
  v_n integer; v_err text;
BEGIN
  BEGIN
    v_n := public.seed_sold_pack_pulls(300);
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_err := left(SQLERRM, 300);
  END;
  PERFORM public.log_pipeline_run('sold-pack-pull-seed', v_err IS NULL,
    jsonb_build_object('pulls_seeded', v_n, 'error', v_err, 'via', 'pg_cron'));
  RETURN jsonb_build_object('pulls_seeded', v_n, 'error', v_err);
END
$fn$;

REVOKE ALL ON FUNCTION public.run_seed_sold_pack_pulls() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_seed_sold_pack_pulls() TO service_role;

SELECT cron.schedule('rpc-sold-pack-pull-seed', '9-59/10 * * * *', 'SELECT public.run_seed_sold_pack_pulls()');

INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, notes, is_active, max_minutes_without_success)
VALUES ('sold-pack-pull-seed', 40, 'info',
 'Added 2026-11-27: run_seed_sold_pack_pulls() (pg_cron 9-59/10) copies unnamed linked pulls of packs saved wallets SOLD into pack_open_pulls for the naming lanes. If silent, those Sold-tab rows keep "x of y priced"; nothing else depends on it.',
 true, 120)
ON CONFLICT (pipeline) DO NOTHING;
