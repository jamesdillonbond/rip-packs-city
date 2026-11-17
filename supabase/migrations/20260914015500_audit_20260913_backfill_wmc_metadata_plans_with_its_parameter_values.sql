-- audit_20260913_backfill_wmc_metadata_plans_with_its_parameter_values
--
-- ── THE DEFECT, MEASURED ─────────────────────────────────────────────────────
-- `backfill_wmc_metadata_from_editions` is the per-wallet post-pass of the
-- wallet-backfill lane (6 call sites; 42,017 calls and 3.37 h/day of execution
-- over the 33 days to 2026-09-13 — register #113). It guards its UPDATE with
-- the shape register #52 documents:
--     AND (p_wallet_address IS NULL OR wmc.wallet_address = p_wallet_address)
--     AND (p_collection_id  IS NULL OR wmc.collection_id  = p_collection_id)
-- plpgsql caches a plan per SESSION and switches to a GENERIC one after five
-- executions; PostgREST pools and reuses connections, so the hot path runs the
-- generic plan nearly always. Under it neither branch can prune.
--
-- Measured 2026-09-13 ~6:4x PM PT on a QUIET instance (0 active backends, 0 in
-- IO wait, no maintenance op), warm, same wallet, READ-ONLY equivalent of this
-- UPDATE's FROM/WHERE projecting the same columns (⛔ never EXPLAIN ANALYZE the
-- UPDATE itself — it executes):
--
--   custom plan (values as literals)     1,175 buffers      23.7 ms
--   generic plan (force_generic_plan)   73,414 buffers   1,030.2 ms
--                                        ── 62x buffers, 43x time ──
--
-- The generic plan does not merely lose the index — it INVERTS THE JOIN. It
-- Parallel Seq Scans all 21,423 rows of `editions`, probes
-- `wallet_moments_cache` once per edition (21,423 loops), and applies the
-- wallet/collection predicate as a FILTER afterwards. The custom plan bitmap-
-- scans `idx_wmc_lock_wallet_coll` on (wallet_address, collection_id) and
-- touches 1,184 rows. Both returned the same 0 rows.
--
-- That is consistent with production: 1,320 disk reads per call on average and
-- three concurrent calls sitting in IO:DataFileRead at 21 s during the 6:27 PM
-- saturation burst that #113 was filed from.
--
-- ── THE CHANGE ───────────────────────────────────────────────────────────────
-- Same signature, same SECURITY DEFINER, same search_path and 120 s
-- statement_timeout, same grants, and the UPDATE is character-for-character the
-- same apart from `p_wallet_address`/`p_collection_id` becoming `$1`/`$2`. The
-- statement now runs through `EXECUTE … INTO … USING`, which plans it with the
-- parameter VALUES on every call.
--
-- ⛔ THE `IS NULL` BRANCHES ARE NOT REMOVED, AND MUST NOT BE. Five of the six
-- callers pass a real wallet and a real collection, but
-- `app/api/ingest/candy-editions/route.ts:331` passes `p_wallet_address: null`
-- with a real collection id — a deliberate collection-wide sweep. The fix is to
-- make the plan see the values, never to drop the guard.
--
-- anon-exec: backfill_wmc_metadata_from_editions -- unchanged (service_role + postgres only; the REVOKE/GRANT below re-assert what was there)

CREATE OR REPLACE FUNCTION public.backfill_wmc_metadata_from_editions(p_wallet_address text DEFAULT NULL::text, p_collection_id uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_updated integer;
BEGIN
  -- ⚠ EXECUTE … USING, not a plain statement: a plain one is planned GENERIC
  -- from the sixth call of a pooled session onward, and the generic plan for
  -- this WHERE clause seq-scans `editions` and probes wmc per edition — 62x the
  -- buffers (measured 2026-09-13; see this migration's header and #113).
  EXECUTE $q$
  WITH updated AS (
    UPDATE public.wallet_moments_cache wmc
       SET tier        = COALESCE(wmc.tier,        e.tier::text),
           player_name = COALESCE(wmc.player_name, e.player_name, e.team_name),
           set_name    = COALESCE(wmc.set_name,    e.set_name),
           mint_count  = COALESCE(wmc.mint_count,  e.circulation_count),
           team_name   = COALESCE(wmc.team_name,   e.team_name)
      FROM public.editions e
     WHERE e.collection_id = wmc.collection_id
       AND e.external_id   = wmc.edition_key
       AND wmc.edition_key IS NOT NULL
       -- Only rows where at least one NULL can actually be filled. Without the
       -- right-hand IS NOT NULL checks a row whose edition is also NULL in that
       -- column was rewritten with identical values on every run (2026-08-30).
       AND (
         (wmc.tier        IS NULL AND e.tier IS NOT NULL) OR
         (wmc.player_name IS NULL AND COALESCE(e.player_name, e.team_name) IS NOT NULL) OR
         (wmc.set_name    IS NULL AND e.set_name IS NOT NULL) OR
         (wmc.mint_count  IS NULL AND e.circulation_count IS NOT NULL) OR
         (wmc.team_name   IS NULL AND e.team_name IS NOT NULL)
       )
       AND ($1 IS NULL OR wmc.wallet_address = $1)
       AND ($2 IS NULL OR wmc.collection_id  = $2)
    RETURNING 1
  )
  SELECT COUNT(*)::int FROM updated
  $q$
  INTO v_updated
  USING p_wallet_address, p_collection_id;

  RETURN COALESCE(v_updated, 0);
END;
$function$;

REVOKE ALL ON FUNCTION public.backfill_wmc_metadata_from_editions(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backfill_wmc_metadata_from_editions(text, uuid) TO service_role, postgres;
