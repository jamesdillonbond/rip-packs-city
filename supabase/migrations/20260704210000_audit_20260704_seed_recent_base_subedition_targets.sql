-- Durable fix for the set-263 class of gap: brand-new parallel sets never get seeded into the
-- subedition resolver, so their parallels stay conflated onto the base edition.
--
-- The two existing seeds have a chicken-and-egg blind spot for a fresh set:
--   * seed_topshot_conflated_subedition_targets needs a SALES serial-collision already in the
--     guard (both a Standard #N and a parallel #N must have SOLD) — rare in a young set where
--     most parallels are only HELD.
--   * seed_topshot_miskeyed_subedition_targets needs `::` editions to already EXIST.
-- A new set (e.g. 263 Video Game Numbers) satisfies neither -> never resolved on-chain.
--
-- This proactive seed queues unresolved base-keyed nfts (sales + wmc holdings + moments) for
-- editions in the CURRENT parallel era (auto: the newest 2 TS series, floored at 7), so the
-- on-chain resolver (TopShot.getMomentsSubedition) reaches every current/new set without
-- waiting for a collision. Standard nfts resolve to subedition 0 (harmless, prevents re-seed);
-- parallels get cataloged + split by the downstream pipeline steps. Bounded per tick; the
-- NOT EXISTS makes it self-terminating (only genuinely-new nfts queue in steady state).
-- Wired into the daily drain-conflated-subeditions orchestrator (step 1c).
-- Revert: DROP FUNCTION public.seed_topshot_recent_base_subedition_targets(integer, integer);
CREATE OR REPLACE FUNCTION public.seed_topshot_recent_base_subedition_targets(
  p_limit integer DEFAULT 15000, p_min_series integer DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_ts uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_min int;
  n integer := 0;
BEGIN
  v_min := COALESCE(p_min_series,
    GREATEST(7, (SELECT max(series) FROM editions WHERE collection_id = v_ts) - 1));

  DROP TABLE IF EXISTS _recent_base;
  CREATE TEMP TABLE _recent_base ON COMMIT DROP AS
    SELECT id, external_id FROM editions
    WHERE collection_id = v_ts AND external_id ~ '^[0-9]+:[0-9]+$' AND series >= v_min;

  INSERT INTO topshot_moment_subeditions (nft_id, base_external_id, subedition_id)
  SELECT cur.nft_id, cur.base, NULL::smallint
  FROM (
    SELECT DISTINCT s.nft_id, rb.external_id AS base
    FROM sales s JOIN _recent_base rb ON rb.id = s.edition_id
    WHERE s.collection_id = v_ts AND s.nft_id ~ '^[0-9]+$'
    UNION
    SELECT DISTINCT wm.moment_id, rb.external_id
    FROM wallet_moments_cache wm JOIN _recent_base rb ON rb.external_id = wm.edition_key
    WHERE wm.collection_id = v_ts AND wm.moment_id ~ '^[0-9]+$'
    UNION
    SELECT DISTINCT m.nft_id, rb.external_id
    FROM moments m JOIN _recent_base rb ON rb.id = m.edition_id
    WHERE m.collection_id = v_ts AND m.nft_id ~ '^[0-9]+$'
  ) cur
  WHERE NOT EXISTS (SELECT 1 FROM topshot_moment_subeditions t WHERE t.nft_id = cur.nft_id)
  LIMIT greatest(1, p_limit)
  ON CONFLICT (nft_id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $function$;

REVOKE ALL ON FUNCTION public.seed_topshot_recent_base_subedition_targets(integer, integer) FROM public, anon, authenticated;
