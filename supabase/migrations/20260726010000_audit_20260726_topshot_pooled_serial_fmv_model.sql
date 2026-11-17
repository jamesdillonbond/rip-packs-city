-- audit_20260726_topshot_pooled_serial_fmv_model
-- Multi-factor pooled (hedonic-ridge) special-serial FMV model for Top Shot. Handoff Item 5.
-- Fit OFFLINE in Python (ridge = partial pooling) on 730d of TS #1/perfect sales with a
-- HIGH/MEDIUM base FMV (n=1501); set is the dominant added factor (06-19 factor analysis),
-- player evaluated but added no out-of-sample value under shrinkage so it is left unseeded (table kept
-- for future). At read time this is a per-edition power law est = k_edition * fmv^b_log_fmv, always fresh
-- (fmv/circ/tier read live; only learned set multipliers stored). Validated: rolling 5-fold forward-chaining
-- time CV med-APE ~0.59 vs the live power-law ~0.69 (~14% lower median error), covers cells power-law drops.
-- Read by serial_fmv_estimate (8-arg) when p_edition_id is given, gated on set support >= gate_min_support.
-- Tables are service_role-only (RLS on + anon/authenticated revoked). Kill-switch: is_active=false.
-- REVERT: DROP the 3 tables; the estimate function's pooled branch then no-ops (power-law/grid path).

CREATE TABLE IF NOT EXISTS public.serial_fmv_pooled_model (
  collection_id uuid PRIMARY KEY, algo_version text NOT NULL, lookback_days integer NOT NULL,
  n_train integer NOT NULL, intercept numeric NOT NULL, b_log_fmv numeric NOT NULL, b_log_circ numeric NOT NULL,
  tier_rare numeric NOT NULL DEFAULT 0, tier_legendary numeric NOT NULL DEFAULT 0, tier_fandom numeric NOT NULL DEFAULT 0,
  bucket_perfect numeric NOT NULL DEFAULT 0, px_rare numeric NOT NULL DEFAULT 0, px_legendary numeric NOT NULL DEFAULT 0,
  px_fandom numeric NOT NULL DEFAULT 0, fmv_min numeric NOT NULL, fmv_max numeric NOT NULL,
  prem_lo numeric NOT NULL, prem_hi numeric NOT NULL, gate_min_support integer NOT NULL DEFAULT 6,
  is_active boolean NOT NULL DEFAULT true, computed_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.serial_fmv_pooled_model ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.serial_fmv_pooled_model TO service_role;
REVOKE ALL ON public.serial_fmv_pooled_model FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.serial_fmv_pooled_player_effect (
  collection_id uuid NOT NULL, player_id uuid NOT NULL, effect numeric NOT NULL, support_n integer NOT NULL,
  PRIMARY KEY (collection_id, player_id));
ALTER TABLE public.serial_fmv_pooled_player_effect ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.serial_fmv_pooled_player_effect TO service_role;
REVOKE ALL ON public.serial_fmv_pooled_player_effect FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.serial_fmv_pooled_set_effect (
  collection_id uuid NOT NULL, set_id uuid NOT NULL, effect numeric NOT NULL, support_n integer NOT NULL,
  PRIMARY KEY (collection_id, set_id));
ALTER TABLE public.serial_fmv_pooled_set_effect ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.serial_fmv_pooled_set_effect TO service_role;
REVOKE ALL ON public.serial_fmv_pooled_set_effect FROM anon, authenticated;

DELETE FROM public.serial_fmv_pooled_model      WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd';
DELETE FROM public.serial_fmv_pooled_set_effect WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd';
INSERT INTO public.serial_fmv_pooled_model
  (collection_id, algo_version, lookback_days, n_train, intercept, b_log_fmv, b_log_circ,
   tier_rare, tier_legendary, tier_fandom, bucket_perfect, px_rare, px_legendary, px_fandom,
   fmv_min, fmv_max, prem_lo, prem_hi, gate_min_support, is_active)
VALUES ('95f28a17-224a-4025-96ad-adf8a4c63bfd','pooled-1.0.0-set',730,1501,
  2.069725,-0.271882,0.218653,
  -0.569784,-0.638441,0.20757,
  -0.827016,0.036922,0.382586,-0.621663,
  0.5,1836.46,0.9353,331.65,6,true);

INSERT INTO public.serial_fmv_pooled_set_effect (collection_id,set_id,effect,support_n) VALUES
('95f28a17-224a-4025-96ad-adf8a4c63bfd','01821da5-fd5e-4521-b7bf-82f85069afea',0.02723,17),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','0273706b-d6fc-4cc9-82aa-bd80b6461122',0.17082,24),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','03083373-7aa0-4bf6-95fa-038bb8945194',-0.49654,11),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','0e81498b-e1c2-462e-a814-4b6972fe7516',-0.51815,12),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','0ed6f641-5961-4db9-b276-2bc69757f0fa',0.03319,7),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','1cbd4cc5-eaab-41b0-a7b3-6a51d2cdddd0',0.03063,6),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','1df99011-1640-42cf-8f8b-b66d76dba734',0.03338,18),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','2213295c-bc36-4dc2-b315-464ef2e2334f',-0.20093,16),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','25174454-a2a2-4698-ac6b-8e77b00a3b80',0.14793,7),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','26aeb06a-90fa-40e3-81ae-4f00fac7d634',-0.29733,8),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','2cab546f-4525-4dc2-b174-dcaf15dece3f',0.20296,10),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','2cd5782d-2f53-45e2-86cf-345720275867',-0.31065,26),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','2d51b5be-18f1-4ccb-a6e6-eed9a3cae125',-0.68421,32),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','32be82bb-b8ff-43f1-828e-ecfa34470122',0.26619,7),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','39d9aae6-b47e-4258-a3d3-a21143f8acc8',0.0145,15),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','4313bedb-e8f4-4d7b-8bb2-2db5be317dd2',-0.30251,7),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','494c977c-b3ee-4cc1-beba-c34f5923dc83',0.28268,44),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','4c7ec967-3009-4d63-95c3-95fdd571137a',-0.21433,6),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','5162547a-8ddb-4899-be82-a5c912372cc8',0.21879,21),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','5678e116-7dd5-4fc0-997b-b8e3f6a09b71',-0.06746,26),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','583288ef-62ea-4b92-a25c-bc00bf97a578',0.03104,11),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','59ae7f9c-6c94-4b7b-9f8a-81df9af73c22',-0.3087,12),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','5b218b5e-4897-4a06-a60f-a40ef2c40ff9',-0.29105,23),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','5bd6e097-d66d-4769-aaf7-87f682f6bad5',-0.09628,8),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','5e378dd9-abeb-4e04-b746-ec2299fc2012',-0.10911,47),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','677ea22c-1264-4b91-a94b-ca6130f2eb71',0.29056,12),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','68edb656-4fea-4e69-b7b3-9a2cbd97ab19',-0.08497,6),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','698f8bda-5466-4544-8581-ae19b15df988',0.15183,25),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','7b083017-d165-486b-95b5-d94dd08f6201',-0.13018,6),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','7dfba4e8-d666-47f6-aaa6-fdfec624eb3c',0.07704,19),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','830bb020-8c40-4104-bd70-86ca1c608653',-0.31242,7),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','832c4585-bea0-49bb-9358-c61fe0d0a25b',-0.32399,36),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','8b64f92e-051c-4798-bc9d-baad84d1f28c',0.3126,11),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','8c81b047-9034-4fba-836e-236fbc5edf27',-0.03879,19),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','95f44151-b82f-41db-b1ea-0b74a8f8e214',0.09212,6),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','96568319-d12e-45fb-ab1a-0f584d162e59',-0.35961,19),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','9c76d2d0-8c4b-4cd7-88af-4fbe295a20ec',0.46291,10),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','9e25bcb1-f032-4a0f-8c07-e3e07578545f',-0.09655,10),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','9e5dc1df-d6ba-44a4-9689-82c4b1e90c7f',0.30492,14),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','a3b39c54-4bf1-4a9a-9ea1-ff9ab2df26e1',-0.04667,18),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','a5623546-c3ab-49da-9fed-fa777e3bd105',-0.11265,13),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','a66f0e49-431a-40db-9435-187d4cc6928f',-0.25074,9),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','aa92c9ad-a467-4f04-a55d-c59ce91a79b1',0.21609,35),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','ab724da2-8257-4504-b211-83cde99af080',-0.16973,7),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','b6a73354-f8b1-4460-bf00-23b27cca5c73',-0.6254,118),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','b7abaf6f-2218-4b62-8bea-cc871fbc08d1',-0.02521,6),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','b87e1270-49f4-4a03-a09b-312d23b1652c',-0.21998,25),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','bb400d0a-b5b3-4a0c-a4f5-687c6db71584',-0.07972,7),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','bba4b88a-a82b-4f8c-85c9-227ade5f1a4d',0.06382,21),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','bc6215d9-5b9f-40c0-b221-755d8d84ddb4',-0.13543,30),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','c1a7ac67-0014-4a32-945b-4a8e273f1366',-0.67684,42),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','c2f36dac-2255-4606-a4b4-43329bfb09b4',0.01054,17),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','c6f57e18-f1b9-4591-8101-5d56f484def2',-0.02945,11),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','c8be2a12-c730-47ff-b703-e8ca3630dc67',-0.16707,7),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','c9a95548-851f-4c04-817d-0716505cd056',0.15639,9),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','d46bbde8-3536-426b-9cfc-0ebc68f539be',0.23164,21),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','d73ea946-dac3-481a-af0f-1723c5cb6b13',0.20025,16),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','dadab8ba-e125-4f6a-ad78-5f6663aa2003',0.23162,6),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','e16a7e4b-04a1-44b6-81ad-188d94abef8a',0.41758,9),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','e223c790-a534-4fd6-8ae9-4f284888f86f',0.4265,20),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','e5e6212d-aee7-435f-8c09-ecac9e137bda',0.05453,17),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','e9348132-3b39-4202-b67a-d3b7a998de58',-0.08745,7),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','edf853b2-408c-4b17-bf9d-667e77922fff',-0.22295,9),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','f08c2167-2808-484f-bb75-db436d146d4e',0.29864,8),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','f2d7a109-c7fe-4cb3-a342-9dce6bbb582d',0.16251,20),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','f6889874-b3e0-4e08-9e82-b351c73f6296',0.17352,10),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','f7b2b850-9e18-406d-a75b-a63b40595657',0.33897,40),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','f8bae9de-be4a-4198-a060-ecbb5ff8e2e9',-0.08083,15),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','f8fe1a69-97f5-4f92-912d-eea2cae372d6',-0.14432,8),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','fd9b3012-2630-43da-a370-4d6ac681c4c3',0.10611,55),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','fe0ec0d0-91bb-472d-b721-9066e7693305',0.28591,7);
