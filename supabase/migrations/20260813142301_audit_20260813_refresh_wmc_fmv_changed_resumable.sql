-- audit_20260813: give refresh_wmc_fmv_changed the same treatment its sibling got --
-- a deadline INSIDE the real budget, a chunk that fits, and a resumable watermark.
--
-- STATE ON ARRIVAL (measured, not assumed): still dead. Called by hand at 14:2xZ with a
-- 50s budget -- ~1.7x its real one -- it STILL timed out inside the same chunk UPDATE.
-- So while refresh_wmc_fmv_drift_active has been repairing since yesterday
-- (rwfd_state.last_cutoff went 10h27m stale -> 4h51m and closing at ~1.4x realtime),
-- that sweep only covers the 26 allow_list wallets. GLOBAL propagation has been dead
-- this whole time.
--
-- THREE DEFECTS, and the third is the one that would have kept biting:
--   1. Internal deadline was `interval '60 seconds'` against service_role's REAL
--      statement_timeout of 30s. The deadline is therefore unreachable -- the statement
--      is always killed first, so the clean-exit path was dead code.
--   2. v_chunk 150 editions does not fit a 30s budget on an I/O-starved instance.
--      Dropped to 15: this sweep updates wmc GLOBALLY (all ~241 wallets), not the 26
--      the drift sweep touches, so its per-edition row count is far higher.
--   3. ⛔ NO WATERMARK. The changed-set was `computed_at >= now() - p_since_minutes`, a
--      ROLLING window. Any edition not reached before the kill -- or before a clean
--      early exit -- was DROPPED PERMANENTLY, because the next call computes a fresh
--      window from a new now(). Fixing 1 and 2 alone would have made it exit cleanly
--      and silently lose the tail of every window. It now resumes from
--      rwfc_state.last_cutoff and banks progress to just below the oldest unprocessed
--      edition, exactly like rwfd_state.
--
-- p_since_minutes is kept as the SEED/fallback only (first run, or state row missing),
-- so the signature and every caller are unchanged -- no new overload, grants stand.
--
-- REVERT:
--   re-apply the previous body (60s deadline, v_chunk 150, no state table, changed-set
--   built from `computed_at >= now() - make_interval(mins => p_since_minutes)`), then
--   optionally DROP TABLE public.rwfc_state;

CREATE TABLE IF NOT EXISTS public.rwfc_state (
  id          smallint PRIMARY KEY,
  last_cutoff timestamptz
);

-- ops state, same posture as rwfd_state: RLS on, no anon/authenticated reach
ALTER TABLE public.rwfc_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.rwfc_state FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.rwfc_state TO postgres, service_role;

CREATE OR REPLACE FUNCTION public.refresh_wmc_fmv_changed(
  p_since_minutes integer DEFAULT 30,
  p_limit integer DEFAULT 50000
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_total      integer := 0;
  v_batch      integer;
  v_cutoff     timestamptz;
  v_new_cutoff timestamptz;
  v_run_start  timestamptz := clock_timestamp();
  v_chunk      constant integer  := 15;
  v_budget     constant interval := interval '15 seconds';  -- inside service_role's 30s
  v_deadline   timestamptz := clock_timestamp() + v_budget;
BEGIN
  SELECT last_cutoff INTO v_cutoff FROM public.rwfc_state WHERE id = 1;
  IF v_cutoff IS NULL THEN
    v_cutoff := v_run_start - make_interval(mins => GREATEST(p_since_minutes, 1));
  END IF;

  -- Served by idx_fmv_snapshots_2026_computed_at_desc. computed_at is carried so the
  -- watermark can be parked safely when the budget runs out mid-set.
  DROP TABLE IF EXISTS _rwfc_recent;
  CREATE TEMP TABLE _rwfc_recent ON COMMIT DROP AS
  SELECT DISTINCT ON (fs.edition_id) fs.edition_id, fs.computed_at
  FROM public.fmv_snapshots fs
  WHERE fs.computed_at > v_cutoff
    AND fs.fmv_usd IS NOT NULL
  ORDER BY fs.edition_id, fs.computed_at DESC;
  CREATE INDEX ON _rwfc_recent (computed_at);
  ANALYZE _rwfc_recent;

  LOOP
    -- Oldest-first: that ordering is what makes the watermark below provably safe.
    WITH popped AS (
      DELETE FROM _rwfc_recent
       WHERE edition_id IN (
         SELECT edition_id FROM _rwfc_recent ORDER BY computed_at LIMIT v_chunk
       )
      RETURNING edition_id
    ),
    latest_fmv AS MATERIALIZED (
      SELECT e.collection_id, e.external_id,
        (SELECT f.fmv_usd
           FROM public.fmv_snapshots f
          WHERE f.edition_id = e.id
            AND f.fmv_usd IS NOT NULL
          ORDER BY f.computed_at DESC
          LIMIT 1) AS fmv_usd
      FROM popped p
      JOIN public.editions e ON e.id = p.edition_id
    ),
    updated AS (
      UPDATE public.wallet_moments_cache wmc
         SET fmv_usd = lf.fmv_usd
        FROM latest_fmv lf
       WHERE wmc.collection_id = lf.collection_id
         AND wmc.edition_key   = lf.external_id
         AND wmc.edition_key IS NOT NULL
         AND lf.fmv_usd IS NOT NULL
         AND wmc.fmv_usd IS DISTINCT FROM lf.fmv_usd
      RETURNING 1
    )
    SELECT COUNT(*)::int INTO v_batch FROM updated;

    v_total := v_total + COALESCE(v_batch, 0);

    EXIT WHEN NOT EXISTS (SELECT 1 FROM _rwfc_recent);
    EXIT WHEN clock_timestamp() > v_deadline;
    EXIT WHEN v_total >= p_limit;
  END LOOP;

  SELECT MIN(computed_at) - interval '1 microsecond' INTO v_new_cutoff FROM _rwfc_recent;
  v_new_cutoff := COALESCE(v_new_cutoff, v_run_start);

  INSERT INTO public.rwfc_state (id, last_cutoff) VALUES (1, v_new_cutoff)
  ON CONFLICT (id) DO UPDATE SET last_cutoff = EXCLUDED.last_cutoff;

  RETURN v_total;
END;
$function$;