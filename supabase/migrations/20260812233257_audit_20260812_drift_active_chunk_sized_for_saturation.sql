-- audit_20260812 follow-up: shrink the chunk. A 100-edition chunk still exceeded 50s.
--
-- WHY, and this is the part that matters: the box is I/O-STARVED, not lock-blocked.
-- Sampled pg_stat_activity during the failure: pg_blocking_pids() empty for every
-- backend, while 11+ authenticator backends sat 15-30s in DataFileRead / BufferIo and
-- a cron_heavy backfill_nft_edition_map_from_sales had been in DataFileRead for 122s.
-- Nothing is waiting on a lock; everything is waiting on disk.
--
-- Under that condition, per-row cost is dominated by non-HOT index maintenance --
-- wmc carries 15 indexes, `idx_wmc_cohort_cover` INCLUDEs fmv_usd and `idx_wmc_fmv_null`
-- is partial ON fmv_usd, so every fmv_usd write touches them all and the wmc HOT ratio
-- is ~1.8%. 100 editions x ~35 held rows is thousands of non-HOT updates against cold
-- buffers, which does not fit a 30s service_role budget on a starved instance.
--
-- 25 editions + a 15s deadline is sized to FIT rather than to finish. Combined with the
-- banked cutoff from the previous migration, a tick that only manages one chunk still
-- makes monotonic progress -- which is strictly better than the 10+ hours of zero
-- progress this path has been making.
--
-- ⚠ THIS IS NOT VERIFIED TO SUCCEED. The honest test is the route's own 5-minute tick:
-- watch public.rwfd_state.last_cutoff. Advancing = the path is alive again. Frozen =
-- the chunk is still too big for the current I/O budget, and the next lever is chunking
-- by wmc ROWS rather than by editions.
--
-- Signature unchanged -> no new overload, grants stand.
-- REVERT: re-apply audit_20260812_drift_active_chunked_resumable (chunk 100 / 20s).

CREATE OR REPLACE FUNCTION public.refresh_wmc_fmv_drift_active(
  p_deviation_pct numeric DEFAULT 25,
  p_limit integer DEFAULT 20000
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_total      integer := 0;
  v_batch      integer;
  v_frac       numeric := GREATEST(p_deviation_pct, 0) / 100.0;
  v_cutoff     timestamptz;
  v_new_cutoff timestamptz;
  v_run_start  timestamptz := clock_timestamp();
  v_chunk      constant integer  := 25;
  v_budget     constant interval := interval '15 seconds';
  v_deadline   timestamptz := clock_timestamp() + v_budget;
BEGIN
  SELECT last_cutoff INTO v_cutoff FROM public.rwfd_state WHERE id = 1;
  IF v_cutoff IS NULL THEN
    v_cutoff := v_run_start - interval '2 hours';
  END IF;

  DROP TABLE IF EXISTS _rwfd_changed;
  CREATE TEMP TABLE _rwfd_changed ON COMMIT DROP AS
  SELECT DISTINCT ON (fs.edition_id) fs.edition_id, fs.fmv_usd, fs.computed_at
  FROM public.fmv_snapshots fs
  WHERE fs.computed_at > v_cutoff
    AND fs.fmv_usd IS NOT NULL
  ORDER BY fs.edition_id, fs.computed_at DESC;
  CREATE INDEX ON _rwfd_changed (computed_at);
  ANALYZE _rwfd_changed;

  DROP TABLE IF EXISTS _rwfd_wallets;
  CREATE TEMP TABLE _rwfd_wallets (wallet_address text PRIMARY KEY) ON COMMIT DROP;
  INSERT INTO _rwfd_wallets (wallet_address)
  SELECT DISTINCT wallet_addr
  FROM public.allow_list
  WHERE status = 'active' AND wallet_addr IS NOT NULL
  ON CONFLICT DO NOTHING;
  ANALYZE _rwfd_wallets;

  LOOP
    WITH popped AS (
      DELETE FROM _rwfd_changed
       WHERE edition_id IN (
         SELECT edition_id FROM _rwfd_changed ORDER BY computed_at LIMIT v_chunk
       )
      RETURNING edition_id, fmv_usd
    ),
    upd AS (
      UPDATE public.wallet_moments_cache wmc
         SET fmv_usd = p.fmv_usd
        FROM public.editions e
        JOIN popped p ON p.edition_id = e.id
       WHERE wmc.collection_id  = e.collection_id
         AND wmc.edition_key    = e.external_id
         AND wmc.edition_key IS NOT NULL
         AND wmc.wallet_address IN (SELECT wallet_address FROM _rwfd_wallets)
         AND (
           wmc.fmv_usd IS NULL
           OR abs(wmc.fmv_usd - p.fmv_usd) > p.fmv_usd * v_frac
         )
      RETURNING 1
    )
    SELECT COUNT(*)::int INTO v_batch FROM upd;

    v_total := v_total + COALESCE(v_batch, 0);

    EXIT WHEN NOT EXISTS (SELECT 1 FROM _rwfd_changed);
    EXIT WHEN clock_timestamp() > v_deadline;
    EXIT WHEN v_total >= p_limit;
  END LOOP;

  SELECT MIN(computed_at) - interval '1 microsecond' INTO v_new_cutoff FROM _rwfd_changed;
  v_new_cutoff := COALESCE(v_new_cutoff, v_run_start);

  INSERT INTO public.rwfd_state (id, last_cutoff) VALUES (1, v_new_cutoff)
  ON CONFLICT (id) DO UPDATE SET last_cutoff = EXCLUDED.last_cutoff;

  RETURN v_total;
END;
$function$;