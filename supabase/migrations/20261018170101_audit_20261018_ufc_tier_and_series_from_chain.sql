-- 2026-10-18 10:01 AM PT (Cowork cloud; Trevor "Keep going" / "Do what you think is best").
-- UFC Strike tier and series corrected from the CHAIN.
--
-- CAUSE: every UFC tier in RPC was FABRICATED from edition size by inferTier()
-- (enrich-ufc-wallet, ufc-enrichment-drain, ufc-listing-cache, seed-ufc-editions):
-- <=10 ULTIMATE, <=99 CHAMPION, <=999 "CHALLENGER", <=25000 "CONTENDER". CHALLENGER and
-- CONTENDER do not exist on chain. The chain's TIER trait (UFC_NFT.getSetMetadata, read
-- 2026-10-18 into public.ufc_chain_set_metadata, migration 20261018160339) is
-- COMMON / UNCOMMON / RARE / EPIC / CHAMPION / ULTIMATE / FANDOM. Measured before this
-- migration over the 517 chain-mapped editions: 503 carried CONTENDER/CHALLENGER; the
-- chain says Common 185, Rare 139, Uncommon 72, Fandom 64, Epic 33, Champion 9.
-- SERIES: 405 editions disagreed with the chain SERIES trait (25 stored 1 / chain 0,
-- 17 stored 1 / chain 2, 363 NULL / chain 1 or 2).
--
-- WHAT CHANGES
--   editions.tier   = upper(chain TIER) where the chain has one; NULL (unknown) where the
--                     chain set carries no TIER (the 14 catchphrase moments) and for any
--                     UFC edition left holding a fabricated CONTENDER/CHALLENGER.
--   editions.series = chain SERIES where the chain has one (the 7 catchphrase editions whose
--                     chain set carries no SERIES keep their stored value: not verifiable,
--                     not changed).
--   wallet_moments_cache.tier / series_number follow editions for every UFC row.
--   trophy_moments (1 UFC row) tier + set_name follow editions.
-- BACKUP: public.audit_20261018_ufc_names_backup rows tbl='editions_m4', 'wmc_m4'
--         ('wallet|moment' key in row), 'trophy_m4'.
-- REVERT: restore editions.tier/series, wmc.tier/series_number and trophy_moments.tier/
--         set_name from those rows (the CONTENDER/CHALLENGER values were fabricated).

DO $$
DECLARE
  c_ufc constant uuid := '9b4824a8-736d-4a96-b450-8dcc0c46b023';
  n int;
BEGIN
  CREATE TEMP TABLE _ch ON COMMIT DROP AS
  SELECT e.id, m.tier AS chain_tier, m.series AS chain_series
    FROM public.editions e
    JOIN public.ufc_chain_set_editions c ON c.edition_id = e.id
    JOIN public.ufc_chain_set_metadata m ON m.set_id = c.set_id
   WHERE e.collection_id = c_ufc;
  SELECT count(*) INTO n FROM _ch; IF n <> 517 THEN RAISE EXCEPTION 'expected 517 chain-mapped UFC editions, got %', n; END IF;
  SELECT count(*) INTO n FROM _ch WHERE chain_tier IS NOT NULL AND upper(chain_tier) NOT IN
    ('COMMON','UNCOMMON','RARE','EPIC','CHAMPION','ULTIMATE','FANDOM');
  IF n <> 0 THEN RAISE EXCEPTION '% chain tiers outside the known ladder', n; END IF;

  -- BACKUP
  INSERT INTO public.audit_20261018_ufc_names_backup(tbl,id,row)
  SELECT 'editions_m4', e.id, jsonb_build_object('tier', e.tier, 'series', e.series)
    FROM public.editions e WHERE e.collection_id = c_ufc;
  INSERT INTO public.audit_20261018_ufc_names_backup(tbl,id,row)
  SELECT 'wmc_m4', gen_random_uuid(), jsonb_build_object('wallet_address', w.wallet_address, 'moment_id', w.moment_id, 'tier', w.tier, 'series_number', w.series_number)
    FROM public.wallet_moments_cache w WHERE w.collection_id = c_ufc;
  INSERT INTO public.audit_20261018_ufc_names_backup(tbl,id,row)
  SELECT 'trophy_m4', gen_random_uuid(), jsonb_build_object('trophy_id', t.id, 'tier', t.tier, 'set_name', t.set_name)
    FROM public.trophy_moments t WHERE t.collection_id = c_ufc;

  -- editions: tier from the chain, NULL where the chain has none
  UPDATE public.editions e SET tier = upper(ch.chain_tier)::public.tier_type, updated_at = now()
    FROM _ch ch WHERE e.id = ch.id AND ch.chain_tier IS NOT NULL AND e.tier IS DISTINCT FROM upper(ch.chain_tier)::public.tier_type;
  UPDATE public.editions e SET tier = NULL, updated_at = now()
    FROM _ch ch WHERE e.id = ch.id AND ch.chain_tier IS NULL AND e.tier IS NOT NULL;
  UPDATE public.editions SET tier = NULL, updated_at = now()
   WHERE collection_id = c_ufc AND tier::text IN ('CONTENDER','CHALLENGER');
  -- editions: series from the chain where it has one
  UPDATE public.editions e SET series = ch.chain_series, updated_at = now()
    FROM _ch ch WHERE e.id = ch.id AND ch.chain_series IS NOT NULL AND e.series IS DISTINCT FROM ch.chain_series;

  -- holdings and the one trophy follow the catalogue
  UPDATE public.wallet_moments_cache w SET tier = e.tier::text, series_number = e.series
    FROM public.editions e
   WHERE w.collection_id = c_ufc AND e.collection_id = c_ufc AND w.edition_key = e.external_id
     AND (w.tier IS DISTINCT FROM e.tier::text OR w.series_number IS DISTINCT FROM e.series::int);
  UPDATE public.trophy_moments t SET tier = e.tier::text, set_name = e.set_name
    FROM public.editions e
   WHERE t.collection_id = c_ufc AND e.collection_id = c_ufc AND t.edition_id = e.external_id
     AND (t.tier IS DISTINCT FROM e.tier::text OR t.set_name IS DISTINCT FROM e.set_name);

  -- POST-CONDITIONS
  IF EXISTS (SELECT 1 FROM public.editions WHERE collection_id = c_ufc AND tier::text IN ('CONTENDER','CHALLENGER')) THEN
    RAISE EXCEPTION 'a fabricated UFC tier survived on editions';
  END IF;
  SELECT count(*) INTO n FROM public.editions e JOIN _ch ch ON ch.id = e.id
   WHERE e.tier IS DISTINCT FROM upper(ch.chain_tier)::public.tier_type
      OR (ch.chain_series IS NOT NULL AND e.series IS DISTINCT FROM ch.chain_series);
  IF n <> 0 THEN RAISE EXCEPTION '% editions still disagree with the chain', n; END IF;
  IF EXISTS (SELECT 1 FROM public.wallet_moments_cache w JOIN public.editions e
               ON e.collection_id = w.collection_id AND e.external_id = w.edition_key
              WHERE w.collection_id = c_ufc
                AND (w.tier IS DISTINCT FROM e.tier::text OR w.series_number IS DISTINCT FROM e.series::int)) THEN
    RAISE EXCEPTION 'a UFC holdings row disagrees with its edition';
  END IF;
END $$;
