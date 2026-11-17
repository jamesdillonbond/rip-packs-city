-- 2026-09-29 (PT): two Top Shot parallel editions (98:3137::5 LA Clippers, 98:3139::5 Memphis Grizzlies)
-- were named "Unknown — Clamps": a team Moment has no player_name, and /api/ingest (retired 09-07, now
-- fixed not to fabricate) wrote the literal "Unknown". Every sibling of both (the base and ::6, ::7) is
-- named "Clamps", so these take the same name. Guarded on the exact bad value; idempotent.
-- Revert: UPDATE public.editions SET name = 'Unknown — Clamps' WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
--         AND external_id IN ('98:3137::5', '98:3139::5');
UPDATE public.editions
   SET name = 'Clamps'
 WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
   AND external_id IN ('98:3137::5', '98:3139::5')
   AND name = 'Unknown — Clamps';
