-- Issue 2: wmc-fmv-populate ~1-2% persistent fail (rows_imaged>0, rows_updated=0,
-- ok=false) driven by lock contention with the wallet-backfill pipelines that
-- write wmc constantly. The FMV UPDATE's candidate set is tiny (~232 TopShot /
-- ~30 AllDay NULL-fmv rows per tick), so the failures are pure lock waits, not
-- query cost: "canceling statement due to lock timeout", "deadlock detected",
-- and lock-induced "statement timeout".
--
-- Fix: the NULL-only cron path now locks its target rows with FOR UPDATE SKIP
-- LOCKED. Rows currently being written by a backfill are skipped this tick and
-- picked up on the next one (they stay fmv_usd IS NULL) — which is exactly how
-- the NULL-only path already drains its backlog. No FMV math changes: the same
-- latest-snapshot value is written; only *which* rows update on a given tick
-- shifts, and only for rows momentarily locked elsewhere.
--
-- The force path (ad-hoc remediation, never the cron) is unchanged. All function
-- attributes (SECDEF, search_path, statement_timeout=120s) preserved verbatim.
-- Revert: restore the prior definition (targets CTE without FOR UPDATE SKIP LOCKED).
CREATE OR REPLACE FUNCTION public.populate_wmc_fmv_from_snapshots(p_collection_id uuid DEFAULT NULL::uuid, p_force boolean DEFAULT false, p_limit integer DEFAULT 50000)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_updated integer;
BEGIN
  IF p_force THEN
    WITH latest_fmv AS (
      SELECT DISTINCT ON (e.collection_id, e.external_id)
        e.collection_id,
        e.external_id,
        fs.fmv_usd
      FROM public.editions e
      JOIN public.fmv_snapshots fs ON fs.edition_id = e.id
      WHERE fs.fmv_usd IS NOT NULL
        AND (p_collection_id IS NULL OR e.collection_id = p_collection_id)
      ORDER BY e.collection_id, e.external_id, fs.computed_at DESC
    ),
    updated AS (
      UPDATE public.wallet_moments_cache wmc
         SET fmv_usd = lf.fmv_usd
        FROM latest_fmv lf
       WHERE wmc.collection_id = lf.collection_id
         AND wmc.edition_key   = lf.external_id
         AND wmc.edition_key IS NOT NULL
         AND (p_collection_id IS NULL OR wmc.collection_id = p_collection_id)
         AND (wmc.fmv_usd IS DISTINCT FROM lf.fmv_usd)
      RETURNING 1
    )
    SELECT COUNT(*)::int INTO v_updated FROM updated;
  ELSE
    -- NULL-only chunked path. Each call processes up to p_limit rows. Once
    -- a row gets a non-NULL fmv_usd it falls out of the candidate set, so
    -- successive cron ticks naturally drain the backlog.
    --
    -- FOR UPDATE SKIP LOCKED: this path races the wallet-backfill writers on the
    -- same wmc rows. Locking the target rows up front and skipping any that a
    -- backfill currently holds means the UPDATE never blocks — skipped rows stay
    -- NULL and are retried next tick (the same drain semantics as above), so the
    -- tick no longer fails with lock/deadlock/statement timeouts.
    WITH targets AS (
      SELECT wmc.id, wmc.collection_id, wmc.edition_key
      FROM public.wallet_moments_cache wmc
      WHERE wmc.fmv_usd IS NULL
        AND wmc.edition_key IS NOT NULL
        AND (p_collection_id IS NULL OR wmc.collection_id = p_collection_id)
      LIMIT p_limit
      FOR UPDATE SKIP LOCKED
    ),
    snapped AS (
      SELECT t.id AS wmc_id, fs.fmv_usd
      FROM targets t
      JOIN public.editions e
        ON e.collection_id = t.collection_id
       AND e.external_id   = t.edition_key
      CROSS JOIN LATERAL (
        SELECT fmv_usd
        FROM public.fmv_snapshots
        WHERE edition_id = e.id
          AND fmv_usd IS NOT NULL
        ORDER BY computed_at DESC
        LIMIT 1
      ) fs
    ),
    updated AS (
      UPDATE public.wallet_moments_cache wmc
         SET fmv_usd = s.fmv_usd
        FROM snapped s
       WHERE wmc.id = s.wmc_id
       RETURNING 1
    )
    SELECT COUNT(*)::int INTO v_updated FROM updated;
  END IF;

  RETURN COALESCE(v_updated, 0);
END;
$function$;
