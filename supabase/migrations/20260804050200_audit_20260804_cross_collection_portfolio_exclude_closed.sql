-- audit_20260804_cross_collection_portfolio_exclude_closed
--
-- Wallet path for closed markets (grand-total RPC 1 of 3). A closed collection
-- keeps its moment COUNT in the cross-collection totals (real holdings) but its
-- dead-market dollar FMV is NOT summed into total_fmv. Each per-collection entry
-- gains market_closed_at so the UI renders a count + note instead of a dollar.
--
-- Applied live via MCP apply_migration 2026-08-03 (PT). Revert: git revert the
-- code commit + restore the prior body (no market_closed_at branch).
CREATE OR REPLACE FUNCTION public.get_cross_collection_portfolio(p_wallet text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_collection RECORD;
  v_summary jsonb;
  v_results jsonb := '[]'::jsonb;
  v_total_moments int := 0;
  v_total_fmv numeric := 0;
  v_total_locked_fmv numeric := 0;
  v_total_unlocked_fmv numeric := 0;
  v_total_locked int := 0;
  v_total_unlocked int := 0;
  v_total_cost_basis numeric := 0;
  v_total_pnl numeric := 0;
  v_closed boolean;
  v_pin_count int;
  v_pin_fmv numeric;
  v_pin_locked int;
  v_pin_locked_fmv numeric;
BEGIN
  -- Shared-schema collections (TS, AD, Golazos, UFC). Pinnacle is excluded:
  -- its FMV lives on the render spine and is denormalized into wmc (Wave 1a).
  -- A collection with market_closed_at set (UFC, closed 2026-05-13) keeps its
  -- moment COUNT in the grand totals (real holdings) but its dollar FMV is NOT
  -- summed into the cross-collection total — a closed market has no current
  -- value to fold in. Its per-collection row carries market_closed_at so the UI
  -- renders a count + note instead of a dollar total.
  FOR v_collection IN
    SELECT id, name, slug, market_closed_at FROM collections WHERE slug <> 'disney_pinnacle' ORDER BY name
  LOOP
    IF EXISTS (
      SELECT 1 FROM wallet_moments_cache
      WHERE wallet_address = p_wallet AND collection_id = v_collection.id
      LIMIT 1
    ) THEN
      v_summary := get_wallet_summary(p_wallet, v_collection.id);
      v_closed := v_collection.market_closed_at IS NOT NULL;

      -- Moment counts always accrue (the holdings are real).
      v_total_moments := v_total_moments + COALESCE((v_summary->>'total_moments')::int, 0);
      v_total_locked := v_total_locked + COALESCE((v_summary->>'locked_count')::int, 0);
      v_total_unlocked := v_total_unlocked + COALESCE((v_summary->>'unlocked_count')::int, 0);

      -- Dollar figures accrue only for live markets.
      IF NOT v_closed THEN
        v_total_fmv := v_total_fmv + COALESCE((v_summary->>'wallet_fmv')::numeric, 0);
        v_total_locked_fmv := v_total_locked_fmv + COALESCE((v_summary->>'locked_fmv')::numeric, 0);
        v_total_unlocked_fmv := v_total_unlocked_fmv + COALESCE((v_summary->>'unlocked_fmv')::numeric, 0);
        v_total_cost_basis := v_total_cost_basis + COALESCE((v_summary->>'cost_basis')::numeric, 0);
        v_total_pnl := v_total_pnl + COALESCE((v_summary->>'pnl')::numeric, 0);
      END IF;

      v_results := v_results || jsonb_build_object(
        'collection_name', v_collection.name,
        'collection_slug', v_collection.slug,
        'market_closed_at', v_collection.market_closed_at,
        'total_moments', COALESCE((v_summary->>'total_moments')::int, 0),
        'wallet_fmv', COALESCE((v_summary->>'wallet_fmv')::numeric, 0),
        'locked_fmv', COALESCE((v_summary->>'locked_fmv')::numeric, 0),
        'unlocked_fmv', COALESCE((v_summary->>'unlocked_fmv')::numeric, 0),
        'locked_count', COALESCE((v_summary->>'locked_count')::int, 0),
        'unlocked_count', COALESCE((v_summary->>'unlocked_count')::int, 0),
        'cost_basis', COALESCE((v_summary->>'cost_basis')::numeric, 0),
        'pnl', COALESCE((v_summary->>'pnl')::numeric, 0)
      );
    END IF;
  END LOOP;

  -- Pinnacle: read wmc directly (per-render FMV, same source as /share).
  SELECT count(*),
         COALESCE(SUM(fmv_usd), 0),
         count(*) FILTER (WHERE is_locked),
         COALESCE(SUM(fmv_usd) FILTER (WHERE is_locked), 0)
    INTO v_pin_count, v_pin_fmv, v_pin_locked, v_pin_locked_fmv
  FROM wallet_moments_cache
  WHERE wallet_address = p_wallet
    AND collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714';

  IF v_pin_count > 0 THEN
    v_total_moments := v_total_moments + v_pin_count;
    v_total_fmv := v_total_fmv + v_pin_fmv;
    v_total_locked := v_total_locked + v_pin_locked;
    v_total_locked_fmv := v_total_locked_fmv + v_pin_locked_fmv;
    v_total_unlocked := v_total_unlocked + (v_pin_count - v_pin_locked);
    v_total_unlocked_fmv := v_total_unlocked_fmv + (v_pin_fmv - v_pin_locked_fmv);

    v_results := v_results || jsonb_build_object(
      'collection_name', 'Disney Pinnacle',
      'collection_slug', 'disney_pinnacle',
      'market_closed_at', NULL,
      'total_moments', v_pin_count,
      'wallet_fmv', ROUND(v_pin_fmv, 2),
      'locked_fmv', ROUND(v_pin_locked_fmv, 2),
      'unlocked_fmv', ROUND(v_pin_fmv - v_pin_locked_fmv, 2),
      'locked_count', v_pin_locked,
      'unlocked_count', v_pin_count - v_pin_locked,
      'cost_basis', 0,
      'pnl', 0
    );
  END IF;

  RETURN jsonb_build_object(
    'wallet', p_wallet,
    'total_moments', v_total_moments,
    'total_fmv', ROUND(v_total_fmv, 2),
    'total_locked_fmv', ROUND(v_total_locked_fmv, 2),
    'total_unlocked_fmv', ROUND(v_total_unlocked_fmv, 2),
    'total_locked', v_total_locked,
    'total_unlocked', v_total_unlocked,
    'total_cost_basis', ROUND(v_total_cost_basis, 2),
    'total_pnl', ROUND(v_total_pnl, 2),
    'collections', v_results,
    'collection_count', jsonb_array_length(v_results)
  );
END;
$function$;
