-- audit_20261029_reprice_topshot_rips_frozen_at_a_dead_ask — 2026-10-29 10:42 AM PT applied (Claude Code cloud).
--
-- /insights/pack-reality ranked "Arike's Record Night" ($6 pack, 283 opens) as its top sleeper at
-- 2864% of model: realised mean $196 against a $5.53 median. 19 of its rips carry pull_value_usd =
-- $2,700, which is $51,300 of the dist's $55,528. That is the first FMV of edition 259:9310::19
-- (Hexwave /25), ASK_ONLY at 0.9 x a lone $3,000 listing on 10-02 2:16 PM PT, with no sale ever.
-- The rips were priced 37 minutes later, and the FMV fell to $22.49 on 10-09 and $13.49 on 10-23.
--
-- The column's contract is CURRENT FMV (20260913032000), kept current by backfill_pack_rip_metadata's
-- stale_valued leg. That leg cannot keep up: hourly at p_limit 1500 it re-prices ~300 rows/h, but
-- 339,118 of 394,033 valued rips are past its 7-day mark (oldest stamp 09-24). That throughput is
-- filed separately; this migration repairs only the material harm.
--
-- WHAT CHANGES: Top Shot rips whose stored value is >= $250 and whose CURRENT whole-pack value
-- (same all-or-nothing rule as the writer: every moment priced and every moment in
-- moment_acquisitions) is under a fifth of it. Measured 10-29: 44 rips, stored $75,620 -> current
-- $3,799. Each gets the current sum and a fresh metadata_updated_at, which is exactly what the
-- stale leg would write when it reached them. No other row is touched.
-- REVERT (should never be wanted; the stale leg would write the same values): the 44 pre-repair
-- values, id=pull_value_usd, captured immediately before the apply:
--   0314b054-30f4-413c-ad7c-a6430d2337e5=2700.00  0e1e7b0d-f3a0-4929-a562-83bc8eff3722=899.10
--   0e3008e1-46c5-4d8e-b680-325b9834fbc6=675.00  1acfac48-c2cf-4623-a382-b466601c4fce=2700.00
--   1c8893b3-8637-44f9-8cb3-9a019aa7fd89=499.50  2231c1b5-5f74-4bdd-8868-3fc0015d280b=2700.00
--   37ccfea8-07d4-4cec-9a60-d26d30513811=2700.00  397dd3c5-8129-4d16-93b3-188816f0764a=2700.00
--   4a2c72ee-8ee9-421a-bac4-35c24e7996f1=2700.00  5026c5f2-f5a9-44fc-8ae2-09100b8efd83=579.97
--   55662426-e2db-498a-a3d2-382e298621a9=2700.00  58c1d65d-5d3a-4e27-bd2e-2215dd6aa222=360.17
--   5e911179-7caa-4260-a55f-e32491e703ed=2700.00  658dd4d1-7bf7-4b97-95cc-e5f3fc86adf0=2700.00
--   6818996d-17bd-45eb-88d4-04bd4a48ed97=902.63  6ae0c369-9a35-432a-b363-3f5c6399ce19=4464.90
--   6fafb1db-809b-44bd-97c9-136bcb3238ac=2700.00  73841c16-2eba-4180-a127-84be90fd7dfd=2700.00
--   79d13a71-6574-4dcc-a39d-5c55f1125b42=2700.00  7fe1a7d3-67cf-4ad5-941e-a132839ecfcc=574.60
--   816977cb-3e70-482d-8dfa-cc5f9a2c2606=360.00  8532735f-6e2f-48f0-b527-5f868177c110=2700.00
--   86886306-dbdf-4058-8b16-9a64e49b829a=2250.00  8c19b5d8-5a91-4fd6-9fb6-8baabcc087cd=502.14
--   8e4c558b-194c-42f4-b48e-0b550686423a=2250.00  94f75128-6584-4c04-8d8b-7f4a9a040784=360.00
--   a6f04b94-26ce-453c-bf5c-063e1df6c2c2=895.50  ac2ebd28-ba0c-4244-9649-5e34837a0338=360.00
--   ae0b890b-dafc-4256-bcb8-0faf11af8e64=2700.00  b1410708-0ea0-4d9b-a224-15080d35f5dd=2700.00
--   b961d206-f24d-4b87-be11-5f8d5f122073=720.00  b9dac2bb-aa01-4299-ae92-f40a449e12a0=908.41
--   c5dfb0be-115a-40df-a752-30c412028365=902.09  c6d74597-370d-4f30-ac15-f07402c9f2e7=675.00
--   ca1afcb4-cbf0-4f4c-a863-10c1357cc66e=2250.00  d3766086-2f8a-4c33-9871-b754a3ec35c1=2700.00
--   d4b3da39-26af-4476-a880-54725e2135ea=675.00  dfa27b43-252e-455c-aec5-f06caeee10a4=360.00
--   e9733f46-3718-41f6-bfa3-6650e746381a=2700.00  e99a67d8-02a9-456d-8f90-469fbdf6bb6a=2700.00
--   ea10a44e-fc21-4c0f-94e7-80725b465208=500.70  f3373bb8-f190-4927-af89-277c65ff643a=895.50
--   fc48d9cc-3321-4723-a226-5bf1d36244e7=499.50  fffe4e69-a0b4-429f-a9ea-86f0994b18ae=2700.00

DO $mig$
DECLARE
  v_n integer;
BEGIN
  WITH big AS (
    SELECT pr.id, pr.collection_id, pr.moments_pulled, pr.pull_value_usd
      FROM public.pack_rips pr
     WHERE pr.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
       AND pr.pull_value_usd >= 250
  ), cur AS (
    SELECT b.id, b.pull_value_usd AS stored, SUM(fc.fmv_usd)::numeric(14,2) AS curv
      FROM big b
      JOIN public.moment_acquisitions ma ON ma.source_pack_rip_id = b.id
      LEFT JOIN public.moments m ON m.nft_id = ma.nft_id AND m.collection_id = b.collection_id
      LEFT JOIN LATERAL (
        SELECT s.fmv_usd, s.collection_id
          FROM public.fmv_snapshots s
         WHERE s.edition_id = m.edition_id
         ORDER BY s.computed_at DESC
         LIMIT 1
      ) fc ON fc.collection_id = m.collection_id
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
  IF v_n < 30 OR v_n > 60 THEN
    RAISE EXCEPTION 'expected ~44 re-priced rips, got %', v_n;
  END IF;
  RAISE NOTICE 're-priced % rips', v_n;
END
$mig$;
