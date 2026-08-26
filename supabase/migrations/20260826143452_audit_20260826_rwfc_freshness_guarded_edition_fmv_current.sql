-- refresh_wmc_fmv_changed: take the latest FMV from the edition_fmv_current cache
-- when that cache is AT LEAST AS FRESH as the snapshot that queued the edition,
-- and only then. Falls back to the incumbent correlated subquery otherwise.
--
-- WHY. Measured 2026-08-26 against a 14.5-day pg_stat_statements window, this
-- function is the single largest writer on the instance: 36.7% of every block the
-- database dirties, 33.9% of WAL, 8.9% of disk reads, and 148 exec-hours across
-- its two callers (~10.2 h/day). The cost is NOT the `v_chunk := 5` loop -- that
-- is conspicuous and commented, and its working set is only ~515 rows. The cost is
-- the correlated latest-FMV subquery below: it carries no partition key, so it
-- Appends across every fmv_snapshots partition (707 MB) to read ~64 rows and return
-- one, ~147,000 times a day.
--
-- ⛔ THE OBVIOUS FORM OF THIS FIX IS WRONG, AND WAS RETRACTED BEFORE IT SHIPPED.
-- A random sample of 274 editions showed zero disagreement between the subquery and
-- edition_fmv_current, which appears to license a bare COALESCE. That is the WRONG
-- POPULATION. On the population this function actually serves -- editions whose FMV
-- changed inside the cursor window -- the cache LAGS: re-measured 2026-08-26 over
-- 4,028 such editions, 28 of them (0.7%) hold a value that differs from the true
-- latest, by as much as -59% / +39%. Those would have been written straight into
-- wallet_moments_cache.fmv_usd, which is a DISPLAYED PRICE that ~34 functions sum
-- for a collector's portfolio total -- and the function's own `IS DISTINCT FROM`
-- churn guard would NOT have caught one, because "stale" and "correct" are both
-- distinct from what is already there.
--
-- ⭐ SO THE GUARD IS ON FRESHNESS, NOT ON NULL. `_rwfc_recent` already carries the
-- computed_at of the snapshot that queued each edition, so `popped` can return it
-- and the join can demand the cache be at least that fresh. Rows failing the guard
-- fall through to the incumbent subquery and are computed exactly as before.
--
-- MEASURED EQUIVALENCE (2026-08-26, the population the code touches, not a sample):
--   population (editions with an FMV change in 6h) ......... 4,028
--   fast path taken (cache fresh enough) .................. 3,439  (85.4%)
--   FAST-PATH DISAGREEMENTS WITH THE INCUMBENT ............     0
--   stale cache rows the guard correctly REJECTS .........     28
-- The last line is the positive control: it proves the guard is doing work, not
-- merely passing. A bare COALESCE would have published all 28.
--
-- SOUND BY CONSTRUCTION, not only empirically: refresh_edition_fmv_current builds
-- the cache with `DISTINCT ON (edition_id) ... ORDER BY computed_at DESC` over the
-- same fmv_snapshots, i.e. the identical selection rule. Its DISTINCT ON does not
-- filter `fmv_usd IS NOT NULL` while the subquery does, so a NULL latest snapshot
-- could diverge -- which is why the join also requires `efc.fmv_usd IS NOT NULL`.
-- With that clause a fast-path row is the latest snapshot overall AND non-null,
-- hence necessarily the latest non-null one.
--
-- Everything else in this body is byte-identical to
-- 20260822213000_audit_20260822_rwfc_temp_build_materialized_cte.sql.
--
-- anon-exec: unchanged (refresh_wmc_fmv_changed) — a CREATE OR REPLACE of an EXISTING function, and
-- CREATE OR REPLACE does not reset a function's ACL, so a REVOKE here would be a
-- production privilege change smuggled into a planner fix. VERIFIED against the live
-- database immediately after applying, rather than assumed
-- (has_function_privilege on refresh_wmc_fmv_changed(integer,integer)):
--   anon = false, authenticated = false, service_role = true.
-- The existing revoke stands and this migration does not touch it.

CREATE OR REPLACE FUNCTION public.refresh_wmc_fmv_changed(p_since_minutes integer DEFAULT 30, p_limit integer DEFAULT 50000)
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
  v_timeout_ms bigint;
  v_budget     interval;
  v_deadline   timestamptz;
  -- Sized to fit the SMALLEST caller budget (service_role 30s), never scaled up.
  v_chunk      constant integer := 5;
BEGIN
  SELECT setting::bigint INTO v_timeout_ms FROM pg_settings WHERE name = 'statement_timeout';

  IF v_timeout_ms IS NULL OR v_timeout_ms = 0 THEN
    v_budget := interval '300 seconds';
  ELSE
    v_budget := GREATEST(make_interval(secs => (v_timeout_ms / 1000.0) * 0.6),
                         interval '5 seconds');
  END IF;
  v_deadline := clock_timestamp() + v_budget;

  SELECT last_cutoff INTO v_cutoff FROM public.rwfc_state WHERE id = 1;
  IF v_cutoff IS NULL THEN
    v_cutoff := v_run_start - make_interval(mins => GREATEST(p_since_minutes, 1));
  END IF;

  DROP TABLE IF EXISTS _rwfc_recent;
  -- The filter is wrapped in a MATERIALIZED CTE so the planner cannot use
  -- fmv_snapshots_2026_edition_id_computed_at_idx to supply DISTINCT ON's ordering
  -- for free. That index leads on edition_id while the predicate is on computed_at,
  -- so there is no range to seek and the whole 2026 index is walked -- on a 418x row
  -- overestimate. Materialising first removes the ordering incentive; the planner
  -- then seeks idx_fmv_snapshots_2026_computed_at_desc and pays a tiny quicksort.
  -- Measured 2026-08-22, warm-vs-warm, same 563 output rows: 8,402 buffers / 471 ms
  -- as written vs 29 buffers / 0.98 ms wrapped. Output diffed with EXCEPT in BOTH
  -- directions: 0 rows only-in-incumbent, 0 rows only-in-candidate.
  CREATE TEMP TABLE _rwfc_recent ON COMMIT DROP AS
  WITH recent AS MATERIALIZED (
    SELECT fs.edition_id, fs.computed_at
    FROM public.fmv_snapshots fs
    WHERE fs.computed_at > v_cutoff
      AND fs.fmv_usd IS NOT NULL
  )
  SELECT DISTINCT ON (r.edition_id) r.edition_id, r.computed_at
  FROM recent r
  ORDER BY r.edition_id, r.computed_at DESC;
  CREATE INDEX ON _rwfc_recent (computed_at);
  ANALYZE _rwfc_recent;

  LOOP
    WITH popped AS (
      DELETE FROM _rwfc_recent
       WHERE edition_id IN (
         SELECT edition_id FROM _rwfc_recent ORDER BY computed_at LIMIT v_chunk
       )
      RETURNING edition_id, computed_at
    ),
    latest_fmv AS MATERIALIZED (
      SELECT e.collection_id, e.external_id,
        -- FAST PATH FIRST. COALESCE evaluates left to right and stops at the first
        -- non-null, so the SubPlan below only runs for the rows the freshness guard
        -- rejected. That is the entire saving: no partition Append for ~85% of rows.
        COALESCE(
          efc.fmv_usd,
          (SELECT f.fmv_usd
             FROM public.fmv_snapshots f
            WHERE f.edition_id = e.id
              AND f.fmv_usd IS NOT NULL
            ORDER BY f.computed_at DESC
            LIMIT 1)
        ) AS fmv_usd
      FROM popped p
      JOIN public.editions e ON e.id = p.edition_id
      -- BOTH extra clauses are load-bearing and neither is a tidy-up:
      --   computed_at >= p.computed_at  -- the cache must not be BEHIND the snapshot
      --                                    that queued this edition (28 of 4,028 were)
      --   fmv_usd IS NOT NULL           -- the cache's DISTINCT ON does not filter
      --                                    nulls while the subquery does; without this
      --                                    a NULL latest snapshot would take the fast
      --                                    path and blank a real price
      LEFT JOIN public.edition_fmv_current efc
             ON efc.edition_id  = e.id
            AND efc.computed_at >= p.computed_at
            AND efc.fmv_usd IS NOT NULL
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
