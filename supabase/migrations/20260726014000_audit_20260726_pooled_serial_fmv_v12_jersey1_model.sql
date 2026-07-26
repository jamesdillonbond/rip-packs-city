-- audit_20260726_pooled_serial_fmv_v12_jersey1_model
-- v1.2.0 of the pooled special-serial FMV model: adds the DOUBLE-SPECIAL premium —
-- a serial #1 whose player's jersey number is ALSO 1. Trend was strong and descriptively robust
-- (COMMON-controlled median premium 51.8x for #1&jersey1 vs 35.1x otherwise, whole distribution shifted),
-- fitted coefficient x1.379, and CV med-APE on the affected editions improved 0.497 -> 0.452. It is
-- aggregate-neutral (~54 of 1042 #1s) but sharpens exactly the moments collectors prize most.
-- Also: BADGE factor (rookie / Top Shot Debut / championship) was re-confirmed to add nothing beyond set.
-- Adds the jersey1 coefficient column; re-seeds the model row + 71 set effects (recency-weighted, 180d).
-- The read path (next migration) fetches jersey_number and applies jersey1 when bucket=first & jersey=1.
-- REVERT: restore the model row + set effects from 20260726013000 (v1.1.0) and
--   ALTER TABLE public.serial_fmv_pooled_model DROP COLUMN jersey1; (then restore the prior read path).

ALTER TABLE public.serial_fmv_pooled_model ADD COLUMN IF NOT EXISTS jersey1 numeric NOT NULL DEFAULT 0;

UPDATE public.serial_fmv_pooled_model SET
  algo_version='pooled-1.2.0-set-recency-j1', intercept=1.911049, b_log_fmv=-0.290839, b_log_circ=0.219714,
  tier_rare=-0.582558, tier_legendary=-0.529729, tier_fandom=0.492549,
  bucket_perfect=-0.86902, px_rare=0.228678, px_legendary=0.405698, px_fandom=-0.818998,
  jersey1=0.321406, computed_at=now()
WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd';

DELETE FROM public.serial_fmv_pooled_set_effect WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd';
INSERT INTO public.serial_fmv_pooled_set_effect (collection_id,set_id,effect,support_n) VALUES
('95f28a17-224a-4025-96ad-adf8a4c63bfd','01821da5-fd5e-4521-b7bf-82f85069afea',0.04201,17),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','0273706b-d6fc-4cc9-82aa-bd80b6461122',0.22974,24),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','03083373-7aa0-4bf6-95fa-038bb8945194',-0.37527,11),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','0e81498b-e1c2-462e-a814-4b6972fe7516',-0.29657,12),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','0ed6f641-5961-4db9-b276-2bc69757f0fa',0.00789,7),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','1cbd4cc5-eaab-41b0-a7b3-6a51d2cdddd0',0.01879,6),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','1df99011-1640-42cf-8f8b-b66d76dba734',0.1096,18),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','2213295c-bc36-4dc2-b315-464ef2e2334f',-0.10577,16),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','25174454-a2a2-4698-ac6b-8e77b00a3b80',0.01796,7),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','26aeb06a-90fa-40e3-81ae-4f00fac7d634',-0.21229,8),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','2cab546f-4525-4dc2-b174-dcaf15dece3f',0.09911,10),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','2cd5782d-2f53-45e2-86cf-345720275867',-0.16739,26),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','2d51b5be-18f1-4ccb-a6e6-eed9a3cae125',-0.31604,32),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','32be82bb-b8ff-43f1-828e-ecfa34470122',0.15391,7),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','39d9aae6-b47e-4258-a3d3-a21143f8acc8',0.05671,15),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','4313bedb-e8f4-4d7b-8bb2-2db5be317dd2',-0.13952,7),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','494c977c-b3ee-4cc1-beba-c34f5923dc83',0.06915,44),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','4c7ec967-3009-4d63-95c3-95fdd571137a',-0.04799,6),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','5162547a-8ddb-4899-be82-a5c912372cc8',0.09187,21),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','5678e116-7dd5-4fc0-997b-b8e3f6a09b71',0.02488,26),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','583288ef-62ea-4b92-a25c-bc00bf97a578',-0.02314,11),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','59ae7f9c-6c94-4b7b-9f8a-81df9af73c22',-0.15394,12),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','5b218b5e-4897-4a06-a60f-a40ef2c40ff9',-0.13712,23),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','5bd6e097-d66d-4769-aaf7-87f682f6bad5',-0.08008,8),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','5e378dd9-abeb-4e04-b746-ec2299fc2012',0.02716,47),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','677ea22c-1264-4b91-a94b-ca6130f2eb71',0.03786,12),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','68edb656-4fea-4e69-b7b3-9a2cbd97ab19',-0.00654,6),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','698f8bda-5466-4544-8581-ae19b15df988',-0.00323,25),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','7b083017-d165-486b-95b5-d94dd08f6201',-0.04891,6),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','7dfba4e8-d666-47f6-aaa6-fdfec624eb3c',0.1634,19),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','830bb020-8c40-4104-bd70-86ca1c608653',-0.16557,7),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','832c4585-bea0-49bb-9358-c61fe0d0a25b',-0.17581,36),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','8b64f92e-051c-4798-bc9d-baad84d1f28c',0.18633,11),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','8c81b047-9034-4fba-836e-236fbc5edf27',-0.00904,19),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','95f44151-b82f-41db-b1ea-0b74a8f8e214',0.05632,6),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','96568319-d12e-45fb-ab1a-0f584d162e59',-0.12,19),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','9c76d2d0-8c4b-4cd7-88af-4fbe295a20ec',0.18113,10),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','9e25bcb1-f032-4a0f-8c07-e3e07578545f',-0.01654,10),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','9e5dc1df-d6ba-44a4-9689-82c4b1e90c7f',0.25366,14),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','a3b39c54-4bf1-4a9a-9ea1-ff9ab2df26e1',0.02583,18),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','a5623546-c3ab-49da-9fed-fa777e3bd105',-0.01839,13),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','a66f0e49-431a-40db-9435-187d4cc6928f',-0.06913,9),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','aa92c9ad-a467-4f04-a55d-c59ce91a79b1',0.10307,35),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','ab724da2-8257-4504-b211-83cde99af080',-0.0766,7),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','b6a73354-f8b1-4460-bf00-23b27cca5c73',-0.51116,118),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','b7abaf6f-2218-4b62-8bea-cc871fbc08d1',-0.02397,6),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','b87e1270-49f4-4a03-a09b-312d23b1652c',-0.15821,25),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','bb400d0a-b5b3-4a0c-a4f5-687c6db71584',0.00382,7),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','bba4b88a-a82b-4f8c-85c9-227ade5f1a4d',0.04325,21),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','bc6215d9-5b9f-40c0-b221-755d8d84ddb4',-0.07105,30),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','c1a7ac67-0014-4a32-945b-4a8e273f1366',-0.44805,42),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','c2f36dac-2255-4606-a4b4-43329bfb09b4',0.00409,17),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','c6f57e18-f1b9-4591-8101-5d56f484def2',0.00551,11),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','c8be2a12-c730-47ff-b703-e8ca3630dc67',-0.10252,7),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','c9a95548-851f-4c04-817d-0716505cd056',0.19233,9),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','d46bbde8-3536-426b-9cfc-0ebc68f539be',0.07348,21),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','d73ea946-dac3-481a-af0f-1723c5cb6b13',0.11724,16),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','dadab8ba-e125-4f6a-ad78-5f6663aa2003',0.06209,6),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','e16a7e4b-04a1-44b6-81ad-188d94abef8a',0.35048,9),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','e223c790-a534-4fd6-8ae9-4f284888f86f',0.2867,20),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','e5e6212d-aee7-435f-8c09-ecac9e137bda',0.05282,17),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','e9348132-3b39-4202-b67a-d3b7a998de58',-0.02288,7),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','edf853b2-408c-4b17-bf9d-667e77922fff',-0.09195,9),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','f08c2167-2808-484f-bb75-db436d146d4e',0.09333,8),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','f2d7a109-c7fe-4cb3-a342-9dce6bbb582d',-0.00242,20),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','f6889874-b3e0-4e08-9e82-b351c73f6296',0.08933,10),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','f7b2b850-9e18-406d-a75b-a63b40595657',0.2849,40),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','f8bae9de-be4a-4198-a060-ecbb5ff8e2e9',0.04308,15),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','f8fe1a69-97f5-4f92-912d-eea2cae372d6',-0.07075,8),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','fd9b3012-2630-43da-a370-4d6ac681c4c3',0.20453,55),
('95f28a17-224a-4025-96ad-adf8a4c63bfd','fe0ec0d0-91bb-472d-b721-9066e7693305',0.13074,7);
