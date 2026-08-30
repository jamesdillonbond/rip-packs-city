-- audit_20260828_rwfd_temp_build_materialized_cte
--
-- ⭐ THIS IS THE SAME DEFECT `20260822213000_audit_20260822_rwfc_temp_build_materialized_cte`
-- FIXED SEVEN DAYS AGO, IN THE SIBLING FUNCTION TWO DEFINITIONS AWAY.
-- That migration wrote the lesson into `refresh_wmc_fmv_changed`'s body as a comment.
-- `refresh_wmc_fmv_drift_active` carries a byte-identical query and never got the fix,
-- because a comment is only read by someone already in that file. Per CLAUDE.md, the
-- response to finding one of these is to grep for the EXPRESSION, not the file.
--
-- ── THE DEFECT ──────────────────────────────────────────────────────────────
-- `SELECT DISTINCT ON (edition_id) … FROM fmv_snapshots WHERE computed_at > cutoff
--  ORDER BY edition_id, computed_at DESC` lets the planner satisfy the ORDER BY for free
-- from `fmv_snapshots_2026_edition_id_computed_at_idx`. That index LEADS ON edition_id
-- while the predicate is on computed_at, so there is no range to seek: it walks the
-- WHOLE 2026 index every run, 288 runs a day, on an instance whose binding constraint
-- is disk IO.
--
-- ⚠ `idx_fmv_snapshots_2026_computed_at_desc` ALREADY EXISTS and is exactly the right
-- index. Nothing needed to be created. It was simply never reachable while the ORDER BY
-- was in the same query -- and it is a PARTITION-LOCAL index, so a `pg_indexes` query
-- filtered on `tablename = 'fmv_snapshots'` does not list it. I built a scratch BRIN and
-- measured a whole alternative before noticing the index I wanted was already there;
-- the BRIN was dropped and no index ships with this migration.
--
-- ── MEASURED, ANALYZE + BUFFERS on the live instance, WARM vs WARM ──────────
-- Same cutoff, same 12,600 output rows, run back to back:
--   as written (DISTINCT ON inline):        21,291 buffers
--   wrapped in a MATERIALIZED CTE:             956 buffers   (-96%)
-- The wrapped form pays a 1,007 kB quicksort over 13,281 rows and seeks
-- `idx_fmv_snapshots_2026_computed_at_desc` instead of walking the edition_id index.
-- ⚠ Wall clock is NOT the evidence here and must not be quoted: fully warm, the incumbent
-- measured 85 ms and cold it measured 2,392 ms for the SAME 21k buffers. The buffer count
-- is the load-independent number.
--
-- `AS MATERIALIZED` is load-bearing: PG12+ inlines a CTE referenced once, and inlining
-- restores the ordering incentive and the defect with it.
--
-- ── EQUIVALENCE, both directions, in ONE atomic query ───────────────────────
-- Incumbent and candidate computed side by side against the same live cutoff and
-- `EXCEPT ALL`-diffed: `old_n 12600 · new_n 12600 · only_old 0 · only_new 0`.
-- Running them in one statement means concurrent writes to `fmv_snapshots` cannot
-- confound the comparison.
--
-- ⚠ Only the `_rwfd_changed` BUILD changes. The chunk size (25), the 15-second loop
-- budget, the deviation predicate, the resumable cutoff arithmetic and the return value
-- are untouched, so this migration is attributable on its own.
--
-- ── WHY IT MATTERS BEYOND THE BUFFERS ───────────────────────────────────────
-- `rwfd_state.last_cutoff` was **858 minutes (14.3 h) behind** with 12,320 editions
-- queued when this was measured, and 48 of 283 runs in 24 h (17.0%) died on
-- `canceling statement due to statement timeout`. ⚠ `v_deadline` is set BEFORE the build,
-- so every second the build costs is a second the drain does not get -- the further behind
-- it fell, the less budget was left to catch up.
--
-- ⚠ SECURITY DEFINER (prosecdef=true) and `SET search_path = public, pg_temp` are
-- re-declared verbatim: CREATE OR REPLACE FUNCTION drops any proconfig not restated, and
-- this function is SECURITY DEFINER, so losing search_path would be a security change.
-- anon-exec: unchanged (refresh_wmc_fmv_drift_active) -- CREATE OR REPLACE of an existing
-- function does not touch its ACL; verified before and after.
--
-- ⚠ PARAMETER DEFAULTS (`p_deviation_pct DEFAULT 25, p_limit DEFAULT 20000`) are restated
-- verbatim. Omitting them does not silently drop them -- Postgres refuses the statement with
-- `42P13 cannot remove parameter defaults from existing function`, which is how this was
-- caught before it shipped -- but restating them wrong WOULD be silent.
--
-- REVERT: re-create the function with the `_rwfd_changed` build as a single
-- `SELECT DISTINCT ON (fs.edition_id) … FROM public.fmv_snapshots fs WHERE …
-- ORDER BY fs.edition_id, fs.computed_at DESC` (no CTE). Nothing else differs.
--
-- EXIT CONDITION: `refresh_wmc_fmv_drift_active`'s statement-timeout rate falls from
-- 17.0% (48/283 in 24 h) and `rwfd_state.last_cutoff` lag falls from 858 min.
-- FALSIFIER: if the lag does not close, the drain -- not the build -- is the bottleneck,
-- and the next lever is `v_chunk = 25` / the 15 s budget, neither of which this touches.

CREATE OR REPLACE FUNCTION public.refresh_wmc_fmv_drift_active(
  p_deviation_pct numeric DEFAULT 25,
  p_limit integer DEFAULT 20000
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
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
  -- The filter is wrapped in a MATERIALIZED CTE so the planner cannot use
  -- fmv_snapshots_2026_edition_id_computed_at_idx to supply DISTINCT ON's ordering for
  -- free. That index leads on edition_id while the predicate is on computed_at, so there
  -- is no range to seek and the whole 2026 index is walked. Materialising first removes
  -- the ordering incentive; the planner then seeks the index that already exists for
  -- exactly this, idx_fmv_snapshots_2026_computed_at_desc, and pays a tiny quicksort.
  -- Measured 2026-08-28, warm-vs-warm, same 12,600 output rows: 21,291 buffers as
  -- written vs 956 wrapped. Diffed with EXCEPT ALL in BOTH directions, 0 rows each way.
  -- ⚠ AS MATERIALIZED is load-bearing -- PG12+ inlines a CTE referenced once, which
  -- restores the ordering incentive and the defect with it.
  -- ⚠ The identical defect and the identical fix live in refresh_wmc_fmv_changed
  -- (20260822213000). If you are editing one of these, check the other.
  CREATE TEMP TABLE _rwfd_changed ON COMMIT DROP AS
  WITH changed AS MATERIALIZED (
    SELECT fs.edition_id, fs.fmv_usd, fs.computed_at
    FROM public.fmv_snapshots fs
    WHERE fs.computed_at > v_cutoff
      AND fs.fmv_usd IS NOT NULL
  )
  SELECT DISTINCT ON (c.edition_id) c.edition_id, c.fmv_usd, c.computed_at
  FROM changed c
  ORDER BY c.edition_id, c.computed_at DESC;
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
