-- moment_acquisitions reads and writes are COLLECTION-scoped (2026-10-31,
-- follow-up to 20261101051652, which fixed the binder's own read).
--
-- moment_id / nft_id is unique only WITHIN a collection, including inside one
-- Flow wallet, which holds Top Shot, All Day and UFC moments whose ids collide
-- (CLAUDE.md #142; 41 wallet_moments_cache rows in 11 wallets matched another
-- collection's acquisition, measured 2026-10-31). A sweep of the 22 functions
-- that join moment_acquisitions on nft_id found 16 already scoped (by a
-- collection literal, by source_pack_rip_id, or by carrying collection_id),
-- one with zero callers (classify_acquisition — left as is), one whose
-- collision needs an identical microsecond acquired_date (0 found —
-- backfill_pack_pull_source_rip_id, left as is), and these four:
--
-- (1) get_wallet_acquisition_data — /api/wallet-search and /api/cost-basis
--     enrich rows with acquisition method / Paid by (wallet, nft_id) only, and
--     DISTINCT ON (nft_id) picked the NEWEST row across collections. New
--     optional p_collection_id (NULL keeps the wallet-wide read). The old
--     2-arg signature is DROPPED, not overloaded: two overloads would make a
--     2-named-arg PostgREST call ambiguous. Deployed callers send 2 args and
--     resolve to the default until the code that sends the collection ships.
--     ACL restored to exactly what it was: postgres + service_role.
-- (2) export_wallet_csv — joined moment_acquisitions by (wallet, nft_id), so a
--     moment exported once PER acquisition row (443 moments duplicated,
--     measured) and could carry another collection's price. Now a LATERAL:
--     the newest-created row of the moment's own collection, one row each.
-- (3) backfill_cost_basis_from_ids — its "already covered" check and its
--     sales lookup ignored the collection, so it priced moments from ANOTHER
--     collection's sale: 168 of its 755 rows are tagged Top Shot but carry an
--     All Day (66) or UFC (102) sale — $1,678.51 of invented spend. Both now
--     use p_collection_id. (The rows themselves: next migration.)
-- (4) backfill_pinnacle_mint_acquisitions — the deliberately cross-WALLET
--     "a mint is a Pin's first acquisition" gate is kept; it now ignores an
--     acquisition of the same nft_id in ANOTHER collection (a different
--     moment). 0 mints blocked today; latent.
--
-- anon-exec: intentional — export_wallet_csv backs /api/profile/export-csv and
-- keeps its existing ACL (CREATE OR REPLACE does not reset an ACL).

DROP FUNCTION IF EXISTS public.get_wallet_acquisition_data(text, text[]);
CREATE OR REPLACE FUNCTION public.get_wallet_acquisition_data(p_wallet text, p_moment_ids text[], p_collection_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(moment_id text, acquisition_method text, buy_price numeric, loan_principal numeric, acquired_date timestamp with time zone, source_wallet text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT DISTINCT ON (ma.nft_id)
    ma.nft_id AS moment_id,
    ma.acquisition_method,
    ma.buy_price,
    ma.loan_principal,
    ma.acquired_date,
    ma.source_wallet
  FROM moment_acquisitions ma
  WHERE ma.wallet = p_wallet
    AND ma.nft_id = ANY(p_moment_ids)
    AND (p_collection_id IS NULL OR ma.collection_id = p_collection_id)
  ORDER BY ma.nft_id, ma.created_at DESC;
$function$;
REVOKE ALL ON FUNCTION public.get_wallet_acquisition_data(text, text[], uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_wallet_acquisition_data(text, text[], uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_wallet_acquisition_data(text, text[], uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.export_wallet_csv(p_wallet text)
 RETURNS TABLE(player_name text, set_name text, series text, tier text, serial_number integer, circulation_count integer, fmv numeric, buy_price numeric, acquisition_method text, is_locked boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  with latest_fmv as (
    select distinct on (edition_id) edition_id, fmv_usd
    from fmv_snapshots
    order by edition_id, computed_at desc
  )
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
  left join latest_fmv lf on lf.edition_id = e.id
  left join lateral (
    select ma2.buy_price, ma2.acquisition_method
    from moment_acquisitions ma2
    where ma2.wallet = w.wallet_address
      and ma2.collection_id = w.collection_id
      and ma2.nft_id = w.moment_id
    order by ma2.created_at desc
    limit 1
  ) ma on true
  where w.wallet_address = lower(p_wallet);
$function$;

CREATE OR REPLACE FUNCTION public.backfill_cost_basis_from_ids(p_wallet text, p_nft_ids text[], p_collection_id uuid DEFAULT '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid)
 RETURNS json
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inserted integer := 0;
  v_skipped integer := 0;
  v_no_sale integer := 0;
  v_nft_id text;
  v_sale record;
  v_fmv numeric;
BEGIN
  FOREACH v_nft_id IN ARRAY p_nft_ids
  LOOP
    IF EXISTS (
      SELECT 1 FROM moment_acquisitions
      WHERE nft_id = v_nft_id AND wallet = p_wallet
        AND collection_id = p_collection_id
    ) THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    SELECT s.price_usd, s.sold_at, s.seller_address, s.transaction_hash, s.edition_id
    INTO v_sale
    FROM sales s
    WHERE s.nft_id = v_nft_id AND s.price_usd > 0
      AND s.collection_id = p_collection_id
    ORDER BY s.sold_at DESC LIMIT 1;

    IF v_sale IS NULL THEN
      v_no_sale := v_no_sale + 1;
      CONTINUE;
    END IF;

    SELECT fs.fmv_usd INTO v_fmv
    FROM fmv_snapshots fs
    WHERE fs.edition_id = v_sale.edition_id
    ORDER BY fs.computed_at DESC LIMIT 1;

    INSERT INTO moment_acquisitions (nft_id, wallet, buy_price, acquired_date, acquired_type, fmv_at_acquisition, seller_address, transaction_hash, source, collection_id)
    VALUES (
      v_nft_id, p_wallet, v_sale.price_usd, v_sale.sold_at, 1, v_fmv,
      v_sale.seller_address,
      COALESCE(v_sale.transaction_hash, 'backfill:' || v_nft_id),
      'sales_backfill',
      p_collection_id
    )
    ON CONFLICT (nft_id, wallet, transaction_hash) DO NOTHING;

    v_inserted := v_inserted + 1;
  END LOOP;

  RETURN json_build_object(
    'inserted', v_inserted, 'skipped', v_skipped,
    'no_sale', v_no_sale, 'total_ids', array_length(p_nft_ids, 1)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.backfill_pinnacle_mint_acquisitions(p_limit integer DEFAULT 50000)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '90s'
AS $function$
DECLARE
  v_inserted int := 0;
  v_pin uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
BEGIN
  WITH candidates AS (
    SELECT m.nft_id,
           wmc.wallet_address AS wallet,
           m.minted_at        AS acquired_date,
           COALESCE(NULLIF(m.tx_hash, ''), 'pinnacle_mint:' || m.nft_id) AS tx_hash
    FROM public.pinnacle_mint_events m
    JOIN public.wallet_moments_cache wmc
      ON wmc.moment_id = m.nft_id
     AND wmc.collection_id = v_pin
     AND lower(wmc.wallet_address) = lower(m.to_wallet)
    WHERE NOT EXISTS (
      SELECT 1 FROM public.moment_acquisitions a WHERE a.nft_id = m.nft_id
        AND a.collection_id = v_pin
    )
    LIMIT p_limit
  ),
  ins AS (
    INSERT INTO public.moment_acquisitions (
      nft_id, wallet, acquired_date, acquired_type,
      acquisition_method, acquisition_confidence,
      transaction_hash, source, collection_id
    )
    SELECT
      nft_id, wallet, acquired_date, 1,
      'mint', 'verified',
      tx_hash, 'pinnacle_mints', v_pin
    FROM candidates
    ON CONFLICT (nft_id, wallet, transaction_hash) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) FROM ins INTO v_inserted;

  RETURN json_build_object('collection', 'disney_pinnacle', 'inserted', v_inserted);
END;
$function$;

-- ACLs: both backfills were already NOT anon-executable (postgres +
-- service_role; the Pinnacle one also cron_heavy, the role its pg_cron job
-- `rpc-backfill-pinnacle-mint-acquisitions` runs as). These statements restate
-- that, and re-grant the callers in the same migration so the revoke can never
-- orphan the cron job.
REVOKE EXECUTE ON FUNCTION public.backfill_cost_basis_from_ids(text, text[], uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backfill_cost_basis_from_ids(text, text[], uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.backfill_pinnacle_mint_acquisitions(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backfill_pinnacle_mint_acquisitions(integer) TO service_role, cron_heavy;
