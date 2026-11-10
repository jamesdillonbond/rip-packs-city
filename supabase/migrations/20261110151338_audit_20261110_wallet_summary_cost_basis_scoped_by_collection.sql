-- audit_20261110_wallet_summary_cost_basis_scoped_by_collection
--
-- WHY. get_wallet_summary's cost-basis lateral read moment_acquisitions by (nft_id, wallet) only.
-- A moment_id is unique only WITHIN a collection, even inside one wallet (CLAUDE.md; #142, #223 —
-- the binder "Paid $65" case), so a wallet holding the same numeric id in two collections would
-- carry the OTHER collection's buy price into this collection's cost basis, P&L and acquisition
-- breakdown. Latent, not live: 0 (wallet, nft_id) pairs span two collections on 11-10 (1,304,407
-- acquisition rows, collection_id NULL on none), so results are identical today.
--
-- CHANGE. One predicate: `AND ma2.collection_id = wmc.collection_id` in the lateral. Literal DDL
-- (the 20260925073848 definition was a regex splice); the rest of the body is the live prosrc
-- verbatim (md5 c579fc7029648025e10e8c440d85b8d2 re-read 11-10 before this write).
--
-- anon-exec: unchanged (get_wallet_summary) — CREATE OR REPLACE of an existing SECURITY INVOKER read; ACL preserved, verified has_function_privilege anon=true, authenticated=true on 11-10 (/api/wallet-summary reads it).
--
-- REVERT: re-apply this file without the `AND ma2.collection_id = wmc.collection_id` line.

CREATE OR REPLACE FUNCTION public.get_wallet_summary(p_wallet text, p_collection_id uuid DEFAULT '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid)
 RETURNS json
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH moment_data AS (
    SELECT
      wmc.moment_id,
      wmc.is_locked,
      (wmc.lock_checked_at IS NOT NULL) AS lock_known,
      -- 2026-09-25: fall back to the cache's own FMV like get_wallet_total_fmv
      -- does — Pinnacle resolves 0 rows through edition_fmv_current.
      COALESCE(lf.fmv_usd, wmc.fmv_usd) AS fmv_usd,
      COALESCE(lf.confidence, wmc.fmv_confidence) AS confidence,
      ma.buy_price,
      ma.acquisition_method
    FROM wallet_moments_cache wmc
    LEFT JOIN editions e ON e.external_id = wmc.edition_key AND e.collection_id = p_collection_id
    -- 2026-09-06: latest-per-edition lives in edition_fmv_current (202K buffers → index probes)
    LEFT JOIN edition_fmv_current lf ON lf.edition_id = e.id
    LEFT JOIN LATERAL (
      SELECT ma2.buy_price, ma2.acquisition_method
      FROM moment_acquisitions ma2
      WHERE ma2.nft_id = wmc.moment_id AND ma2.wallet = wmc.wallet_address
        -- 2026-11-10: a moment_id is unique only WITHIN a collection (#142/#223) — scope the cost basis
        AND ma2.collection_id = wmc.collection_id
      ORDER BY ma2.created_at DESC LIMIT 1
    ) ma ON true
    WHERE wmc.wallet_address = p_wallet AND wmc.collection_id = p_collection_id
  )
  SELECT json_build_object(
    'total_moments', (SELECT COUNT(*) FROM moment_data),
    'wallet_fmv', (SELECT ROUND(COALESCE(SUM(fmv_usd), 0)::numeric, 2) FROM moment_data),
    'unlocked_fmv', (SELECT ROUND(COALESCE(SUM(CASE WHEN lock_known AND NOT is_locked THEN fmv_usd ELSE 0 END), 0)::numeric, 2) FROM moment_data),
    'locked_fmv', (SELECT ROUND(COALESCE(SUM(CASE WHEN is_locked THEN fmv_usd ELSE 0 END), 0)::numeric, 2) FROM moment_data),
    -- 2026-09-06: the stale split, so the Collection tab can headline total − stale like every other surface
    'stale_fmv', (SELECT ROUND(COALESCE(SUM(CASE WHEN confidence = 'STALE' THEN fmv_usd ELSE 0 END), 0)::numeric, 2) FROM moment_data),
    'stale_count', (SELECT COUNT(*) FROM moment_data WHERE confidence = 'STALE'),
    'locked_count', (SELECT COUNT(*) FROM moment_data WHERE is_locked),
    'unlocked_count', (SELECT COUNT(*) FROM moment_data WHERE lock_known AND NOT is_locked),
    'lock_unknown_fmv', (SELECT ROUND(COALESCE(SUM(CASE WHEN NOT lock_known THEN fmv_usd ELSE 0 END), 0)::numeric, 2) FROM moment_data),
    'lock_unknown_count', (SELECT COUNT(*) FROM moment_data WHERE NOT lock_known),
    'cost_basis', (SELECT ROUND(COALESCE(SUM(buy_price), 0)::numeric, 2) FROM moment_data WHERE buy_price IS NOT NULL),
    'current_fmv', (SELECT ROUND(COALESCE(SUM(fmv_usd), 0)::numeric, 2) FROM moment_data WHERE buy_price IS NOT NULL),
    'pnl', (SELECT ROUND(
      COALESCE(SUM(fmv_usd), 0) - COALESCE(SUM(buy_price), 0), 2
    )::numeric FROM moment_data WHERE buy_price IS NOT NULL),
    'moments_with_cost', (SELECT COUNT(*) FROM moment_data WHERE buy_price IS NOT NULL),
    'acquisition_breakdown', (
      SELECT json_agg(json_build_object(
        'method', acquisition_method, 'count', cnt, 'total_spent', spent
      ) ORDER BY cnt DESC)
      FROM (
        SELECT acquisition_method, COUNT(*) AS cnt, 
          ROUND(SUM(COALESCE(buy_price, 0))::numeric, 2) AS spent
        FROM moment_data
        WHERE acquisition_method IS NOT NULL
        GROUP BY acquisition_method
      ) sub
    )
  );
$function$;
