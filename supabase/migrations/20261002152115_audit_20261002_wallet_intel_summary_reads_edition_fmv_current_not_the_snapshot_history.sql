-- audit_20261002_wallet_intel_summary_reads_edition_fmv_current_not_the_snapshot_history
--
-- 2026-10-02 ~8:40 AM PT (Claude Code, cloud, autonomous pass).
--
-- WHAT. `get_wallet_intel_summary(p_wallet)` (the `/api/public/wallet-intel` RPC, part of the
-- whale-wallet share card that timed out at 8 s twice last night) priced each Top Shot moment
-- with a per-row `LEFT JOIN LATERAL (SELECT … FROM fmv_snapshots WHERE edition_id = … ORDER BY
-- computed_at DESC LIMIT 1)` — a probe into the whole snapshot HISTORY, three partitions per
-- moment, the exact D27/R3 anti-pattern the register retired from `/api/alerts` and `/api/fmv`
-- on 2026-08-09/22 ("raw fmv_snapshots DESC + dedupe → `fmv_current`"). This file points it at
-- `edition_fmv_current` (one row per edition, PK edition_id), the table
-- `get_wallet_collection_snapshot` on the same card already reads.
--
-- MEASURED (EXPLAIN ANALYZE, BUFFERS, warm, LARGE instance), the pricing leg on Rigged
-- (0xf77bf547fccf6656, 38,666 Top Shot cache rows / 6,758 distinct editions):
--     LATERAL over fmv_snapshots ... 50,611 buffers · 2,486 ms  (Memoize 6,758 misses × 3 partitions)
--     JOIN edition_fmv_current ..... 10,504 buffers ·    79 ms
-- The WHOLE function on the same wallet moved less — 414,712 → 420,797 buffers, 1,217 → 1,094 ms
-- (founder 0xbd94…: 188,408 → 171,534, 618 → 645 ms) — because the pricing leg was not the
-- function's main cost; the rest is the `badge_editions` join and the six passes over the
-- materialised `enr` CTE (temp spill 6,705 buffers). Stated so nobody reads this as "the share
-- card is fixed": it is one of its two RPCs, and this is its one clear anti-pattern.
--
-- VALUE CHECK (same wallet): 6,758 editions — 30 differ in fmv (sum 29,304.05 vs 29,303.90 USD),
-- 2 in confidence, 1 NULL on each side. `edition_fmv_current` lags the newest snapshot by at
-- most a refresh tick; `check_edition_fmv_current_source_drift()` reads [] . Same tolerance the
-- D27/R3 repoints accepted.
--
-- UNCHANGED: signature, SECURITY DEFINER, search_path, every output key, ordering, LIMIT 6,
-- the badge_editions enrichment. Not pinned (no supabase/tests row); the route test
-- __tests__/api-public-wallet-intel.test.ts pins the HTTP contract, not the SQL.
--
-- REVERT: re-apply the previous body (prosrc md5 2885663185c51aa30de655af5f197db3 before this
-- apply — the 20260531 `audit_20260531_get_wallet_intel_summary_rpc` body with the LATERAL).
--
-- anon-exec: unchanged (get_wallet_intel_summary) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved (anon=false, authenticated=false, service_role=true verified live 2026-10-02), re-asserted below.

CREATE OR REPLACE FUNCTION public.get_wallet_intel_summary(p_wallet text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
WITH h AS (
  SELECT e.id AS edition_id, e.external_id, w.serial_number,
         COALESCE(e.player_name, '') AS player_name,
         COALESCE(e.set_name, '') AS set_name,
         e.tier::text AS tier,
         e.circulation_count, e.thumbnail_url
  FROM wallet_moments_cache w
  JOIN editions e ON e.external_id = w.edition_key AND e.collection_id = w.collection_id
  WHERE w.wallet_address = lower(p_wallet)
    AND w.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
),
enr AS (
  SELECT h.*,
    (be.is_three_star_rookie OR be.has_rookie_mint OR be.play_tags::text ILIKE '%rookie%') AS is_rookie,
    CASE WHEN COALESCE(h.circulation_count, be.circulation_count, 0) > 0
      THEN round(100.0 * (COALESCE(be.locked,0) + COALESCE(be.burned,0))::numeric / NULLIF(COALESCE(h.circulation_count, be.circulation_count), 0)::numeric, 1)
      ELSE NULL END AS squeeze_pct,
    (h.serial_number = 1 OR h.circulation_count = 1) AS is_trophy,
    -- 2026-10-02: the CURRENT FMV table (one row per edition, D27/R3's canonical
    -- source), not a per-row LATERAL over the whole fmv_snapshots HISTORY
    -- (3 partitions probed per moment: 2.49 s / 50.6k buffers -> 79 ms / 10.5k on
    -- an 18k-moment wallet; the same table get_wallet_collection_snapshot reads).
    l.fmv_usd, l.confidence::text AS confidence
  FROM h
  LEFT JOIN badge_editions be ON be.external_id = h.external_id AND be.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
  LEFT JOIN edition_fmv_current l ON l.edition_id = h.edition_id
)
SELECT jsonb_build_object(
  'wallet', lower(p_wallet),
  'ts_moments', (SELECT count(*) FROM enr),
  'ts_fmv', (SELECT round(COALESCE(sum(fmv_usd),0)::numeric, 2) FROM enr),
  'squeezed_count', (SELECT count(*) FROM enr WHERE squeeze_pct > 50),
  'rookie_count', (SELECT count(*) FROM enr WHERE is_rookie),
  'trophy_count', (SELECT count(*) FROM enr WHERE is_trophy),
  'highlights', (
    SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) FROM (
      SELECT jsonb_build_object(
        'external_id', external_id, 'player_name', player_name, 'set_name', set_name,
        'tier', tier, 'serial_number', serial_number, 'circulation', circulation_count,
        'squeeze_pct', squeeze_pct, 'is_rookie', is_rookie, 'is_trophy', is_trophy,
        'fmv_usd', fmv_usd, 'confidence', confidence, 'thumbnail_url', thumbnail_url
      ) AS x
      FROM enr
      ORDER BY (COALESCE((squeeze_pct > 50)::int,0) + COALESCE(is_rookie::int,0) + COALESCE(is_trophy::int,0)) DESC,
               squeeze_pct DESC NULLS LAST, fmv_usd DESC NULLS LAST
      LIMIT 6
    ) q
  )
);
$function$;

DO $mig$
DECLARE v jsonb;
BEGIN
  IF has_function_privilege('anon', 'public.get_wallet_intel_summary(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.get_wallet_intel_summary(text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.get_wallet_intel_summary(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'get_wallet_intel_summary ACL changed';
  END IF;
  v := public.get_wallet_intel_summary('0xbd94cade097e50ac');
  IF v IS NULL OR NOT (v ? 'ts_moments' AND v ? 'ts_fmv' AND v ? 'squeezed_count' AND v ? 'rookie_count' AND v ? 'trophy_count' AND v ? 'highlights' AND v ? 'wallet') THEN
    RAISE EXCEPTION 'get_wallet_intel_summary shape changed: %', left(v::text, 300);
  END IF;
  IF (v->>'ts_moments')::int <= 0 THEN
    RAISE EXCEPTION 'control wallet read 0 Top Shot moments — the join lost its rows';
  END IF;
END
$mig$;
