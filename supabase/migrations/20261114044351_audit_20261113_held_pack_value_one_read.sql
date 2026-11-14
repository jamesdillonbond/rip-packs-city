-- audit_20261113_held_pack_value_one_read
--
-- wallet_held_pack_value v2: ONE read of get_wallet_pack_history's held tab_totals
-- (v29, applied just before this as audit_20261113_pack_history_held_basis_totals)
-- instead of re-running that whole function once per 200-row page.
--
-- WHY (2026-11-13 ~8:15 PM PT): Trevor's binder Packs hero read four bare dashes —
-- /api/wallet/pack-summary 503'd with 57014 (a cold get_wallet_pack_summary past its
-- 15 s limit). Warm, wallet_held_pack_value was ~0.93 s of the summary's ~1.0 s on his
-- wallet: 422 sealed packs = 3 full history classifications.
--
-- EQUIVALENCE (measured on production before the switch, all 56 saved Flow wallets, 5
-- of them holding > 200 sealed packs): the one-read result equalled the old function's
-- on 55; the 56th differed only in oldest_ask_checked_at, by a snapshot-pack-asks tick
-- that landed between the two reads (4:38 → 4:43 PM PT). Time over all 56: 101.5 s → 16.4 s.
-- 'complete' is now always true (the totals cover every row; the loop stopped at 25 pages).
-- Pin: supabase/tests/get_wallet_pack_history.sql V29-1 (equality with the page-by-page
-- sums for every fixture wallet; two planted defects red it).
--
-- anon-exec: unchanged (wallet_held_pack_value) — CREATE OR REPLACE of an existing fn; ACL preserved.
-- Revert: re-apply wallet_held_pack_value from
--   supabase/migrations/20260926233000_audit_20260926_pack_observed_values_value_drops_with_no_published_pool.sql

CREATE OR REPLACE FUNCTION public.wallet_held_pack_value(p_wallet text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '20s'
AS $function$
DECLARE
  v_page jsonb;
  t jsonb;
  v_total int;
BEGIN
  -- The sealed packs this wallet holds, valued at the market -- read THROUGH
  -- get_wallet_pack_history(status 'held') so "held" means exactly what the
  -- history lists (identity-sync floor, departures, transfers).
  -- v2 (2026-11-13): ONE call. The history's tab_totals (v29) sums every held row,
  -- so the old loop -- the whole classification re-run once per 200-row page, three
  -- times on a 422-pack wallet, ~90 % of get_wallet_pack_summary -- is gone. Every
  -- field keeps its meaning; 'complete' is now always true (the totals cover every
  -- row, where the loop stopped at 25 pages).
  v_page := public.get_wallet_pack_history(p_wallet, NULL, 'held', 1, 0);
  IF v_page ? 'error' THEN
    RETURN jsonb_build_object('error', v_page->>'error');
  END IF;
  t := v_page->'tab_totals';
  IF t IS NULL THEN
    RETURN jsonb_build_object('error', 'held totals missing from get_wallet_pack_history');
  END IF;
  v_total := coalesce((v_page->>'total_count')::int, 0);
  RETURN jsonb_build_object(
    'count',                 v_total,
    'complete',              true,
    'rows_read',             v_total,
    'listed_count',          (t->>'held_listed')::int,
    'floor_ask_usd',         (t->>'held_floor_ask_usd')::numeric,
    'oldest_ask_checked_at', (t->>'held_ask_oldest_checked_at')::timestamptz,
    'last_sale_count',       (t->>'held_last_sale_n')::int,
    'last_sale_usd',         (t->>'held_last_sale_usd')::numeric,
    'rip_ev_count',          (t->>'held_rip_ev_n')::int,
    'rip_ev_usd',            (t->>'held_rip_ev_usd')::numeric,
    -- packs whose drop has no modelled EV, valued at what that drop's opened packs
    -- yielded on average -- reported apart from rip_ev
    'opened_avg_count',      (t->>'held_opened_avg_n')::int,
    'opened_avg_usd',        (t->>'held_opened_avg_usd')::numeric);
END;
$function$;
