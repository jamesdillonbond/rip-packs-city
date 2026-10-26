-- docs/audits/2026-10-23-golazos-marketplace-status-thin-not-idle.sql
-- ✅ APPLIED (verified live 2026-10-25 ~6:50 PM PT, Cowork cloud): collection_config for laliga_golazos reads
-- secondary_status 'thin_since_2026_10_02', last_verified_at 2026-10-23T22:05:00+00:00 and the re-verified notes
-- below. Who ran it and when was not recorded; the PARKED note below is history. Kept as the record + revert.
--
-- PARKED 2026-10-23 ~3:12 PM PT (Cowork cloud, autonomous pass): the MCP returned "cancelled" for this
-- data write (the operator's confirmation hold on plain UPDATEs; precedent 20261018041800, applied by
-- Trevor in the dashboard SQL editor). ONE statement; paste it into the dashboard SQL editor, run, then
-- read back v_collection_marketplace_status for laliga_golazos. Nothing on screen changes (status stays
-- 'healthy', so MarketplaceStatusBanner renders only the info notice); /api/marketplace-status and the
-- record itself stop publishing an "idle" claim the chain refutes.
--
-- MEASURED (independent of every RPC ingest lane): Flow REST, A.87ca73a41bb50ad5.Golazos.Withdraw over
-- blocks 168,261,658 -> 168,761,125 (10-19 00:00 PT -> 10-23 3:03 PM PT), 1,998 x 250-block ranges,
-- 0 failed: 88 Withdraws — 64 on 10-20 and 24 on 10-21 (UTC) — exactly the 64 + 24 `sales` rows for
-- those days ($188 total); 0 on 10-19, 10-22 and 10-23. The 10-17 verdict ("idle since 10-02, not a
-- blind venue") was right for its window; the market now trades in bursts. Book: 4,584 live listings
-- (golazos-storefront-reconcile, 3 PM PT 10-23).
--
-- ⚠ Deliberately NOT a 'dormant_*' value (FlowtyDormancyChip keys on startsWith("dormant") and names Flowty).
-- REVERT: secondary_status 'idle_since_2026_10_02', last_verified_at '2026-10-18T03:45:00+00:00', notes = the
--   20261018041800 text.

UPDATE public.collection_config
   SET metadata = jsonb_set(jsonb_set(jsonb_set(metadata,
         '{marketplace,secondary_status}', '"thin_since_2026_10_02"'),
         '{marketplace,last_verified_at}', to_jsonb('2026-10-23T22:05:00+00:00'::text)),
         '{marketplace,notes}', to_jsonb(
           'LaLiga Golazos: native Flow marketplace (laligagolazos.com) + Dapper Market (dapper.market/laliga), both on NFTStorefrontV2. '
        || 'Re-verified 2026-10-23 (PT) by an independent on-chain count: Golazos.Withdraw events 10-19 -> 10-23 = 88, all on 10-20 (64) and 10-21 (24) '
        || '= exactly the 88 recorded sales ($188 total); 0 on 10-19 and 10-22/23. Before that, 0 trades 10-02 -> 10-19 (one pack reveal). '
        || 'Thin market that trades in bursts, not an idle one and not a blind venue. Book: golazos-storefront-reconcile 4,584 live listings. '
        || 'Listings stay real asks; ASK_ONLY prices are capped at the edition''s own recent sales (#208, 20261023134231).'::text))
 WHERE collection_id = '06248cc4-b85f-47cd-af67-1855d14acd75'
   AND metadata->'marketplace'->>'secondary_status' = 'idle_since_2026_10_02';
-- expect: UPDATE 1
