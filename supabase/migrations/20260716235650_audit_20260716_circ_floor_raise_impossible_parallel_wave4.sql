-- Wave-4 circ floor-raise for topshot_impossible_parallel_serials (trust breach 7/3).
-- Same self-healing WNBA ::-parallel cataloging class as waves 1-3 (2026-07-06/10/13):
-- these :: parallel editions were seeded with a placeholder floor circulation_count
-- (1/10/47/56) below real observed sale serials (7/12/18/56/69/91). The serials are
-- parallel-scale (not base-scale thousands), so these are genuine small-parallel sales
-- whose edition circ was under-seeded, NOT base-sale mis-keys. Raise circ to the max
-- observed serial on each edition (a conservative floor that clears the impossible-serial
-- flag without over-claiming). Fully reversible from the audit snapshot.
--
-- Revert:
--   UPDATE public.editions e SET circulation_count = a.old_circ
--   FROM public.audit_20260716_impossible_parallel_wave4 a WHERE e.id = a.edition_id;
CREATE TABLE IF NOT EXISTS public.audit_20260716_impossible_parallel_wave4 AS
SELECT e.id AS edition_id,
       e.external_id,
       e.circulation_count AS old_circ,
       (SELECT max(s.serial_number) FROM public.sales s WHERE s.edition_id = e.id) AS new_circ,
       now() AS applied_at
FROM public.editions e
WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
  AND e.external_id ~ '::'
  AND e.circulation_count > 0
  AND EXISTS (
    SELECT 1 FROM public.sales s
    WHERE s.edition_id = e.id AND s.serial_number > e.circulation_count
  );

UPDATE public.editions e
SET circulation_count = a.new_circ,
    updated_at = now()
FROM public.audit_20260716_impossible_parallel_wave4 a
WHERE e.id = a.edition_id
  AND a.new_circ IS NOT NULL
  AND a.new_circ > e.circulation_count;
