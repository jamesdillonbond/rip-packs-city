-- 2026-09-25 (PT) — correct a fabricated zero introduced ~2 hours earlier by
-- 20260926030602: 106 backfilled Top Shot dists were written with
-- metadata.number_of_pack_slots = 0, copied from Studio Platform, where 0 means
-- "not set" (no other Top Shot row carries 0). A 0 there reads as "0 moments
-- per pack". The PDS contract does not know either (70 say 0, 30 omit the key,
-- 6 did not answer) — Dapper never set a slot count for these (mostly rewards).
--
-- WHAT. Where every recorded opening of the dist pulled the SAME number of
-- moments and there are at least 3 such openings, that number is the slot
-- count, marked number_of_pack_slots_source = 'observed_rips' (22 dists).
-- VALIDATED on the 1,380 Top Shot dists whose slot count IS known: with >= 3
-- consistent openings the observed count equals the published one on 833 of
-- 836 (99.6 %); with 1–2 openings only 97 %, so those (84 dists) are NOT
-- inferred — the 0 is removed and the count reads as unknown.
--
-- Revert: restore from audit_20260925_ts_zero_slots_backup
-- (UPDATE … SET metadata = b.metadata FROM it WHERE id = b.id).

CREATE TABLE IF NOT EXISTS public.audit_20260925_ts_zero_slots_backup AS
SELECT id, dist_id, metadata
FROM public.pack_distributions
WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
  AND metadata->>'number_of_pack_slots' = '0';
ALTER TABLE public.audit_20260925_ts_zero_slots_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260925_ts_zero_slots_backup FROM PUBLIC, anon, authenticated;

WITH obs AS (
  SELECT z.id, min(r.moments_pulled) AS slots
    FROM public.audit_20260925_ts_zero_slots_backup z
    JOIN public.pack_rips r
      ON r.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND r.dist_id = z.dist_id
     AND r.moments_pulled IS NOT NULL
   GROUP BY z.id
  HAVING count(*) >= 3 AND count(DISTINCT r.moments_pulled) = 1 AND min(r.moments_pulled) > 0
)
UPDATE public.pack_distributions d
   SET metadata = CASE
         WHEN o.id IS NOT NULL THEN (d.metadata - 'number_of_pack_slots')
              || jsonb_build_object('number_of_pack_slots', o.slots, 'number_of_pack_slots_source', 'observed_rips')
         ELSE d.metadata - 'number_of_pack_slots'
       END,
       updated_at = now()
  FROM public.audit_20260925_ts_zero_slots_backup z
  LEFT JOIN obs o ON o.id = z.id
 WHERE d.id = z.id
   AND d.metadata->>'number_of_pack_slots' = '0';

DO $$
DECLARE v_zero int; v_obs int;
BEGIN
  SELECT count(*) INTO v_zero FROM public.pack_distributions
   WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND metadata->>'number_of_pack_slots' = '0';
  IF v_zero <> 0 THEN RAISE EXCEPTION '% Top Shot dists still carry number_of_pack_slots = 0', v_zero; END IF;
  SELECT count(*) INTO v_obs FROM public.pack_distributions
   WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND metadata->>'number_of_pack_slots_source' = 'observed_rips';
  IF v_obs <> 22 THEN RAISE EXCEPTION 'expected 22 observed slot counts, got %', v_obs; END IF;
END $$;
