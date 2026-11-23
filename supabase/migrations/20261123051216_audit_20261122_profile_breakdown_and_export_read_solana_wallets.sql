-- audit_20261122_profile_breakdown_and_export_read_solana_wallets
-- anon-exec: unchanged (get_collection_breakdown) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved, has_function_privilege anon = true before and after (the public profile route reads it).
-- anon-exec: unchanged (export_wallet_csv) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved, has_function_privilege anon = true before and after.
--
-- 2026-11-22 ~9:15 PM PT (Claude Code cloud, evening autonomous pass).
-- WHY (1, honesty — the chain-two footgun in CLAUDE.md). Both functions matched `wallet_address = lower(p_wallet)`.
--   A Solana (Candy) address is base58 and CASE-SENSITIVE, so lower() matched nothing: the one saved Candy wallet
--   (575 moments in wallet_moments_cache under its exact-case address, 0 under the lowercased one) read as holding
--   nothing on the profile's collection breakdown and in the account CSV export. Now lower() only for a hex (0x)
--   address — the repo's existing SQL idiom (`CASE WHEN p_wallet ~* '^0x' THEN lower(p_wallet) ELSE p_wallet END`).
-- WHY (2, cost). get_collection_breakdown was a SQL function, so the wallet was a planner parameter: it assumed ~900
--   rows and nested-looped editions + edition_fmv_current per moment — 405k buffers / 3.1 s on a 47k-moment wallet,
--   6 Vercel timeouts (8 s read budget) in 3 days. As plpgsql + EXECUTE with the wallet as a literal it is planned for
--   that wallet: 40.6k buffers / 0.22 s. export_wallet_csv ran DISTINCT ON over every fmv_snapshots row (~3.2M) per
--   call; it now reads edition_fmv_current, the latest-per-edition table (database.md).
-- PROVED before applying (pg_temp copies vs the live functions): breakdown identical on 58 of 58 saved Flow wallets;
--   export identical on a 20,154-row wallet in every non-FMV column (33 FMV cells differed: snapshots written minutes
--   earlier that edition_fmv_current had not absorbed yet — the source every other surface reads). The Candy wallet:
--   breakdown [] → 575 moments / $474.49; export 0 → 575 rows.
-- No route change: both routes pass the saved address as stored.
--
-- REVERT: re-apply get_collection_breakdown from 20261110175500_audit_20261110_withdrawn_prices_in_wallets_count_as_stale.sql;
--   export_wallet_csv's previous body (prosrc md5 cc5176bfb16ccf9258eadcd6b99766e7) = this file's body with the
--   `latest_fmv` DISTINCT ON CTE over fmv_snapshots and `where w.wallet_address = lower(p_wallet)`.

DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.get_collection_breakdown(text)'::regprocedure)
     IS DISTINCT FROM 'bdcfb890cc271dea22bf0b7b8b9582d3' THEN
    RAISE EXCEPTION 'get_collection_breakdown is not the 20261110175500 body; re-read it and re-base';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.export_wallet_csv(text)'::regprocedure)
     IS DISTINCT FROM 'cc5176bfb16ccf9258eadcd6b99766e7' THEN
    RAISE EXCEPTION 'export_wallet_csv is not the expected body; re-read it and re-base';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.get_collection_breakdown(p_wallet text)
 RETURNS json
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v json;
  -- 2026-11-22: a Flow/EVM address is hex and case-insensitive; a Solana (Candy) address is base58 and
  -- case-SENSITIVE, and lower() made it match nothing (a saved Candy wallet's 575 moments read as none).
  v_wallet text := CASE WHEN p_wallet ~* '^0x' THEN lower(p_wallet) ELSE p_wallet END;
BEGIN
  -- 2026-11-22: planned per call with the wallet as a literal. As a SQL function the wallet was a parameter,
  -- the planner assumed ~900 rows and nested-looped editions + edition_fmv_current per moment: 405k buffers /
  -- 3.1 s on a 47k-moment wallet vs 40.6k / 0.22 s planned for that wallet. Small wallets keep the nested loop.
  EXECUTE format($q$
  select coalesce(json_agg(row_to_json(t)), '[]'::json)
  from (
    select
      c.id::text  as collection_id,
      c.name      as collection_name,
      count(*)::int as moment_count,
      coalesce(sum(w.fmv_usd), 0)::numeric as total_fmv,
      -- Stale slice, read through editions → edition_fmv_current (the display
      -- source database.md sanctions; wmc.fmv_confidence is a lagging denorm).
      -- 2026-11-10: a WITHDRAWN price (current row, NULL price) still cached is stale too.
      coalesce(sum(w.fmv_usd) filter (where efc.confidence = 'STALE' or (efc.edition_id is not null and efc.fmv_usd is null and w.fmv_usd is not null)), 0)::numeric as stale_fmv,
      (count(*) filter (where efc.confidence = 'STALE' or (efc.edition_id is not null and efc.fmv_usd is null and w.fmv_usd is not null)))::int as stale_count
    from wallet_moments_cache w
    left join collections c on c.id = w.collection_id
    left join editions e
      on e.external_id = w.edition_key
     and e.collection_id = w.collection_id   -- external_id is only unique PER COLLECTION
    left join edition_fmv_current efc on efc.edition_id = e.id
    where w.wallet_address = %L
    group by c.id, c.name
    order by total_fmv desc nulls last, moment_count desc
  ) t
  $q$, v_wallet) INTO v;
  RETURN v;
END
$function$;

CREATE OR REPLACE FUNCTION public.export_wallet_csv(p_wallet text)
 RETURNS TABLE(player_name text, set_name text, series text, tier text, serial_number integer, circulation_count integer, fmv numeric, buy_price numeric, acquisition_method text, is_locked boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select
    coalesce(e.player_name, w.player_name)               as player_name,
    coalesce(e.set_name, w.set_name)                     as set_name,
    coalesce(w.series_number::text, e.series::text)      as series,
    coalesce(e.tier::text, w.tier)                       as tier,
    w.serial_number                                       as serial_number,
    e.circulation_count                                   as circulation_count,
    coalesce(lf.fmv_usd, w.fmv_usd)                      as fmv,
    ma.buy_price                                          as buy_price,
    ma.acquisition_method                                 as acquisition_method,
    case when w.lock_checked_at is not null then coalesce(w.is_locked, false) end as is_locked
  from wallet_moments_cache w
  left join editions e
    on e.external_id = w.edition_key
   and e.collection_id = w.collection_id
  -- 2026-11-22: the latest price per edition is edition_fmv_current (database.md). The old CTE ran
  -- DISTINCT ON over every fmv_snapshots row (~3.2M) on each call to then join a handful of editions.
  left join edition_fmv_current lf on lf.edition_id = e.id
  left join lateral (
    select ma2.buy_price, ma2.acquisition_method
    from moment_acquisitions ma2
    where ma2.wallet = w.wallet_address
      and ma2.collection_id = w.collection_id
      and ma2.nft_id = w.moment_id
    order by ma2.created_at desc
    limit 1
  ) ma on true
  -- 2026-11-22: lower() only for a hex (0x) address; a Solana address is case-sensitive.
  where w.wallet_address = CASE WHEN p_wallet ~* '^0x' THEN lower(p_wallet) ELSE p_wallet END;
$function$;
