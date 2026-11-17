-- APPLIED 2026-10-17 9:18 PM PT via the dashboard SQL editor (Trevor: "apply the Golazos status fix", 9:17 PM PT); the MCP held
-- apply_migration, execute_sql and a one-off pg_cron schedule (all 'cancelled'). schema_migrations row 20261018041800 inserted by hand.
-- Verified: v_collection_marketplace_status laliga_golazos secondary_status idle_since_2026_10_02, last_verified_at 2026-10-18 03:45Z,
-- notes rewritten; status 'healthy' and buy_ctas_enabled true unchanged.
-- audit_20261017_golazos_marketplace_status_reverified_idle
--
-- 2026-10-17 ~8:45 PM PT (Cowork cloud; Trevor: "Keep going"). Golazos roadmap "Now" items 1 + 2:
-- settle "market dead or venue blind", then correct v_collection_marketplace_status, whose Golazos row
-- (collection_config.metadata.marketplace) still published a 2026-07-04 "healthy / live" verification
-- with notes citing "296 listings / 135 active as of 2026-07-03".
--
-- MEASURED (independent of every RPC ingest lane — the sales and listings indexers share one event
-- stream, so they are one instrument):
--   * Flow REST, A.87ca73a41bb50ad5.Golazos.Withdraw over blocks 166,426,224 -> 168,136,488
--     (10-02 00:00 PT -> 10-17 ~8:10 PM PT), 6,842 x 250-block ranges, 0 failed:
--     ONE event — tx 240dcfd5…ca37 (10-05 7:13 PM PT), a PackNFT.Opened pack reveal (escrow
--     0xb6f2481eba4df97b -> 0x4c43f296e36f7dc9, gas only). ZERO secondary trades on-chain, on any venue:
--     a trade on Dapper Market or laligagolazos.com must emit a Golazos.Withdraw.
--   * POSITIVE CONTROL, same script: 09-10 -> 09-13 (blocks 164,051,103 -> 164,374,975) = 54 Withdraws in
--     54 txs, 16 on 09-10 and 38 on 09-12 PT — exactly the `sales` rows for those days.
--   * `sales`: newest Golazos sale 10-01 10:26 PM PT; golazos-storefront-reconcile `live` flat at 4,286.
--   VERDICT: the market is idle; RPC's venue is not blind.
--
-- WHAT: metadata.marketplace.secondary_status 'live' -> 'idle_since_2026_10_02', notes rewritten from the
-- measurement, last_verified_at stamped. status stays 'healthy' and buy_ctas_enabled stays true: listings
-- exist (4,286 live) and the venue works; whether to show a dormancy label is the roadmap's NEXT item
-- (a copy decision), not this record. ⚠ Deliberately NOT a 'dormant_*' value: the (currently unrendered)
-- FlowtyDormancyChip keys on startsWith("dormant") and hardcodes "Flowty marketplace currently offline",
-- which would be false for Dapper Market. With status 'healthy' the banner does not render notes, so this
-- changes no on-screen copy.
--
-- REVERT:
--   UPDATE public.collection_config SET metadata = jsonb_set(jsonb_set(jsonb_set(metadata,
--     '{marketplace,secondary_status}', '"live"'), '{marketplace,last_verified_at}', '"2026-07-04T05:32:37.257776+00:00"'),
--     '{marketplace,notes}', to_jsonb('LaLiga Golazos has both a native Flow marketplace (laligagolazos.com/moments/<id>) and Dapper Market (dapper.market/laliga). RPC ingests the on-chain listing feed into cached_listings_v2 (source direct_v2; 296 listings / 135 active as of 2026-07-03). Buy CTAs re-enabled 2026-07-03 (QA cleanup) after the stale 2026-05-18 venue-unknown hold; native + Dapper Market links already built in lib/collections.ts.'::text))
--   WHERE collection_id = '06248cc4-b85f-47cd-af67-1855d14acd75';

DO $$
DECLARE v_old jsonb; v_n int;
BEGIN
  SELECT metadata->'marketplace' INTO v_old FROM public.collection_config
   WHERE collection_id = '06248cc4-b85f-47cd-af67-1855d14acd75';
  IF v_old IS NULL THEN RAISE EXCEPTION 'no Golazos marketplace metadata'; END IF;
  IF v_old->>'secondary_status' IS DISTINCT FROM 'live' OR v_old->>'last_verified_at' NOT LIKE '2026-07-04%' THEN
    RAISE EXCEPTION 'Golazos marketplace row changed since 10-17 (secondary_status %, verified %) — re-derive',
      v_old->>'secondary_status', v_old->>'last_verified_at';
  END IF;
  RAISE NOTICE 'pre-10-17 Golazos marketplace metadata: %', v_old::text;

  UPDATE public.collection_config
     SET metadata = jsonb_set(jsonb_set(jsonb_set(metadata,
           '{marketplace,secondary_status}', '"idle_since_2026_10_02"'),
           '{marketplace,last_verified_at}', to_jsonb('2026-10-18T03:45:00+00:00'::text)),
           '{marketplace,notes}', to_jsonb(
             'LaLiga Golazos: native Flow marketplace (laligagolazos.com) + Dapper Market (dapper.market/laliga), both on NFTStorefrontV2. '
          || 'Re-verified 2026-10-17 (PT) by an independent on-chain count: Golazos.Withdraw events 10-02 -> 10-17 = 1, a pack reveal (PackNFT.Opened), '
          || 'so ZERO secondary trades on any venue; positive control 09-10 -> 09-13 = 54 withdraws = 54 recorded sales. '
          || 'Newest sale 2026-10-01 10:26 PM PT. Book: golazos-storefront-reconcile 4,286 live listings, flat since ~10-10 (0 closes). '
          || 'Idle market, not a blind venue. Listings stay real asks; prices are ASK_ONLY where no sale backs them.'::text))
   WHERE collection_id = '06248cc4-b85f-47cd-af67-1855d14acd75';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'expected 1 row, updated %', v_n; END IF;
END $$;
