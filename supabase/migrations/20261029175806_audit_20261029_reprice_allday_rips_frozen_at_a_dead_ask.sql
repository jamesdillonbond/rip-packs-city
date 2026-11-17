-- audit_20261029_reprice_allday_rips_frozen_at_a_dead_ask — 2026-10-29 10:58 AM PT applied (Claude Code cloud).
--
-- All Day leg of 20261029174207 (#217). pack_rips.pull_value_usd is contractually CURRENT FMV, but
-- rollup_allday_rip_pull_value re-prices only on NEW pulls (allday_pack_pull.updated_at) and the stale
-- leg covers ~1/8 of the population. 72 All Day rips stored >= $250 had a current whole-pack value
-- under a fifth of it: $56,586 stored -> $5,076 current. Twenty of them are 1,799.10 = 0.9 x a
-- $1,999 ask, the ASK_ONLY signature.
--
-- WHAT CHANGES: those rips get the current sum, by the All Day writer's own rule (exact join on
-- pack_nft_id to allday_pack_pull, latest fmv_snapshots per edition, every pull priced and pull
-- count = moments_pulled), plus a fresh metadata_updated_at. No other row is touched.
--
-- REVERT (should never be wanted; the stale leg would write the same values): the 72 pre-repair
-- values, id=pull_value_usd, captured immediately before the apply:
--   00bf4b20-cee2-4f8e-bee4-5d655e1b0488=278.20  04886ab5-1cca-45b6-845e-addeb337e466=459.50
--   066ffb2f-62cc-4677-a743-c99a539308a9=459.50  0bd321ae-8e62-42a8-b6b5-3dca78d230ee=272.33
--   0c60cf95-dbb4-40ad-b342-96310fa16fae=318.54  0e0ce7c4-ebec-4446-b76c-2a8a8416ff8f=459.50
--   141ecaea-2e9d-4549-8e2f-53ef8e54a1fe=308.78  164b072c-332b-4e50-ba6e-d2798117ff99=272.33
--   16c039f7-8fed-4c82-9bc4-23f8920f0074=838.21  22322a52-d119-405a-9c8a-a56950eb3da7=261.20
--   27384ba6-4869-4176-a1c7-e5e540e232df=1179.32  2a814edd-a0fe-400c-8361-aa8fa6510a48=1799.10
--   2f1a35ef-247d-4cc6-a50f-6d548e3620af=277.49  31fa60ea-1c5c-4905-9a64-053f7b683396=1799.10
--   347d0757-3df4-4a29-af90-eb9ffed4eeef=360.00  35ecc7be-8d4e-46b1-8fbb-514e77fde1e2=272.33
--   366de81f-130f-4cd9-9ff9-20167a30789c=272.33  3ce6e4f7-c5ac-4bcc-b47d-7bc4014ba6f2=272.33
--   3eb5f98d-bc16-4d9b-a36c-63ee132e8ddb=459.50  3edc81d5-ffb3-42e6-8767-ca2b14c533a7=1656.05
--   40e4f39b-05b1-436b-8938-dab2509ba01d=1799.10  4a3fb057-023c-4adc-ad8d-096cdcea5089=459.50
--   4c532577-f555-4c57-9581-5d1b22bfcd87=459.50  549f2893-43e4-4e9d-90aa-fe7ed7bd4d66=465.61
--   5cf9555f-39db-4e84-b46e-f2ab726383a1=286.08  5dbad440-5747-46d4-8609-d1fc636249ab=459.50
--   5e940df0-baf7-465a-a860-d7777521ba27=1799.10  5f10b0ee-e921-4d12-97f4-35c06746f406=1799.10
--   65e0a290-a5cd-4893-8e61-bef70a567176=459.50  660ff9fc-34c7-4e27-903c-d3905a875885=807.40
--   69173b70-448d-47a4-af0e-2ae8a2d123c8=1089.32  6a3d5bd0-b906-4b58-88a8-58ceefcf7f04=272.33
--   6aaf5ce9-1484-4bc7-a6b8-8cd2103cecdf=272.33  6ad08907-a892-4161-8c9b-8506c94f1450=1799.10
--   6badf274-46cc-4353-96a8-0491ce5dbbc1=261.20  6c7536ae-cb42-49bd-80bf-210f2b836443=459.50
--   6f59d080-1bb0-4967-9a48-4a46cd12e538=1799.10  74b1dcb3-007b-4921-923f-a7f6bed88425=459.50
--   795e6113-bc91-4fb8-9596-bddf95bc7a6d=263.75  7e6f605a-4ef2-4e0e-afb2-837e16bcfc77=272.33
--   7e97056e-2cda-4412-b952-41d52b1deb32=272.33  81914372-aeec-4b76-8734-0f8b60352af3=522.40
--   81e3f14f-635e-4848-87c0-d18c126538be=459.50  8970bd19-d511-459e-a8c0-e700ec871a6c=1799.10
--   8b85d289-2c7a-485f-9752-5ee26306dea8=1799.10  903cbde1-bf0e-4036-b2ae-538bccfc80b3=1799.10
--   970e192d-6e9d-45d2-b4d7-d1ffd701ef52=459.50  982b4917-9bfc-4219-b76a-89a73e31e349=273.43
--   a068bfcb-70cd-4af1-9c82-93a2a30cd99a=303.50  a87dc3f8-40e6-4b96-9fac-5ad2bbdc7ad6=701.08
--   aa30f703-365b-45b9-8f7e-dbb45d8ff9f4=494.00  b7611d87-8e0b-4f64-af64-1ad07109fe74=1816.80
--   c57ee044-ea54-478c-bc32-6ef3bebca0bf=272.33  c6c342c6-639e-4e32-9025-7b618977a38b=542.20
--   cc81efaa-46d1-4da7-8b0f-f187f37775dc=459.50  ccb31050-893f-4916-95c3-bf23bd0ab2bd=533.90
--   d19e59ee-ef03-4f90-8226-a7fde75f3fa8=1799.10  d4cf189c-a6a9-403c-9fe3-744ac60a662a=1799.10
--   dc70df71-c51c-4a96-ad2d-5c9bbc87d1aa=1799.10  dca9c9c2-569d-45aa-af51-8d989d183eae=267.50
--   de6a85ec-9433-4b2f-9f7a-1da0d8cc466f=1799.10  e3e4de4f-884a-4522-b335-4dfd00c5614f=459.50
--   e5fd58d4-c2ab-4381-8ed5-4d4ac15d15a3=449.57  e6c02136-b35e-4eeb-abb3-fbb26ce815a5=459.50
--   ec4ba1a9-9eac-44dc-bfe8-0941e3c9ece0=1799.10  eec2b2a2-1360-45bd-9581-c6c4a9b2a11a=459.50
--   effb8a10-d180-47ac-b29b-89cda3c75b29=278.33  f6694d07-b189-4da4-bb35-cac6b4f3af57=1799.10
--   f877d463-b257-47b2-a004-e9f87a766336=360.00  f9fd3354-1028-4e5b-9e45-0e0e0d194f06=1799.10
--   fe9597fe-ce3c-46db-ad2b-439d2b711707=272.33  ff438243-a163-406b-bcd4-0d9125e4b83a=459.50

DO $mig$
DECLARE
  v_n integer;
BEGIN
  WITH big AS (
    SELECT pr.id, pr.pack_nft_id, pr.moments_pulled, pr.pull_value_usd
      FROM public.pack_rips pr
     WHERE pr.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
       AND pr.pull_value_usd >= 250
  ), cur AS (
    SELECT b.id, b.pull_value_usd AS stored, SUM(fc.fmv_usd)::numeric(14,2) AS curv
      FROM big b
      JOIN public.allday_pack_pull ap ON ap.pack_nft_id = b.pack_nft_id
      LEFT JOIN LATERAL (
        SELECT f.fmv_usd
          FROM public.fmv_snapshots f
         WHERE f.edition_id = ap.edition_id
         ORDER BY f.computed_at DESC
         LIMIT 1
      ) fc ON true
     GROUP BY b.id, b.pull_value_usd, b.moments_pulled
    HAVING count(*) = count(fc.fmv_usd)
       AND count(*) = b.moments_pulled
  ), upd AS (
    UPDATE public.pack_rips pr
       SET pull_value_usd = c.curv,
           metadata_updated_at = now()
      FROM cur c
     WHERE pr.id = c.id
       AND c.curv > 0
       AND c.curv < c.stored / 5
    RETURNING 1
  )
  SELECT count(*) INTO v_n FROM upd;
  IF v_n < 50 OR v_n > 95 THEN
    RAISE EXCEPTION 'expected ~72 re-priced rips, got %', v_n;
  END IF;
  RAISE NOTICE 're-priced % rips', v_n;
END
$mig$;
