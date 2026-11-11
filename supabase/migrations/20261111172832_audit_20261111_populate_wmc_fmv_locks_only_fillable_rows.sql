-- audit_20261111_populate_wmc_fmv_locks_only_fillable_rows
--
-- populate_wmc_fmv_from_snapshots, NULL-only path: lock only the rows that will
-- be written. Before this, it locked the first p_limit NULL rows and then found
-- an FMV for none of them on Candy MLB (1,293,541 NULL rows, 0 fillable), holding
-- 5,000 Candy rows for 19-42 s every hour at :13 while writing 0. That lock made
-- candy-editions-ingest lose one wmc chunk at 5:13 PM PT on 11-09 and 11-10
-- (Postgres logs: the waiter was a PostgREST upsert, the holder a PostgREST
-- session matching the wmc-fmv-populate candy-mlb step to the second).
-- The FORCE path is unchanged. Signature, grants and SET options are unchanged.
-- anon-exec: not granted for populate_wmc_fmv_from_snapshots — CREATE OR REPLACE keeps the existing grants,
--   and has_function_privilege('anon', …, 'execute') read false after apply
--
-- Base: live md5(prosrc) = 50a201f35c1f23552fff7108f7cb13ac, the body of
-- 20260812042019_audit_20260812_populate_wmc_fmv_carry_confidence.sql.
--
-- ROLLBACK: re-run the CREATE OR REPLACE FUNCTION from
-- supabase/migrations/20260812042019_audit_20260812_populate_wmc_fmv_carry_confidence.sql
-- (the function only).

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
        fs.fmv_usd,
        fs.confidence
      FROM public.editions e
      JOIN public.fmv_snapshots fs ON fs.edition_id = e.id
      WHERE fs.fmv_usd IS NOT NULL
        AND (p_collection_id IS NULL OR e.collection_id = p_collection_id)
      ORDER BY e.collection_id, e.external_id, fs.computed_at DESC
    ),
    updated AS (
      UPDATE public.wallet_moments_cache wmc
         SET fmv_usd        = lf.fmv_usd,
             fmv_confidence = lf.confidence
        FROM latest_fmv lf
       WHERE wmc.collection_id = lf.collection_id
         AND wmc.edition_key   = lf.external_id
         AND wmc.edition_key IS NOT NULL
         AND (p_collection_id IS NULL OR wmc.collection_id = p_collection_id)
         AND (wmc.fmv_usd IS DISTINCT FROM lf.fmv_usd
              OR wmc.fmv_confidence IS DISTINCT FROM lf.confidence)
      RETURNING 1
    )
    SELECT COUNT(*)::int INTO v_updated FROM updated;
  ELSE
    -- NULL-only chunked path. Each call processes up to p_limit rows. Once
    -- a row gets a non-NULL fmv_usd it falls out of the candidate set, so
    -- successive cron ticks naturally drain the backlog.
    --
    -- LOCK ONLY WHAT WILL BE WRITTEN (2026-11-11). This path used to take the
    -- first p_limit NULL rows FOR UPDATE SKIP LOCKED and only THEN look for an
    -- FMV to copy. Candy MLB holds 1,293,541 NULL rows and NONE has an FMV
    -- snapshot (447 of its 24,811 editions are priced, and their rows are
    -- already filled), so every hourly tick locked 5,000 unfillable Candy rows,
    -- wrote 0, and held them for 19-42 s. candy-editions-ingest upserts those
    -- same rows and lost a chunk to the lock timeout at 5:13 PM PT two days
    -- running. Now the candidates are read WITHOUT a lock, matched to the latest
    -- snapshot first (MATERIALIZED, so the lock step cannot be planned ahead of
    -- the match), and only matched rows are locked, with fmv_usd re-checked
    -- under the lock. Measured on Candy: 57,773 buffers / 54 ms and 0 rows
    -- locked, against 57,669 buffers for the same read before. Driving from
    -- editions-with-FMV instead was 3x the buffers (179k Candy, 145k Top Shot)
    -- and was NOT taken.
    --
    -- SKIP LOCKED is kept: this path races the wallet-backfill writers, and a
    -- matched row a writer holds stays NULL and is retried next tick, so the
    -- UPDATE never blocks.
    WITH targets AS (
      SELECT wmc.id, wmc.collection_id, wmc.edition_key
      FROM public.wallet_moments_cache wmc
      WHERE wmc.fmv_usd IS NULL
        AND wmc.edition_key IS NOT NULL
        AND (p_collection_id IS NULL OR wmc.collection_id = p_collection_id)
      LIMIT p_limit
    ),
    snapped AS MATERIALIZED (
      SELECT t.id AS wmc_id, fs.fmv_usd, fs.confidence
      FROM targets t
      JOIN public.editions e
        ON e.collection_id = t.collection_id
       AND e.external_id   = t.edition_key
      CROSS JOIN LATERAL (
        SELECT fmv_usd, confidence
        FROM public.fmv_snapshots
        WHERE edition_id = e.id
          AND fmv_usd IS NOT NULL
        ORDER BY computed_at DESC
        LIMIT 1
      ) fs
    ),
    locked AS (
      SELECT wmc.id, s.fmv_usd, s.confidence
      FROM snapped s
      JOIN public.wallet_moments_cache wmc ON wmc.id = s.wmc_id
      WHERE wmc.fmv_usd IS NULL
      FOR UPDATE OF wmc SKIP LOCKED
    ),
    updated AS (
      UPDATE public.wallet_moments_cache wmc
         SET fmv_usd        = l.fmv_usd,
             fmv_confidence = l.confidence
        FROM locked l
       WHERE wmc.id = l.id
       RETURNING 1
    )
    SELECT COUNT(*)::int INTO v_updated FROM updated;
  END IF;

  RETURN COALESCE(v_updated, 0);
END;
$function$;
