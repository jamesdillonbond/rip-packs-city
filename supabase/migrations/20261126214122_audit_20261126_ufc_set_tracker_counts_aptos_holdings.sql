-- audit_20261126_ufc_set_tracker_counts_aptos_holdings
--
-- 2026-11-26 ~1:45 PM PT (Claude Code cloud; Trevor: "Keep going" after "Do it all … aggregate across the
-- multiple chains/wallets"). The UFC Set Tracker read Flow wallet_moments_cache only, so a collector
-- whose Moments moved to Aptos (rrx69: 1,855 there) saw his sets as unstarted. owned_editions now also
-- counts ufc_aptos_holdings, through the Aptos wallets linked to the Flow address (the same links
-- get_ufc_aptos_holdings_for_flow and the binder use) or directly for an Aptos address. Nothing else
-- in the body changes.
-- anon-exec: intentional (get_ufc_set_progress) — CREATE OR REPLACE, same signature; ACL kept service_role only, asserted below.
--
-- REVERT: re-apply the CREATE OR REPLACE in 20261110184532_audit_20261110_ufc_set_tracker_reads_current_fmv_cache.sql
-- (the owned_editions CTE without the UNION arm).

DO $$
BEGIN
  IF md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.get_ufc_set_progress(text, uuid)'::regprocedure))
     <> '3c4763b19c08c10d0f93ccf580c96e47' THEN
    RAISE EXCEPTION 'get_ufc_set_progress changed since this migration was written; re-read it first';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.get_ufc_set_progress(p_wallet text, p_collection_id uuid DEFAULT '9b4824a8-736d-4a96-b450-8dcc0c46b023'::uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path = public
AS $fn$
WITH owned_editions AS (
  SELECT DISTINCT e.id AS edition_id, e.set_id
  FROM wallet_moments_cache wmc
  JOIN editions e ON e.collection_id = wmc.collection_id AND e.external_id = wmc.edition_key
  -- solana-lower: flow-only (UFC wallets are hex: Flow 0x+16 or Aptos 0x+64; superseded by 20261126215716, which hex-guards)
  WHERE wmc.wallet_address = lower(p_wallet)
    AND wmc.collection_id = p_collection_id
    AND e.set_id IS NOT NULL
  UNION
  -- 2026-11-26: UFC Strike lives on Flow AND Aptos. Moments a collector holds on Aptos count
  -- toward his sets: through the wallets linked to this Flow address, or directly when the
  -- address searched IS an Aptos account. Aptos holdings are UFC-only, so this arm adds
  -- nothing for any other collection id.
  SELECT DISTINCT e.id AS edition_id, e.set_id
  FROM ufc_aptos_holdings h
  JOIN editions e ON e.id = h.edition_id
  WHERE e.collection_id = p_collection_id
    AND e.set_id IS NOT NULL
    -- solana-lower: flow-only (UFC wallets are hex: Flow 0x+16 or Aptos 0x+64; superseded by 20261126215716, which hex-guards)
    AND (h.aptos_address = lower(p_wallet)
         OR h.aptos_address IN (SELECT l.aptos_address FROM ufc_aptos_wallet_links l
                                 WHERE l.flow_address = lower(p_wallet)))
),
universe AS (
  SELECT DISTINCT e.id AS edition_id, e.set_id, e.player_name, e.tier::text AS tier, e.thumbnail_url
  FROM editions e
  WHERE e.collection_id = p_collection_id AND e.set_id IS NOT NULL
),
edition_fmv AS (
  -- 2026-11-10: the CURRENT price per edition (edition_fmv_current), not the latest
  -- non-null snapshot: a price the engine has withdrawn must not price a missing piece.
  SELECT edition_id, fmv_usd
  FROM edition_fmv_current
  WHERE collection_id = p_collection_id AND fmv_usd IS NOT NULL
),
set_stats AS (
  SELECT
    s.id AS set_id, s.name AS set_name, s.tier::text AS set_tier,
    COUNT(DISTINCT u.edition_id) AS total_editions,
    COUNT(DISTINCT oe.edition_id) AS owned_editions,
    COALESCE(SUM(CASE WHEN oe.edition_id IS NULL THEN ef.fmv_usd ELSE 0 END), 0)::numeric(12,2) AS estimated_cost
  FROM sets s
  JOIN universe u ON u.set_id = s.id
  LEFT JOIN owned_editions oe ON oe.edition_id = u.edition_id
  LEFT JOIN edition_fmv ef ON ef.edition_id = u.edition_id
  WHERE s.collection_id = p_collection_id
  GROUP BY s.id, s.name, s.tier
)
SELECT jsonb_build_object(
  'wallet', p_wallet,
  'collection', 'ufc_strike',
  'totalSets', COUNT(*),
  'completeSets', COUNT(*) FILTER (WHERE ss.owned_editions = ss.total_editions AND ss.total_editions > 0),
  'inProgressSets', COUNT(*) FILTER (WHERE ss.owned_editions > 0 AND ss.owned_editions < ss.total_editions),
  'notStartedSets', COUNT(*) FILTER (WHERE ss.owned_editions = 0),
  'generatedAt', now(),
  'sets', jsonb_agg(jsonb_build_object(
    'setId', ss.set_id, 'setName', ss.set_name, 'setTier', ss.set_tier,
    'totalPlays', ss.total_editions, 'ownedPlays', ss.owned_editions,
    'missingPlays', ss.total_editions - ss.owned_editions,
    'completionPct', ROUND(100.0 * ss.owned_editions::numeric / NULLIF(ss.total_editions, 0), 1),
    'estimatedCostToComplete', ss.estimated_cost
  ) ORDER BY ss.owned_editions::numeric / NULLIF(ss.total_editions, 0) DESC NULLS LAST, ss.set_name)
)
FROM set_stats ss;
$fn$;

DO $$
BEGIN
  IF has_function_privilege('anon', 'public.get_ufc_set_progress(text, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.get_ufc_set_progress(text, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ACL widened on get_ufc_set_progress';
  END IF;
END $$;
