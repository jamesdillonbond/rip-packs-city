-- REVERT for 20261101145804 + 20261101145940 (#142, 2026-11-01).
-- Restores the three pre-change function bodies EXACTLY (each body's md5 is
-- checked below against the live prosrc read before the change) and drops the
-- scoped read. Revert the code commit FIRST, or /api/wallet-search and
-- /api/cost-basis will call a function that no longer exists.
--   export_wallet_csv                    d46024dfde323300def39768d158268c
--   backfill_cost_basis_from_ids         d2fc544b4ff50e94defe4b87894f92fe
--   backfill_pinnacle_mint_acquisitions  1ed9cd8f15f5ac2d55374c804c09fea7

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
  left join moment_acquisitions ma
    on ma.wallet = w.wallet_address
   and ma.nft_id = w.moment_id
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
    ) THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    SELECT s.price_usd, s.sold_at, s.seller_address, s.transaction_hash, s.edition_id
    INTO v_sale
    FROM sales s
    WHERE s.nft_id = v_nft_id AND s.price_usd > 0
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

DROP FUNCTION IF EXISTS public.get_wallet_acquisition_data_scoped(text, text[], uuid);
