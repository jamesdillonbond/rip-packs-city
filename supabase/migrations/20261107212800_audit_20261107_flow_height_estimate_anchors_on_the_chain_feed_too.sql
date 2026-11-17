-- audit_20261107_flow_height_estimate_anchors_on_the_chain_feed_too — 2026-11-07 (Cowork cloud, ~1:25 PM PT).
--
-- `flow_height_estimate` interpolated ONLY between `topshot_pack_sales_history` rows — Dapper Studio's
-- index, frozen since ~10-29 (#218). Every probe after the freeze is an EXTRAPOLATION at 1.19 blocks/s
-- from a 9-day-old anchor; Flow runs ~1.25/s, so the five targeted 11-05 probes aimed ~8 h early
-- (`window 2026-11-05 10:47 .. 10:51 missed the instant` on a 19:04 probe), and every tail probe
-- re-aims at least once (25 of 25 on the first two ticks: twice the Flow calls, half the throughput).
-- `pack_purchases` is chain-indexed (worker pack-events-ingest, ~7–10 min behind the head) and
-- carries `block_height` + `sealed_at` on every row, so it is a current anchor on both sides of any
-- recent instant. Both sources are read and the NEAREST anchor on each side wins; the two older
-- branches (one-sided extrapolation, no anchor → NULL) are unchanged. Reads are index probes:
-- `idx_pack_purchases_collection_time (collection_id, sealed_at DESC)`.
--
-- Pin: supabase/tests/run_pack_mint_probe_lane.sql (flow_height_estimate block updated verbatim;
-- registry pointer moved here).
--
-- anon-exec: unchanged (flow_height_estimate) — CREATE OR REPLACE of an existing fn; ACL preserved (read-only estimate), verified anon=false before the change.
--
-- REVERT: re-apply the function body from 20260926200000_audit_20260926_pack_nft_mints_name_packs_dapper_minted_straight_into_a_wallet.sql.

CREATE OR REPLACE FUNCTION public.flow_height_estimate(p_at timestamptz)
RETURNS bigint
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  -- Interpolate between the nearest anchors on either side of p_at (each carries
  -- its block height and time); extrapolate at ~1.19 blocks/s from one side when
  -- only one exists. NULL when there is no anchor at all.
  -- 2026-11-07: TWO anchor sources — Studio's marketplace index (frozen since
  -- 10-29, #218) and the chain-indexed pack_purchases (always current); the
  -- nearest row on each side wins, whichever table it came from.
  WITH a AS (
    SELECT h, t FROM (
      (SELECT block_height AS h, block_time AS t FROM public.topshot_pack_sales_history
        WHERE block_time <= p_at AND block_height IS NOT NULL
        ORDER BY block_time DESC LIMIT 1)
      UNION ALL
      (SELECT block_height AS h, sealed_at AS t FROM public.pack_purchases
        WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
          AND sealed_at <= p_at AND block_height IS NOT NULL
        ORDER BY sealed_at DESC LIMIT 1)
    ) x ORDER BY t DESC LIMIT 1
  ), b AS (
    SELECT h, t FROM (
      (SELECT block_height AS h, block_time AS t FROM public.topshot_pack_sales_history
        WHERE block_time >= p_at AND block_height IS NOT NULL
        ORDER BY block_time LIMIT 1)
      UNION ALL
      (SELECT block_height AS h, sealed_at AS t FROM public.pack_purchases
        WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
          AND sealed_at >= p_at AND block_height IS NOT NULL
        ORDER BY sealed_at LIMIT 1)
    ) x ORDER BY t LIMIT 1
  )
  SELECT CASE
           WHEN a.h IS NOT NULL AND b.h IS NOT NULL AND b.t > a.t
             THEN a.h + round((b.h - a.h) * extract(epoch FROM p_at - a.t) / extract(epoch FROM b.t - a.t))::bigint
           WHEN a.h IS NOT NULL THEN a.h + round(extract(epoch FROM p_at - a.t) * 1.19)::bigint
           WHEN b.h IS NOT NULL THEN b.h - round(extract(epoch FROM b.t - p_at) * 1.19)::bigint
         END
  FROM (SELECT 1) one LEFT JOIN a ON true LEFT JOIN b ON true
$function$;
