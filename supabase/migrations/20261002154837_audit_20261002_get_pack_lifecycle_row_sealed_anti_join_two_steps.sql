-- 2026-10-02 (PT) — get_pack_lifecycle_row(p_dist_id): the "packs sealed"
-- anti-join reads 3.8× fewer buffers on the biggest dists; same answer.
--
-- WHY. The /pack/dist/<id> page calls this RPC under a 5 s bound, and the
-- Vercel 24 h error groups carry a chronic `pack_lifecycle` timeout (1–2/day
-- since 08-23). Measured 10-02 ~8:40 AM PT on dist 8552 (22,140 purchases,
-- 49,561 rips): SELECT get_pack_lifecycle_row('8552') = 97,477 buffers,
-- 11,777 ms cold / 206 ms warm. 88,530 of those buffers were the `s` CTE:
-- a Nested Loop Anti Join that probes the UNIQUE idx_pack_rips_pack_nft_id
-- once per purchased pack and then fetches the heap row for the
-- collection_id filter (~4 buffers a pack, 22,140 packs).
--
-- WHAT. Two steps, same predicate. Step 1 removes every pack that has a rip
-- attributed to THIS dist with one Hash Anti Join over the dist's rips
-- (idx_pack_rips_dist_agg_v2 → 49,561 rows). Step 2 applies the ORIGINAL
-- predicate — "no rip of this pack in the collection, whatever its dist" —
-- to the survivors only (143 on dist 8552). A pack with no rip at all has no
-- same-dist rip either, so it survives step 1 and is counted by step 2;
-- a pack whose rip carries ANOTHER dist (113 of 22,035 ripped packs on 8552
-- — 0.5 %, so the same-dist filter ALONE would have miscounted them as
-- sealed) is removed by step 2 exactly as before. The result is identical
-- by construction, not by a claim about pack_rips.dist_id. MATERIALIZED
-- pins the order so the planner cannot fold the cheap filter away.
--
-- Measured (EXPLAIN ANALYZE BUFFERS, dist 8552): the `s` leg 92,415 → 24,123
-- buffers (3.8×), the whole function 97,477 → 29,207 (3.3×; measured as
-- SELECT * FROM get_pack_lifecycle_row('8552') after the apply, 150 ms warm;
-- post-apply equivalence 40/40 dists). The remaining cost is the heap fetch of pack_nft_id for the
-- dist's 49,561 rips (idx_pack_rips_dist_agg_v2 does not carry it — an
-- INCLUDE (pack_nft_id) on that index would make this leg ~4k buffers, 20×,
-- at ~+40 MB; not built here). Equivalence on production, 40 dists (the 25
-- largest by purchases + 15 random, 224,725 purchases): packs_sealed_observed
-- equal on 40/40.
--
-- Nothing else in the body changes (text carried from pg_proc.prosrc, md5
-- e3929dae16dcd38cc2e5e995666ebdbf, defined by 20260801204912). Header
-- preserved: LANGUAGE sql STABLE SECURITY DEFINER search_path public,pg_temp.
-- Not pinned (no supabase/tests row). Caller: lib/pack-dist/fetchers.ts
-- fetchPackLifecycle (service client, 5 s bound).
--
-- Revert: re-apply the body from 20260801204912 (single-step `s` CTE).

-- anon-exec: unchanged (get_pack_lifecycle_row) — CREATE OR REPLACE of an existing fn; ACL preserved (postgres, service_role), verified has_function_privilege anon=false authenticated=false 2026-10-02.
CREATE OR REPLACE FUNCTION public.get_pack_lifecycle_row(p_dist_id text)
 RETURNS TABLE(packs_opened bigint, packs_opened_confirmed bigint, packs_opened_inferred bigint, packs_sealed_observed bigint, moments_pulled numeric, realized_pull_value_usd numeric, avg_realized_value_per_pack numeric, observed_depletion_pct numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH att AS (
    SELECT 'rip_dist'::text AS method, r.moments_pulled, r.pull_value_usd
    FROM pack_rips r
    WHERE r.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND r.dist_id = p_dist_id
    UNION ALL
    SELECT a.method, r2.moments_pulled, r2.pull_value_usd
    FROM topshot_pack_rip_attribution a
    JOIN pack_rips r2 ON r2.id = a.rip_id
    WHERE a.dist_id = p_dist_id
      AND r2.dist_id IS NULL
      AND r2.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
  ),
  o AS (
    SELECT count(*) AS packs_opened,
           count(*) FILTER (WHERE method = 'rip_dist') AS packs_opened_confirmed,
           count(*) FILTER (WHERE method <> 'rip_dist') AS packs_opened_inferred,
           COALESCE(sum(moments_pulled), 0) AS moments_pulled,
           -- NO COALESCE: NULL means "none of these rips has a priced pull",
           -- which is not the same claim as "the pulls were worth $0".
           sum(pull_value_usd) AS realized_pull_value_usd,
           -- Denominator = packs we could actually price, not every opened pack.
           count(pull_value_usd) AS priced_packs
    FROM att
  ),
  -- 2026-10-02: two steps, one predicate. Step 1 drops every pack with a rip
  -- attributed to THIS dist (one hash anti-join over the dist's rips); step 2
  -- applies the original "no rip of this pack in the collection, any dist"
  -- test to the survivors only. Identical result; 3.8x fewer buffers on the
  -- biggest dists (97k -> 24k on dist 8552). MATERIALIZED pins the order.
  cand AS MATERIALIZED (
    SELECT DISTINCT p.pack_nft_id
    FROM pack_purchases p
    WHERE p.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
      AND p.pack_dist_id = p_dist_id
      AND NOT EXISTS (SELECT 1 FROM pack_rips r
                       WHERE r.collection_id = p.collection_id AND r.dist_id = p_dist_id AND r.pack_nft_id = p.pack_nft_id)
  ),
  s AS (
    SELECT count(*) AS packs_sealed_observed
    FROM cand c
    WHERE NOT EXISTS (SELECT 1 FROM pack_rips r
                       WHERE r.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND r.pack_nft_id = c.pack_nft_id)
  )
  SELECT o.packs_opened, o.packs_opened_confirmed, o.packs_opened_inferred,
         s.packs_sealed_observed,
         o.moments_pulled::numeric,
         round(o.realized_pull_value_usd, 2),
         round(o.realized_pull_value_usd / NULLIF(o.priced_packs, 0)::numeric, 2),
         CASE WHEN (o.packs_opened + s.packs_sealed_observed) > 0
              THEN round(100.0 * o.packs_opened::numeric / (o.packs_opened + s.packs_sealed_observed)::numeric)
         END
  FROM o, s;
$function$;

-- Post-conditions: the live body carries the two-step anchor, the ACL is
-- what the marker above states, and the function answers on the biggest dist.
DO $$
DECLARE
  v_oid oid;
  v_src text;
  v_row record;
BEGIN
  SELECT p.oid, p.prosrc INTO v_oid, v_src
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'get_pack_lifecycle_row'
     AND pg_get_function_identity_arguments(p.oid) = 'p_dist_id text';
  IF v_oid IS NULL THEN RAISE EXCEPTION 'get_pack_lifecycle_row(text) not found'; END IF;
  IF position('cand AS MATERIALIZED' IN v_src) = 0 THEN
    RAISE EXCEPTION 'get_pack_lifecycle_row: two-step sealed anti-join not in the live body';
  END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE') OR has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'get_pack_lifecycle_row: anon/authenticated EXECUTE appeared (marker says unchanged=false)';
  END IF;
  SELECT * INTO v_row FROM public.get_pack_lifecycle_row('8552');
  IF v_row.packs_opened IS NULL OR v_row.packs_sealed_observed IS NULL THEN
    RAISE EXCEPTION 'get_pack_lifecycle_row(8552) returned NULL counts';
  END IF;
END $$;
