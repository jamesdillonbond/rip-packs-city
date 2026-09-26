-- 2026-09-25 (PT) — #142 root cause (one of its two classes): the Top Shot
-- on-chain sales indexer read wallet_moments_cache by moment_id with NO
-- collection filter, so a foreign collection's row (All Day nft 6024287,
-- Amon-Ra St. Brown #2630) answered for the Top Shot nft with the same id
-- (LaMelo Ball 35:816). The foreign edition_key failed the Top Shot lookup,
-- so the EDITION fell through to `moments` and landed correctly — but the
-- SERIAL had already been taken from the foreign row and the fall-through
-- only fills a null. Code fix: app/api/sales-indexer/route.ts (4a lookup
-- scoped to TOPSHOT_COLLECTION_ID) + the tree-walk guard
-- wallet-moments-cache-moment-id-reads-are-collection-scoped.test.ts.
--
-- This migration repairs the rows the fix leaves behind. Population (measured
-- 9:40 PM PT): sales.source = 'onchain', Top Shot, whose serial equals a
-- foreign-collection cache row's serial for the same moment_id (333), plus
-- 6 whose serial merely disagrees with `moments` (the same defect while the
-- foreign row still existed). Among the 263 rows a Top Shot source could
-- check, ZERO carried the true serial by coincidence, so a foreign-matching
-- serial is treated as wrong throughout.
--   • from `moments` (Top Shot-keyed; agrees with the sale on 168,294 of
--     168,402 onchain sales — the 108 disagreements ARE this defect): 108
--   • from the Top Shot wallet_moments_cache row for the moment:            79
--   • from the chain (TopShot.MomentCollectionPublic.borrowMoment in the
--     buyer's collection, read 2026-09-25 ~9:40 PM PT; 82 of the 152 still
--     held by their buyer; set:play checked against the sale's edition):    82
--   • the rest cannot be confirmed by any Top Shot source → serial NULL
--     (unknown), never 0 (a measured value):                                 ≤70
-- Every changed row is copied to audit_20260925_sales_foreign_serial_backup
-- first (sale_id, old/new serial, which source decided).
--
-- Revert: UPDATE sales s SET serial_number = b.old_serial FROM
-- audit_20260925_sales_foreign_serial_backup b WHERE b.sale_id = s.id;

CREATE TABLE IF NOT EXISTS public.audit_20260925_sales_foreign_serial_backup (
  sale_id uuid PRIMARY KEY,
  nft_id text,
  old_serial int,
  new_serial int,
  truth_source text NOT NULL,
  repaired_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_20260925_sales_foreign_serial_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260925_sales_foreign_serial_backup FROM PUBLIC, anon, authenticated;

DO $$
DECLARE v_ts uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd'; n1 int; n2 int; n3 int; n4 int;
BEGIN
  -- the population: onchain Top Shot sales carrying a foreign cache row's serial, or disagreeing with moments
  CREATE TEMP TABLE _pop ON COMMIT DROP AS
  SELECT s.id AS sale_id, s.nft_id, s.serial_number AS old_serial, s.edition_id
    FROM public.sales s
   WHERE s.collection_id = v_ts AND s.source = 'onchain' AND s.nft_id IS NOT NULL
     AND (
       EXISTS (SELECT 1 FROM public.wallet_moments_cache w
                WHERE w.moment_id = s.nft_id AND w.collection_id <> v_ts AND w.serial_number = s.serial_number)
       OR EXISTS (SELECT 1 FROM public.moments m
                   WHERE m.nft_id = s.nft_id AND m.edition_id = s.edition_id AND m.serial_number > 0 AND m.serial_number <> s.serial_number)
     );

  -- 1. moments (same edition, serial known)
  INSERT INTO public.audit_20260925_sales_foreign_serial_backup (sale_id, nft_id, old_serial, new_serial, truth_source)
  SELECT p.sale_id, p.nft_id, p.old_serial, m.serial_number, 'moments'
    FROM _pop p JOIN public.moments m ON m.nft_id = p.nft_id AND m.edition_id = p.edition_id AND m.serial_number > 0
   ON CONFLICT (sale_id) DO NOTHING;
  GET DIAGNOSTICS n1 = ROW_COUNT;

  -- 2. the Top Shot cache row for the moment
  INSERT INTO public.audit_20260925_sales_foreign_serial_backup (sale_id, nft_id, old_serial, new_serial, truth_source)
  SELECT p.sale_id, p.nft_id, p.old_serial, w.serial_number, 'wallet_moments_cache:topshot'
    FROM _pop p JOIN LATERAL (SELECT serial_number FROM public.wallet_moments_cache w WHERE w.moment_id = p.nft_id AND w.collection_id = v_ts AND w.serial_number > 0 LIMIT 1) w ON true
   ON CONFLICT (sale_id) DO NOTHING;
  GET DIAGNOSTICS n2 = ROW_COUNT;

  -- 3. read on chain (set:play must equal the sale's edition; a mismatch is recorded, not applied)
  INSERT INTO public.audit_20260925_sales_foreign_serial_backup (sale_id, nft_id, old_serial, new_serial, truth_source)
  SELECT p.sale_id, p.nft_id, p.old_serial,
         CASE WHEN e.external_id = v.ext THEN v.serial ELSE NULL END,
         CASE WHEN e.external_id = v.ext THEN 'onchain:borrowMoment' ELSE 'onchain:edition_mismatch:' || v.ext || '#' || v.serial END
    FROM (VALUES
('ee257e3f-c074-4737-98b1-ed2b1231164c'::uuid, '10252083', '26:1060', 34183),
('c8b11803-9963-4181-b23e-b8c3bbae5bb0'::uuid, '10297019', '26:1062', 9119),
('08be0232-80a2-4301-8bed-1cb96ff079c8'::uuid, '10406095', '26:1065', 13195),
('a31dc200-bcad-438f-ae61-88b6f89456df'::uuid, '1172937', '26:487', 1772),
('4f883c9c-b745-4f62-b841-6e3c131e0de0'::uuid, '1173021', '26:487', 1856),
('43c15efe-3586-4ed8-8b5e-e308027b6dd1'::uuid, '1205959', '26:502', 1669),
('a27f2fff-515a-4c99-b335-f139d5e750b1'::uuid, '1206132', '26:497', 842),
('a2dae27e-73a7-4c47-8054-0de2702988bb'::uuid, '1702623', '26:497', 9193),
('4a749f52-2ad6-4ca8-b805-553e42e370b5'::uuid, '1910657', '26:494', 10200),
('5b423d25-e2b0-4d4f-ba80-8556fcfebeec'::uuid, '1986053', '26:533', 6209),
('f31ceb6f-7afb-48db-a40d-8d507e633124'::uuid, '2190607', '26:549', 7005),
('7ab7a15b-a8ad-4bc7-8e35-447d50c4a21e'::uuid, '2373300', '26:563', 10948),
('5236fcb8-adbd-4986-9df0-c187b26dc924'::uuid, '241054', '6:105', 1118),
('303cbc6a-666c-4717-8cd5-d65ae946b2de'::uuid, '2536091', '26:540', 14236),
('fbf5e96c-79c7-40fb-be56-168d88f43224'::uuid, '2538850', '26:540', 14620),
('d256931f-a4d1-40ae-8ff3-863a555e33a9'::uuid, '2706250', '33:623', 2046),
('0ca9037c-8ca7-4d98-a02c-3506fc74d869'::uuid, '2814414', '26:635', 15247),
('2376530a-8f88-451d-a6a1-f10f3013ea82'::uuid, '3013161', '26:657', 2815),
('ee5cd251-0fd9-4ce6-8e38-22b397ac9550'::uuid, '3064900', '26:662', 4554),
('fe208636-d42e-4550-80a2-bfa29b4d9839'::uuid, '3106198', '26:669', 8852),
('7201394e-6376-4b2b-b499-33a82734dfc8'::uuid, '3140167', '26:678', 5821),
('bc00c355-c358-465d-8012-4623e868f5af'::uuid, '3555704', '26:741', 19358),
('f76f33cf-7920-4863-aeca-df5e75192b05'::uuid, '3741911', '26:769', 5565),
('7c8ab9c3-ac1e-4357-a3ca-67555a138acf'::uuid, '4050293', '26:670', 4733),
('45dd6a6a-92de-41ef-8e33-64b3d9243715'::uuid, '415424', '2:97', 1912),
('d1551980-8ee5-4fca-a0ae-af67c780aa7e'::uuid, '4227422', '26:695', 2737),
('541cb8cc-76fd-4b3e-91be-4752baf8b6ff'::uuid, '4244991', '26:695', 20306),
('9af9bfca-f0e0-4e40-aef6-d45bafda4f57'::uuid, '4434521', '26:716', 2836),
('03fa988d-ccce-49fc-87a3-8849b0eeebe5'::uuid, '4557876', '26:736', 22191),
('d2bfc406-ce92-483b-a470-7de3e21ac963'::uuid, '4617843', '26:748', 7158),
('e3fd691c-8f89-4239-a216-9342d429f5e0'::uuid, '4635509', '26:750', 12824),
('a7ada718-9a8f-4a5d-a8bf-ab0f2469133c'::uuid, '4638989', '26:750', 16304),
('682450e6-eedc-4218-b852-4d77b7dcab2e'::uuid, '4802404', '26:771', 5719),
('2e23c1d0-c9f9-4e0b-b289-0692c2d6414b'::uuid, '4909860', '32:783', 1157),
('e248b7ee-bcfd-4ca4-b8a9-0e0feb56673a'::uuid, '5039694', '26:657', 25409),
('497f7230-b136-4ec6-968e-85982efb6c37'::uuid, '5238144', '34:793', 7781),
('15e2b6fc-df2a-4aa6-b78b-06734b290101'::uuid, '5398678', '34:810', 8315),
('954dddbd-8b6b-4620-9802-c0bc83fade82'::uuid, '5745653', '26:677', 30290),
('caa4df1c-4699-46d9-a29d-5348503f20f3'::uuid, '5788000', '26:695', 32637),
('02170a2e-0713-4846-a061-14dd20ef8d7d'::uuid, '5789578', '26:695', 34215),
('45c04bac-0d1a-4ba3-ade0-f65ab45fe1e8'::uuid, '5957983', '26:761', 32620),
('af046f36-d1f1-4acf-a7eb-efc996e7f3c1'::uuid, '6084188', '36:850', 1001),
('853ebeaf-0c6b-45c6-89f7-fc12252f65da'::uuid, '6715802', '26:689', 22468),
('31a5d484-eea5-48fd-afe4-d5a0315a1746'::uuid, '6909597', '26:710', 17079),
('2b9a5041-6062-4169-8951-edff33650e65'::uuid, '7090826', '26:734', 11308),
('b19392f8-92aa-4fe7-8d5b-1ba1b631a7bc'::uuid, '7248633', '26:749', 29115),
('8cae40d8-9759-40c7-ab9a-e9f4b08e68f5'::uuid, '7261596', '26:752', 7078),
('def91e95-dca3-4726-beec-09f9abe7c58c'::uuid, '7358577', '26:762', 22059),
('673f3135-79f5-4bf9-b761-c32b47ee50af'::uuid, '7359425', '26:762', 22907),
('678979af-63e8-4ef2-934b-b274226bfbf9'::uuid, '7366399', '26:762', 29881),
('e4a12fbc-6c06-4e77-8cc8-8107989b50ca'::uuid, '7596963', '34:790', 2816),
('a7541732-0ec2-40d1-8965-0abb2a2a67d4'::uuid, '7601159', '34:835', 1790),
('2fb82512-97ef-4cb4-a3dd-67662d644e34'::uuid, '7758775', '26:925', 18764),
('0bb1fbe4-33c5-422c-bb35-1abd6852923d'::uuid, '7834246', '26:928', 8485),
('8862ae13-d954-4a6e-bcbe-c8697ae1984e'::uuid, '8053019', '32:938', 1741),
('f39506b9-7e84-44de-9362-212f63957254'::uuid, '8178725', '26:944', 26372),
('1dfe0ad4-f8f1-4db3-91a2-21e1e40f7df8'::uuid, '8197903', '26:945', 12050),
('d3ec6a71-61e6-4d22-b052-b221fc0ccb2e'::uuid, '833028', '26:385', 629),
('a0d0eae2-c7be-46b0-822f-7b40b4392bf3'::uuid, '83677', '2:70', 382),
('3933b4bb-9f12-44d5-ac8d-6dd9c07daad0'::uuid, '845209', '26:407', 310),
('7986209b-3735-4d16-b3fd-d8c15e1e42d5'::uuid, '8504651', '26:958', 8298),
('a7bf495b-91e8-471b-bd07-41de588b34ec'::uuid, '8915884', '26:1006', 3778),
('d8240a5d-f988-458f-95cf-7f7d6d146c64'::uuid, '8997924', '26:1001', 16943),
('8ac99d9c-caaf-4473-8206-e7fcbb19efef'::uuid, '9009737', '26:1016', 6756),
('3702bcf1-a8f9-498a-996d-2209ae2ff07a'::uuid, '9052645', '26:1023', 2539),
('c04409fb-aff1-4193-b8f5-15d362526f56'::uuid, '9097649', '26:1001', 20043),
('3ac412eb-f808-4f08-ab83-e78efb3ec1d1'::uuid, '9104116', '26:1018', 3385),
('3ac23879-f08c-4140-9033-5842e6e4ca65'::uuid, '9164855', '26:1029', 2874),
('552bcfb6-ef5d-4c81-9bdd-ab383ddbd10f'::uuid, '918960', '26:389', 3186),
('fc4e50ef-eb32-4e3d-a7c2-dfe078837eaf'::uuid, '9206803', '26:1018', 5822),
('54b5551a-1d35-4cd2-b51d-2d8ecc78f326'::uuid, '9215490', '26:1023', 5634),
('da88185e-8ac1-4a5e-879d-a685bd26be38'::uuid, '9252235', '26:1012', 6379),
('f3eaa85f-12f3-4f9e-ab53-ce3f2e6179fa'::uuid, '9259785', '26:1018', 6429),
('262470e4-cf9c-4491-97ce-a08920b1c297'::uuid, '938228', '26:404', 3204),
('48cade71-c4be-4984-8fa5-8eb606bd668a'::uuid, '9414001', '26:1018', 9895),
('03434b92-4665-41eb-be09-b25f87ab2a8a'::uuid, '9436177', '26:1029', 9571),
('527e3ce0-16b2-4768-b6ae-1332a31ac788'::uuid, '9437976', '26:1014', 11120),
('f927aa7d-ffb6-47e0-92c8-78f79ae9d2d8'::uuid, '9545266', '32:1030', 5084),
('7706e168-e3cc-4eca-a942-8d759afd07e7'::uuid, '9632276', '37:1036', 13500),
('aeb8fe44-3d1b-4218-8d91-629017ef5aec'::uuid, '9717971', '26:1041', 27150),
('d415c64a-73c7-494c-85db-8743e919cc15'::uuid, '9831286', '26:1045', 465),
('5c6f30ff-5f42-4152-aa2c-9e7333ee2f72'::uuid, '9832644', '26:1045', 1823)
    ) AS v(sale_id, nft_id, ext, serial)
    JOIN _pop p ON p.sale_id = v.sale_id
    JOIN public.editions e ON e.id = p.edition_id
   ON CONFLICT (sale_id) DO NOTHING;
  GET DIAGNOSTICS n3 = ROW_COUNT;

  -- 4. unconfirmed → unknown
  INSERT INTO public.audit_20260925_sales_foreign_serial_backup (sale_id, nft_id, old_serial, new_serial, truth_source)
  SELECT p.sale_id, p.nft_id, p.old_serial, NULL, 'unconfirmed:set_null'
    FROM _pop p
   ON CONFLICT (sale_id) DO NOTHING;
  GET DIAGNOSTICS n4 = ROW_COUNT;

  UPDATE public.sales s SET serial_number = b.new_serial
    FROM public.audit_20260925_sales_foreign_serial_backup b
   WHERE b.sale_id = s.id AND s.serial_number IS DISTINCT FROM b.new_serial;

  RAISE NOTICE '#142 foreign-serial repair: moments %, ts cache %, onchain %, unconfirmed→NULL %', n1, n2, n3, n4;
  IF n1 + n2 + n3 + n4 < 300 THEN RAISE EXCEPTION 'population smaller than measured (% rows) — re-derive before applying', n1 + n2 + n3 + n4; END IF;
  -- post-condition: no onchain Top Shot sale still carries a foreign row's serial
  IF EXISTS (SELECT 1 FROM public.sales s WHERE s.collection_id = v_ts AND s.source = 'onchain'
              AND EXISTS (SELECT 1 FROM public.wallet_moments_cache w WHERE w.moment_id = s.nft_id AND w.collection_id <> v_ts AND w.serial_number = s.serial_number)) THEN
    RAISE EXCEPTION 'foreign serials remain';
  END IF;
  -- the LaMelo Ball sale that named the defect reads its moments serial now
  IF (SELECT serial_number FROM public.sales WHERE nft_id = '6024287' AND collection_id = v_ts AND source = 'onchain' LIMIT 1) <> 1843 THEN
    RAISE EXCEPTION 'LaMelo 35:816 nft 6024287 not repaired';
  END IF;
END $$;
