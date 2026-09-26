-- 2026-09-25 (PT) — 483 Top Shot pack distributions that 3,061 recorded pack
-- opens point at did not exist in pack_distributions, so those opens rendered
-- as a nameless "Pack" with no image. Same hole as the 151 early All Day dists
-- (20260926030150).
--
-- SOURCES, captured into public.audit_20260925_ts_dist_backfill_source
-- (~8:40 PM PT, via pg_net; kept as the record of what was read):
--   · 419 dists (702–8753): Studio Platform searchDistributions(byProductID:
--     "TopShot", byIDs) — title, tier, slots, uuid, start/end, DEFAULT image.
--     CONTROL: 40 randomly chosen Top Shot dists we already had — title equal
--     on 40/40, image equal on 40/40. One dist (8588) has no image in the API
--     and is left NULL.
--   · 64 recent dists (8761–8870), which the API does not carry: the PDS
--     contract's getDistInfo (title, tier, slots, distributionUUID; every one
--     productID "nba") and the pack NFT's media redirect for the image (one
--     opened pack per dist from pack_rips; the method verified earlier today,
--     20260926015925). 64/64 answered.
--   · 14 randomly chosen target image URLs fetched in full: all image/png.
-- Counts are left unknown (0/0, the dist-8825 convention); the Top Shot supply
-- pipeline (apply_topshot_supply) owns them.
--
-- ⚠ Not replayable on a fresh database: the rows come from the audit table,
-- which holds the reads. On any database without it this migration is a
-- no-op by construction (the post-condition only runs where it exists).
--
-- Revert: DELETE FROM pack_distributions WHERE collection_id =
-- '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND metadata->>'seeded_from' =
-- 'ts_dist_backfill_20260925'.

DO $$
DECLARE v_missing int; v_new int;
BEGIN
  IF to_regclass('public.audit_20260925_ts_dist_backfill_source') IS NULL THEN
    RAISE NOTICE 'audit_20260925_ts_dist_backfill_source absent — nothing to backfill here';
    RETURN;
  END IF;

  INSERT INTO public.pack_distributions (collection_id, dist_id, title, nft_type, image_url, metadata)
  SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd', s.dist_id, s.title, 'A.0b2a3299cc857e29.PackNFT.NFT', s.image_url,
         jsonb_strip_nulls(jsonb_build_object('tier', s.tier, 'number_of_pack_slots', s.slots, 'uuid', s.uuid,
                            'start_time', s.start_time, 'end_time', s.end_time,
                            'seeded_from', 'ts_dist_backfill_20260925', 'source', s.source))
  FROM public.audit_20260925_ts_dist_backfill_source s
  WHERE coalesce(s.title, '') <> ''
  ON CONFLICT (dist_id, collection_id) DO NOTHING;

  -- Post-conditions: every Top Shot dist a rip points at now exists, and the
  -- new rows are titled (all) and pictured (all but the API's one imageless).
  SELECT count(DISTINCT r.dist_id) INTO v_missing FROM public.pack_rips r
   WHERE r.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND r.dist_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.pack_distributions pd WHERE pd.collection_id = r.collection_id AND pd.dist_id = r.dist_id);
  IF v_missing <> 0 THEN RAISE EXCEPTION '% Top Shot dists referenced by rips still missing', v_missing; END IF;
  SELECT count(*) INTO v_new FROM public.pack_distributions
   WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
     AND metadata->>'seeded_from' = 'ts_dist_backfill_20260925' AND coalesce(title, '') <> '';
  IF v_new < 483 THEN RAISE EXCEPTION 'expected >= 483 titled backfilled rows, got %', v_new; END IF;
END $$;
