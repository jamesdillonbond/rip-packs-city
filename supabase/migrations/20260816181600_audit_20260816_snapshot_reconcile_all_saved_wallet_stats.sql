-- audit_20260816_snapshot_reconcile_all_saved_wallet_stats
--
-- SNAPSHOT MIGRATION — a no-op against production. The body below is byte-identical
-- to the live definition (pg_get_functiondef md5 1f9d917eb8d6a39fb9751200a69440a8,
-- prosbody whitespace-collapsed md5 977d41854c98bf4ae1957520777916c4, both read from
-- prod 2026-08-16), so applying it changes nothing.
--
-- WHY IT EXISTS. `reconcile_all_saved_wallet_stats` runs hourly on pg_cron
-- (`rpc-reconcile-saved-wallet-stats`, `44 * * * *`) and writes the cached portfolio
-- figures every collector sees on their saved wallets. It was NOT pinnable, because
-- the only committed migration that defines it —
-- 20260809050000_audit_20260809_reconcile_saved_wallet_cached_stats.sql — is STALE:
-- it declares a zero-argument FUNCTION, while live is a PROCEDURE taking
-- (p_max_seconds, p_max_wallets, p_min_age_minutes) with a soft deadline and a
-- per-wallet COMMIT. The live definition was applied out of band and never committed.
--
-- That is exactly the drift class `npm run db:pins:check` exists to catch, and it was
-- structurally blind to it: the checker only reads functions named in the drift-guard
-- PINS array, so an UNPINNED function can drift indefinitely with every check green.
-- Committing this snapshot makes the function pinnable; the accompanying
-- supabase/tests/reconcile_all_saved_wallet_stats.sql pins its behaviour, and the
-- daily db-pin-staleness workflow will report any future divergence.
--
-- ⚠ DO NOT "TIDY" THE STALE 20260809 FILE. An applied migration is history; editing it
-- cannot change production and would only make the archive lie about what was applied.
--
-- REVERT: none needed — this is a no-op. If it must be undone, re-apply the definition
-- captured here; there is no prior committed definition to restore that matches live.

CREATE OR REPLACE PROCEDURE public.reconcile_all_saved_wallet_stats(IN p_max_seconds integer DEFAULT 50, IN p_max_wallets integer DEFAULT 500, IN p_min_age_minutes integer DEFAULT 360)
 LANGUAGE plpgsql
AS $procedure$
DECLARE
  v_started    timestamptz := clock_timestamp();
  v_deadline   timestamptz := clock_timestamp() + make_interval(secs => GREATEST(p_max_seconds, 1));
  v_pairs      jsonb;
  v_total      integer := 0;
  v_wallets    integer := 0;
  v_refreshed  integer := 0;
  v_zeroed     integer := 0;
  v_truncated  boolean := false;
  v_oldest_h   numeric;
  i            integer;
BEGIN
  UPDATE public.saved_wallets sw
     SET cached_moment_count = 0,
         cached_fmv_usd      = NULL,
         cached_top_tier     = NULL,
         cache_updated_at    = NOW()
   WHERE sw.wallet_addr IS NOT NULL
     AND (sw.cached_moment_count IS DISTINCT FROM 0
          OR sw.cached_fmv_usd IS NOT NULL
          OR sw.cached_top_tier IS NOT NULL)
     AND NOT EXISTS (
       SELECT 1
         FROM public.wallet_moments_cache w
        WHERE w.wallet_address = sw.wallet_addr
          AND w.collection_id  = sw.collection_id
     );
  GET DIAGNOSTICS v_zeroed = ROW_COUNT;
  COMMIT;

  SELECT COALESCE(
           jsonb_agg(jsonb_build_object('u', s.user_id, 'w', s.wallet_addr)
                     ORDER BY s.stalest ASC NULLS FIRST),
           '[]'::jsonb)
    INTO v_pairs
    FROM (
      SELECT sw.user_id, sw.wallet_addr, MIN(sw.cache_updated_at) AS stalest
        FROM public.saved_wallets sw
       WHERE sw.wallet_addr IS NOT NULL
         AND sw.user_id IS NOT NULL
         AND EXISTS (
           SELECT 1
             FROM public.wallet_moments_cache w
            WHERE w.wallet_address = sw.wallet_addr
              AND w.collection_id  = sw.collection_id
         )
       GROUP BY sw.user_id, sw.wallet_addr
      HAVING MIN(sw.cache_updated_at) IS NULL
          OR MIN(sw.cache_updated_at) < now() - make_interval(mins => GREATEST(p_min_age_minutes, 0))
    ) s;

  v_total := jsonb_array_length(v_pairs);

  FOR i IN 0 .. v_total - 1 LOOP
    IF clock_timestamp() >= v_deadline OR v_wallets >= p_max_wallets THEN
      v_truncated := true;
      EXIT;
    END IF;

    v_refreshed := v_refreshed + COALESCE(
      public.aggregate_saved_wallet_stats(
        (v_pairs -> i ->> 'u')::uuid,
        (v_pairs -> i ->> 'w')
      ), 0);
    v_wallets := v_wallets + 1;

    COMMIT;
  END LOOP;

  SELECT ROUND(EXTRACT(epoch FROM (now() - MIN(cache_updated_at))) / 3600.0, 1)
    INTO v_oldest_h
    FROM public.saved_wallets
   WHERE wallet_addr IS NOT NULL;

  PERFORM public.log_pipeline_run(
    'reconcile-saved-wallet-stats',
    NOT v_truncated,
    jsonb_build_object(
      'wallets_done',      v_wallets,
      'wallets_total',     v_total,
      'fetched',           v_total,
      'truncated',         v_truncated,
      'upserted',          v_refreshed,
      'rows_zeroed',       v_zeroed,
      'oldest_cache_h',    v_oldest_h,
      'min_age_minutes',   p_min_age_minutes,
      'elapsed_ms',        ROUND(EXTRACT(epoch FROM (clock_timestamp() - v_started)) * 1000),
      'error',             CASE WHEN v_truncated
                                THEN 'soft_deadline_reached_partial_sweep_committed'
                                ELSE NULL END
    )
  );
  COMMIT;
END;
$procedure$;
