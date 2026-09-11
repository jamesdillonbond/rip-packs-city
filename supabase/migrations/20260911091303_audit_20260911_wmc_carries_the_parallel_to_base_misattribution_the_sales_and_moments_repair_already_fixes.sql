-- 2026-09-11 (Cowork deep-audit/QA pass).
--
-- ⭐ THE SAME PREDICATE, A THIRD TABLE. `remap_topshot_parallel_to_base_misattributed()`
-- already repairs this exact misattribution in `sales` (branch 1) and `moments`
-- (branch 2) using a predicate that is reviewed and settled. It does NOT touch
-- `wallet_moments_cache` — and wmc is what the dashboard, the public profile and
-- the trophy case actually read. The class was fixed per-TABLE and one table was
-- missed, which is the "fix per PANEL, not per page" shape.
--
-- 🚨 THE USER-VISIBLE SYMPTOM. A trophy slab rendered `#1017/50`: the serial came
-- from the verified per-moment value and the circulation from a `::18` parallel
-- whose mint is 50. Measured 2026-09-11: 319 wmc rows hold a serial ABOVE the
-- circulation of the parallel they are keyed to.
--
-- ⚠ 17 OF THOSE 319 MUST NOT BE RE-KEYED, and only the repo's own predicate knows
-- why: `topshot_moment_subeditions` positively asserts they ARE that parallel
-- (all 17 are `218:8061::1`, Jalen Duren Base Set, recorded circ 285 vs max held
-- serial 487). Those are an UNDER-RECORDED CIRCULATION, a different defect with a
-- different repair (`raise_impossible_parallel_circ`, which is sales-only and
-- cannot see a serial that never traded). A naive "serial > circ ⇒ mis-keyed"
-- rule would have corrupted all 17. This migration inherits the predicate rather
-- than re-deriving it, precisely so that exclusion is carried over.
--
-- ⚠ POSITIVE CONTROL before shipping: of the 319, 13 appear in `nft_edition_map`
-- (the on-chain map fed by the Atlas firehose). 13/13 say BASE, 0 say parallel,
-- and every serial agrees. Where ground truth exists it matches the inference.
--
-- ⚠ SCOPE IS DELIBERATELY THE IMPOSSIBLE BRANCH ONLY. The sales/moments repair
-- also re-keys rows where the authority says `subedition_id = 0` even when the
-- serial FITS the parallel. That is a larger population and is NOT touched here:
-- every row this migration moves is arithmetically impossible as it stands, so
-- correcting it cannot make any surface less true.

-- anon-exec: revoked — remap_topshot_wmc_parallel_to_base_misattributed is an
-- operator/cron repair, never reachable from a browser; REVOKE is below.

CREATE TABLE IF NOT EXISTS public.audit_20260911_wmc_parallel_to_base_rekey (
  id               bigserial PRIMARY KEY,
  wallet_address   text        NOT NULL,
  moment_id        text        NOT NULL,
  collection_id    uuid        NOT NULL,
  old_edition_key  text        NOT NULL,
  new_edition_key  text        NOT NULL,
  serial_number    int,
  old_mint_count   int,
  new_mint_count   int,
  par_circ         int,
  base_circ        int,
  moved_at         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.audit_20260911_wmc_parallel_to_base_rekey IS
  'Before/after for the 2026-09-11 wmc parallel→base re-key. THE REVERT PATH: update wallet_moments_cache back from these rows.';

CREATE OR REPLACE FUNCTION public.remap_topshot_wmc_parallel_to_base_misattributed()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '180s'
AS $function$
DECLARE
  ts_id CONSTANT uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  n_moved int := 0;
BEGIN
  WITH target AS (
    SELECT w.wallet_address, w.moment_id, w.collection_id,
           w.edition_key AS old_key, w.mint_count AS old_mint, w.serial_number,
           be.external_id      AS new_key,
           pe.circulation_count AS par_circ,
           be.circulation_count AS base_circ
    FROM wallet_moments_cache w
    JOIN editions pe ON pe.external_id = w.edition_key AND pe.collection_id = w.collection_id
    JOIN editions be ON be.external_id = split_part(pe.external_id, '::', 1)
                    AND be.collection_id = w.collection_id
    WHERE w.collection_id = ts_id
      AND pe.external_id LIKE '%::%'
      AND pe.circulation_count > 0
      AND w.serial_number > pe.circulation_count      -- impossible as keyed
      AND be.circulation_count >= w.serial_number     -- and the base can hold it
      -- ⚠ THE EXCLUSION THAT MAKES THIS SAFE: never move a row the subedition
      -- authority positively assigns to THIS parallel.
      AND NOT EXISTS (
        SELECT 1 FROM topshot_moment_subeditions ms
        WHERE ms.nft_id = w.moment_id
          AND ms.subedition_id > 0
          AND pe.external_id = ms.base_external_id || '::' || ms.subedition_id
      )
  ),
  logged AS (
    INSERT INTO public.audit_20260911_wmc_parallel_to_base_rekey
      (wallet_address, moment_id, collection_id, old_edition_key, new_edition_key,
       serial_number, old_mint_count, new_mint_count, par_circ, base_circ)
    SELECT wallet_address, moment_id, collection_id, old_key, new_key,
           serial_number, old_mint, base_circ, par_circ, base_circ
    FROM target
    RETURNING wallet_address, moment_id, new_edition_key, new_mint_count
  ),
  upd AS (
    UPDATE wallet_moments_cache w
       SET edition_key = l.new_edition_key,
           -- ⚠ mint_count MUST move with the key. Measured: 218 of 302 rows
           -- carried the PARALLEL's mint, so wmc held the impossible pair on its
           -- own, not just at trophy-render time. Leaving it would fix the join
           -- and keep the false denominator.
           mint_count  = l.new_mint_count
      FROM logged l
     WHERE w.wallet_address = l.wallet_address
       AND w.moment_id      = l.moment_id
       AND w.collection_id  = ts_id
    RETURNING 1
  )
  SELECT count(*) INTO n_moved FROM upd;

  RETURN jsonb_build_object('rekeyed', n_moved, 'at', now());
END
$function$;

REVOKE EXECUTE ON FUNCTION public.remap_topshot_wmc_parallel_to_base_misattributed() FROM PUBLIC, anon, authenticated;

-- REVERT:
--   UPDATE wallet_moments_cache w SET edition_key = a.old_edition_key, mint_count = a.old_mint_count
--     FROM public.audit_20260911_wmc_parallel_to_base_rekey a
--    WHERE w.wallet_address = a.wallet_address AND w.moment_id = a.moment_id
--      AND w.collection_id = a.collection_id;
--   DROP FUNCTION public.remap_topshot_wmc_parallel_to_base_misattributed();