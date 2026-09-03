-- audit_20260903_get_collection_breakdown_stale_split
--
-- Found in the 2026-09-03 re-QA of the public profile: the headline PORTFOLIO
-- FMV reads total − stale ($48.0K for qa0903b, "+ $46.1K across 369
-- stale-priced", migration 20260903023012) while the COLLECTION BREAKDOWN panel
-- on the SAME page listed NBA Top Shot at $87.8K — the raw wmc sum, stale
-- included — so the rows summed to roughly double the headline above them.
-- The dashboard's saved-wallet cards already show total − stale (UFC Strike
-- $11.68 = $1,322 − $1,310); the breakdown was the one surface left on the
-- old number.
--
-- Fix: the function ALSO returns, per collection, `stale_fmv` (sum of fmv_usd
-- over Moments whose edition's current confidence is STALE) and `stale_count`,
-- read the sanctioned way (`editions → edition_fmv_current`, never
-- `wmc.fmv_confidence`, which is a lagging denorm — see database.md). JSON
-- fields are APPENDED; `collection_id / collection_name / moment_count /
-- total_fmv` keep their names and meaning, so the one caller
-- (`/api/profile/collection-breakdown`) keeps working before its own change
-- lands. `total_fmv` stays the raw total on purpose: the route/card subtract,
-- exactly as the headline does, so the two cannot drift again.
--
-- MEASURED 2026-09-03 14:2xZ, warm, the 19,391-Moment whale wallet
-- (0xbd94cade097e50ac): old body ≈ 19,048 buffers (the wmc index scan is the
-- whole cost); new body 23,884 buffers / 89 ms — two hash joins over the full
-- editions (27,357 rows) and edition_fmv_current (27,186 rows) tables, +25%.
-- Per-collection values reproduce the saved_wallets cache written by
-- aggregate_saved_wallet_stats to the dollar (TS 87,801 / stale 43,353 vs cached
-- 87,753 / 43,353 — the delta is the hourly refresh).
--
-- anon-exec: unchanged (get_collection_breakdown) — CREATE OR REPLACE with the same signature; invoker-rights (not SECURITY DEFINER); anon/authenticated/service_role EXECUTE stand as before, verified before and after.
--
-- REVERT: re-create with the previous body (recorded in
-- docs/overnight/ledger.md, entry of 2026-09-03 "collection breakdown stale
-- split") — the four-column select without the two FILTER aggregates and
-- without the editions / edition_fmv_current joins.

CREATE OR REPLACE FUNCTION public.get_collection_breakdown(p_wallet text)
 RETURNS json
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select coalesce(json_agg(row_to_json(t)), '[]'::json)
  from (
    select
      c.id::text  as collection_id,
      c.name      as collection_name,
      count(*)::int as moment_count,
      coalesce(sum(w.fmv_usd), 0)::numeric as total_fmv,
      -- Stale slice, read through editions → edition_fmv_current (the display
      -- source database.md sanctions; wmc.fmv_confidence is a lagging denorm).
      coalesce(sum(w.fmv_usd) filter (where efc.confidence = 'STALE'), 0)::numeric as stale_fmv,
      (count(*) filter (where efc.confidence = 'STALE'))::int as stale_count
    from wallet_moments_cache w
    left join collections c on c.id = w.collection_id
    left join editions e
      on e.external_id = w.edition_key
     and e.collection_id = w.collection_id   -- external_id is only unique PER COLLECTION
    left join edition_fmv_current efc on efc.edition_id = e.id
    where w.wallet_address = lower(p_wallet)
    group by c.id, c.name
    order by total_fmv desc nulls last, moment_count desc
  ) t;
$function$;
