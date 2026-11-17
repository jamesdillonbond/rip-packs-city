-- audit_20261101_apply_lock_check_batch_null_keeps_flag
-- anon-exec: unchanged (apply_lock_check_batch) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false, authenticated=false (11-01 7:12 AM PT).
--
-- #222, the last write defect. The lock-check cron (app/api/cron/lock-check-batch) mapped
-- its Cadence result with `is_locked: !!locked[id]`. The script returns NO entry for an id
-- the wallet's collection cannot borrow (the moment left the wallet; the wmc row is a
-- phantom until a prune or full-set write reaps it), so `!!undefined` wrote "checked:
-- unlocked" for a moment the chain says this wallet does not hold. Measured 10-31 4:08 PM
-- PT: one cron batch on 0xbd94cade097e50ac stamped 27315405 `false`; the cron's own script
-- returns no entry for it.
--
-- Simply not writing absent ids would leave them unstamped, and get_lock_check_batch picks
-- `ORDER BY lock_checked_at ASC NULLS FIRST`, so they would hold the head of the queue
-- forever (the #128 ORDER-BY trap). So: a NULL `is_locked` in p_results now means "the
-- chain was asked and returned nothing for this row" — the flag is KEPT (COALESCE) and the
-- row is stamped, so the rotation advances. The cron sends NULL for absent ids and reports
-- them as `absent_from_chain` in its run record (the phantom-row incidence, unmeasured until
-- now). The trade-room heal (app/api/trade-room/[code]) only ever sends booleans for
-- live-held rows, so it is unaffected.
--
-- The body below is the live prosrc (md5 51e0255f85e968d2ebc9ff1db17a31fb, re-read 11-01
-- 7:12 AM PT immediately before this file) with ONE line changed: `is_locked = c.is_locked`
-- → `is_locked = COALESCE(c.is_locked, wmc.is_locked)`. Header (SECURITY DEFINER,
-- search_path, statement_timeout 300s) restated from pg_get_functiondef. First committed
-- definition — the function predates the repo; now pinned (supabase/tests/apply_lock_check_batch.sql).
--
-- Revert: re-apply with `is_locked = c.is_locked` (and revert the cron commit, or it will
-- send NULLs that then write NULL into is_locked).

-- >>> BEGIN verbatim apply_lock_check_batch (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.apply_lock_check_batch(p_results jsonb)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '300s'
AS $function$
DECLARE
  v_updated int := 0;
  v_total int;
BEGIN
  v_total := jsonb_array_length(p_results);

  WITH inputs AS (
    SELECT
      (item->>'wallet_address')::text AS wallet_address,
      (item->>'moment_id')::text AS moment_id,
      (item->>'collection_id')::uuid AS collection_id,
      (item->>'is_locked')::boolean AS is_locked
    FROM jsonb_array_elements(p_results) AS item
  ),
  claimed AS (
    SELECT wmc.wallet_address, wmc.collection_id, wmc.moment_id, i.is_locked
    FROM inputs i
    JOIN wallet_moments_cache wmc
      ON wmc.wallet_address = i.wallet_address
     AND wmc.moment_id = i.moment_id
     AND wmc.collection_id = i.collection_id
    ORDER BY wmc.wallet_address, wmc.collection_id, wmc.moment_id
    FOR UPDATE OF wmc SKIP LOCKED
  ),
  upd AS (
    UPDATE wallet_moments_cache wmc
    SET
      is_locked = COALESCE(c.is_locked, wmc.is_locked),
      lock_checked_at = NOW()
    FROM claimed c
    WHERE wmc.wallet_address = c.wallet_address
      AND wmc.moment_id = c.moment_id
      AND wmc.collection_id = c.collection_id
    RETURNING wmc.moment_id
  )
  SELECT COUNT(*) INTO v_updated FROM upd;

  RETURN json_build_object(
    'submitted', v_total,
    'updated', v_updated,
    'skipped_locked', GREATEST(v_total - v_updated, 0)
  );
END;
$function$;
-- <<< END verbatim apply_lock_check_batch <<<

COMMENT ON FUNCTION public.apply_lock_check_batch(jsonb) IS
  'Lock-check writer (cron + trade-room heal). is_locked NULL in p_results = the chain returned no entry (moment not held): flag kept, row stamped so the stalest-first rotation advances — #222, 2026-11-01. Pinned: supabase/tests/apply_lock_check_batch.sql.';
