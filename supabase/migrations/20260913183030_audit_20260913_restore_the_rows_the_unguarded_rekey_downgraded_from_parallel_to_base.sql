-- audit_20260913_restore_the_rows_the_unguarded_rekey_downgraded_from_parallel_to_base
--
-- The data half of `20260913181737`. That migration stopped `remap_topshot_from_onchain_map()`
-- downgrading a correctly-attributed PARALLEL moment to its base on a MISSING subeditions row;
-- this one puts back the rows it already moved. It MUST land after the guard — before it, the
-- 04:33 PT run would simply re-apply the downgrade the next morning.
--
-- ⚠ FIRST, A CORRECTION TO MY OWN NUMBER, ALREADY PUBLISHED AN HOUR EARLIER. The ledger entry and
-- register #110 for `20260913181737` say "330 sales rows". **That is a JOIN FAN-OUT, not a count.**
-- It came from joining the audit rows to `sales` on `nft_id`, which multiplies by every sale that
-- nft ever had. Joined on the audit's own `sale_id` the true figures are:
--
--   audit rows recording a parallel → its-own-base move .......... 140  (130 distinct nfts)
--   of those, the sale still exists .............................. 140
--   still sitting on the base (i.e. still wrong) ................. 137
--   moved elsewhere since by another process ....................... 3
--   already back on the parallel ................................... 0
--
-- ⭐ The direction and the argument are unchanged; the magnitude was overstated 2.4×. **A count
-- taken through a fan-out join is not a count** — and the tell was available without re-querying:
-- 330 sales rows cannot come from 124 nfts in a table that holds one audit row per SALE.
--
-- ── WHAT IS RESTORED, AND WHAT IS DELIBERATELY LEFT ALONE ────────────────────────────────────
--   sales   eligible ....... 136   (137 still-wrong, minus 1 for which a `subedition_id = 0` row
--                                   has since appeared — that one's downgrade IS now evidenced)
--   moments eligible .........  7   (18 downgrades → 12 still on base → minus those now evidenced
--                                   as a known base, minus any whose target slot is occupied)
--
-- Three exclusions, each deliberate:
--   1. ⛔ **A row whose moment now has `subedition_id = 0` is NOT restored.** That is the positive
--      evidence the guard asks for; the downgrade was right, it was just right by accident.
--   2. ⛔ **A row that has since moved somewhere OTHER than the recorded base is NOT touched** —
--      something else has an opinion about it and this migration has no standing to overrule it.
--   3. ⛔ **A moment whose (edition, serial) target slot is occupied by a DIFFERENT moment is NOT
--      restored** — the same free-slot discipline `remap_topshot_from_onchain_map()` applies to
--      its own moments half. Forcing it would corrupt moment identity to fix an attribution.
--
-- ⚠ **THE AUDIT TABLE IS THE DRIVER, NOT A BY-PRODUCT.** The eligible set is computed ONCE into
-- `audit_20260913_parallel_downgrade_restore`, and the UPDATEs then read that table. They cannot
-- select a different set from the one recorded — the failure mode the guard migration's own header
-- warns about ("the revert path is built from the audit").
--
-- ⚠ The `sales` UPDATE joins on BOTH `id` AND `nft_id`: `sales` is RANGE-partitioned on `sold_at`,
-- so `id` alone gives the planner nothing to prune on, while `nft_id` has a per-partition index.
--
-- ⓘ `sale_id` and `moment_pk` are **uuid**, not bigint — the DB-invariant pin's fixtures use
-- bigint for both, which is fine inside its own self-contained harness but is NOT the prod type.
-- A first draft of this migration took the fixture at its word and failed on `42804`.
--
-- ── REVERT (exact, and it is the inverse of what this writes) ────────────────────────────────
--   UPDATE public.sales s SET edition_id = r.from_edition_id, serial_number = r.from_serial
--     FROM public.audit_20260913_parallel_downgrade_restore r
--    WHERE r.kind = 'sale' AND s.id = r.row_pk AND s.nft_id = r.nft_id
--      AND s.edition_id = r.to_edition_id;
--   UPDATE public.moments m SET edition_id = r.from_edition_id, serial_number = r.from_serial
--     FROM public.audit_20260913_parallel_downgrade_restore r
--    WHERE r.kind = 'moment' AND m.id = r.row_pk AND m.edition_id = r.to_edition_id;
--
-- anon-exec: intentional — this migration defines no function, so there is no ACL to reset. The
-- new audit table is created with no grants, which leaves it service-role only by default.

CREATE TABLE IF NOT EXISTS public.audit_20260913_parallel_downgrade_restore (
  kind            text        NOT NULL,
  row_pk          uuid        NOT NULL,
  nft_id          text        NOT NULL,
  from_edition_id uuid        NOT NULL,
  from_serial     integer,
  to_edition_id   uuid        NOT NULL,
  to_serial       integer,
  restored_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.audit_20260913_parallel_downgrade_restore IS
  'Revert path for the 2026-09-13 parallel-to-base restore. One row per sale/moment put back onto '
  'the PARALLEL edition that the unguarded remap_topshot_from_onchain_map() had moved to the base. '
  'from_* is the state this migration found; to_* is the state it wrote.';

-- ── SALES ────────────────────────────────────────────────────────────────────────────────────
INSERT INTO public.audit_20260913_parallel_downgrade_restore
  (kind, row_pk, nft_id, from_edition_id, from_serial, to_edition_id, to_serial)
SELECT 'sale', a.sale_id, a.nft_id, a.new_edition_id, a.new_serial, a.old_edition_id, a.old_serial
FROM public.audit_topshot_sale_drain_remap_20260621 a
JOIN public.editions eo ON eo.id = a.old_edition_id
JOIN public.editions en ON en.id = a.new_edition_id
JOIN public.sales s ON s.id = a.sale_id AND s.nft_id = a.nft_id
WHERE eo.external_id LIKE '%::%'
  AND en.external_id NOT LIKE '%::%'
  AND split_part(eo.external_id, '::', 1) = en.external_id
  AND s.edition_id = a.new_edition_id
  AND NOT EXISTS (SELECT 1 FROM public.topshot_moment_subeditions sb
                   WHERE sb.nft_id = a.nft_id AND sb.subedition_id = 0);

UPDATE public.sales s
   SET edition_id = r.to_edition_id,
       serial_number = COALESCE(r.to_serial, s.serial_number)
  FROM public.audit_20260913_parallel_downgrade_restore r
 WHERE r.kind = 'sale'
   AND s.id = r.row_pk
   AND s.nft_id = r.nft_id
   AND s.edition_id = r.from_edition_id;

-- ── MOMENTS (free-slot only, same discipline as the function's own moments half) ─────────────
INSERT INTO public.audit_20260913_parallel_downgrade_restore
  (kind, row_pk, nft_id, from_edition_id, from_serial, to_edition_id, to_serial)
SELECT 'moment', a.moment_pk, a.nft_id, a.new_edition_id, a.new_serial, a.old_edition_id, a.old_serial
FROM public.audit_topshot_moment_drain_remap_20260621 a
JOIN public.editions eo ON eo.id = a.old_edition_id
JOIN public.editions en ON en.id = a.new_edition_id
JOIN public.moments m ON m.id = a.moment_pk
WHERE eo.external_id LIKE '%::%'
  AND en.external_id NOT LIKE '%::%'
  AND split_part(eo.external_id, '::', 1) = en.external_id
  AND m.edition_id = a.new_edition_id
  AND NOT EXISTS (SELECT 1 FROM public.topshot_moment_subeditions sb
                   WHERE sb.nft_id = a.nft_id AND sb.subedition_id = 0)
  AND NOT EXISTS (SELECT 1 FROM public.moments o
                   WHERE o.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
                     AND o.edition_id = a.old_edition_id
                     AND o.serial_number = a.old_serial
                     AND o.id <> a.moment_pk);

UPDATE public.moments m
   SET edition_id = r.to_edition_id,
       serial_number = COALESCE(r.to_serial, m.serial_number),
       updated_at = now()
  FROM public.audit_20260913_parallel_downgrade_restore r
 WHERE r.kind = 'moment'
   AND m.id = r.row_pk
   AND m.edition_id = r.from_edition_id;
