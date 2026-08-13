-- audit_20260812: make refresh_wmc_fmv_drift_active COMPLETE. It has been dying on
-- every 5-minute tick for 10+ hours with 57014, invisibly.
--
-- ROOT CAUSE (measured, not inferred):
--   * service_role carries statement_timeout=30s (pg_roles.rolconfig). The route calls
--     this via supabase-js -> PostgREST -> service_role, so 30s is the real budget.
--   * The function declared `SET statement_timeout TO '120s'`. That is INERT: proconfig
--     can neither raise nor lower the calling statement's budget, because the timer is
--     armed before the function's GUC nest level. It believed it had 120s; it had 30.
--   * The whole job was ONE unchunked UPDATE. Run by hand with a 55s budget it STILL
--     timed out, so this is not a "widen the timeout" problem -- 55s is not enough
--     either. It has to be chunked.
--   * Why it is expensive despite a ~50k plan cost: the 26-wallet filter lands as a
--     Hash Semi Join AFTER a nested loop over ~110k wmc rows, and wmc carries 15
--     indexes -- `idx_wmc_cohort_cover` INCLUDEs fmv_usd and `idx_wmc_fmv_null` is
--     partial ON fmv_usd, so every fmv_usd write is non-HOT and maintains them all.
--
-- WHAT CHANGES
--   1. Chunked loop, 100 editions per UPDATE. Each iteration is its own statement and
--      so gets its own 30s window -- the same shape refresh_wmc_fmv_changed already
--      uses. A killed run now banks the work it already did.
--   2. Internal deadline 20s, deliberately INSIDE the 30s service_role budget. The
--      sibling's 60s deadline is twice its real budget and can therefore never fire;
--      that is fixed separately.
--   3. p_limit is now HONOURED. It was accepted and never referenced in the body -- a
--      budget knob that did nothing.
--   4. THE RATCHET IS GONE. last_cutoff previously advanced only on full success, so
--      every failure widened the next attempt's changed-set (it had grown to 8,026
--      editions). It now advances to just below the oldest UNPROCESSED edition, so
--      partial progress is banked and the set cannot run away again.
--   5. The misleading `SET statement_timeout TO '120s'` is REMOVED rather than kept.
--      An inert setting that reads as a guarantee is worse than no setting.
--
-- NOT CHANGED HERE, DELIBERATELY: the allow_list wallet scope (26 wallets of ~241).
-- Widening it is a separate migration so that "does it complete?" can be verified
-- independently of "does it cover everyone?".
--
-- Signature is unchanged, so no new overload is created and existing grants stand.
--
-- REVERT: re-apply the previous body, which is recorded verbatim in
-- claude/finding-wmc-fmv-propagation-dead-2026-08-12.md (one unchunked UPDATE,
-- SET statement_timeout TO '120s', p_limit unused).

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
  v_chunk      constant integer  := 100;  -- editions per UPDATE statement
  v_budget     constant interval := interval '20 seconds';  -- inside service_role's 30s
  v_deadline   timestamptz := clock_timestamp() + v_budget;
BEGIN
  SELECT last_cutoff INTO v_cutoff FROM public.rwfd_state WHERE id = 1;
  IF v_cutoff IS NULL THEN
    v_cutoff := v_run_start - interval '2 hours';
  END IF;

  -- Cheap: idx_fmv_snapshots_2026_computed_at_desc serves this (plan cost ~2.5k).
  -- computed_at is carried so the cutoff can be advanced to a SAFE point on early exit.
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
    -- Pop the OLDEST chunk. Ascending order is what makes the watermark safe: every
    -- row still in _rwfd_changed is newer than everything already processed.
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

  -- Bank progress. If anything is left unprocessed, park the cutoff just below the
  -- oldest survivor so the next run resumes exactly there and nothing is skipped.
  SELECT MIN(computed_at) - interval '1 microsecond' INTO v_new_cutoff FROM _rwfd_changed;
  v_new_cutoff := COALESCE(v_new_cutoff, v_run_start);

  INSERT INTO public.rwfd_state (id, last_cutoff) VALUES (1, v_new_cutoff)
  ON CONFLICT (id) DO UPDATE SET last_cutoff = EXCLUDED.last_cutoff;

  RETURN v_total;
END;
$function$;