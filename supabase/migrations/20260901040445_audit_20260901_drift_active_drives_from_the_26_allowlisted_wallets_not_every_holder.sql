-- audit_20260901_drift_active_drives_from_the_26_allowlisted_wallets_not_every_holder
-- anon-exec: refresh_wmc_fmv_drift_active — SECURITY DEFINER, service_role/postgres only. ACL measured 2026-09-01 and
-- UNCHANGED by this migration (CREATE OR REPLACE preserves it); only the loop body's join order changes.
--
-- WHY (measured 2026-09-01 with the newly scheduled ops_pgss_delta, over a 2h53m window):
-- refresh_wmc_fmv_drift_active is the NUMBER ONE consumer of this instance —
--   1,084,765 shared_blks_read over 35 calls = 30,993 blocks (~242 MB) PER CALL, 16.2 s per call.
-- That is ~8.5 GB of disk reads every three hours from one function, on an instance whose scarce
-- resource is IOPS. It runs every ~5 minutes and burns its full 15-second budget each time.
--
-- ⚠ THE COST IS NOT THE UPDATE. IT IS THE ROWS IT FETCHES IN ORDER TO REJECT THEM.
-- EXPLAIN (ANALYZE, BUFFERS) of one 25-edition chunk, as written:
--     Index Scan using idx_wmc_coll_ek_serial_cover  rows=304..385 per edition, 25 loops
--     Buffers: 6,711-8,231        Rows Removed by Join Filter: 9,613        final rows: 0
-- The index leads on (collection_id, edition_key), so it returns EVERY holder of the edition
-- across the whole 2.5M-row table, and the wallet restriction is applied afterwards as a hash
-- join on the heap-fetched rows. But the restriction is tiny and known up front:
--     allow_list active wallets ........ 26
--     wmc rows owned by those wallets .. 202,881 of 2,506,331 = 8.1%
-- So ~92% of every row this function touches is fetched from the heap and thrown away.
--
-- ⚠ A HYPOTHESIS I HELD AND MEASURED AS FALSE, recorded so nobody re-runs it: I expected most
-- CHANGED editions to be held by nobody in the allow list, and planned to intersect the queue
-- against the held set before chunking. Measured: 5,581 of 6,206 changed editions (90%) ARE held.
-- That machinery would have removed 10% of the work and added a cache to keep fresh. Dropped.
--
-- WHAT SHIPS: the loop drives from the 26 wallets instead of from the edition. New index
-- idx_wmc_wallet_coll_ek_fmv (wallet_address, collection_id, edition_key) INCLUDE (fmv_usd),
-- 175 MB, built CONCURRENTLY out of band, turns each chunk into 26x25 = 650 exact index probes.
--
-- ⚠ `OFFSET 0` IS LOAD-BEARING AND IS NOT A STYLE CHOICE. Three shapes were measured; the first
-- two both got FLATTENED back into the original hash join and used the old index:
--     as written (hash join on wallets) ........... wmc buffers 6,711   [old index]
--     CROSS JOIN LATERAL, no fence ................ wmc buffers 6,711   [old index, flattened]
--     wallet_address = ANY(ARRAY[26 literals]) .... wmc buffers 6,711   [old index, post-filter]
--     CROSS JOIN LATERAL + OFFSET 0 ............... wmc buffers 2,983   [NEW index, Index Only Scan]
-- The planner will not choose the new index on its own: it estimates rows=39 per edition from the
-- old index when the actual is 304-385, so 650 cheap descents look dearer to it than 25 expensive
-- ones. The fence is what stops the pull-up. Remove it and the regression is silent — same rows,
-- same result, 2.25x the I/O. (Same fence, same reason, as commit 0dcd689 on
-- refresh_unmapped_backlog_growth.)
--
-- Total query buffers 7,077 -> 3,349. Residual cost is 239 heap fetches on the Index Only Scan,
-- which is ordinary churn and NOT autovacuum starvation: wmc already carries
-- autovacuum_vacuum_scale_factor=0.02 and was autovacuumed 45 min and autoanalyzed 5 min before
-- this measurement. Checked so the next pass does not chase it.
--
-- ⚠ WALL-CLOCK IS NOT THE CLAIM. Warm, the old shape times 24 ms and the new one 65 ms; the new
-- shape pays CPU for 650 index descents. Buffers are the honest metric here (a plan change cannot
-- be faked by a warm cache, a wall-clock ratio can) and the instance is IOPS-throttled, so halving
-- I/O on its largest consumer is the right trade even at slightly higher CPU. The function is
-- deadline-bounded either way: it drains for 15 s and stops, so this changes what a tick COSTS,
-- not how long it runs.
--
-- EQUIVALENCE: `wmc.edition_key IS NOT NULL` is dropped because `edition_key = e.external_id`
-- already excludes NULL. `wallet_address IN (SELECT ... FROM _rwfd_wallets)` becomes a CROSS JOIN
-- against the same temp table, which cannot duplicate rows because wallet_address is its PRIMARY
-- KEY. The deviation predicate is character-identical. Everything outside the LOOP -- the
-- MATERIALIZED changed-set CTE and its 21,291->956 buffer fix, the wallet set, the staircase
-- cutoff write -- is untouched.
--
-- EXIT CONDITION, to be checked by the next pass with
--   SELECT * FROM public.ops_pgss_delta('2 hours', 50) WHERE q ILIKE '%drift_active%';
-- blocks per call must fall WELL below the pre-change 30,993. Predicted ~14,000-16,000 on the
-- measured 2.25x. ⚠ If it lands near 30,993 the fence was optimised away or the planner reverted:
-- re-run the EXPLAIN above and check which index appears. Do NOT judge this on wall-clock.
--
-- REVERT: CREATE OR REPLACE with the pre-2026-09-01 body (git history; the only delta is the LOOP's
--         first CTE chain), then optionally DROP INDEX CONCURRENTLY public.idx_wmc_wallet_coll_ek_fmv.

CREATE INDEX IF NOT EXISTS idx_wmc_wallet_coll_ek_fmv
  ON public.wallet_moments_cache (wallet_address, collection_id, edition_key)
  INCLUDE (fmv_usd);
-- ⓘ Already present when this migration ran: built CONCURRENTLY out of band by one-off pg_cron job
-- 'oneoff-wmc-wallet-coll-ek-index' (as postgres — cron_heavy cannot CREATE INDEX), verified
-- indisvalid = true, then unscheduled. IF NOT EXISTS makes this a no-op that keeps the DDL on the
-- record; a fresh environment building it non-concurrently is acceptable because it has no traffic.

CREATE OR REPLACE FUNCTION public.refresh_wmc_fmv_drift_active(p_deviation_pct numeric DEFAULT 25, p_limit integer DEFAULT 20000)
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
  -- The filter is wrapped in a MATERIALIZED CTE so the planner cannot use
  -- fmv_snapshots_2026_edition_id_computed_at_idx to supply DISTINCT ON's ordering for
  -- free. That index leads on edition_id while the predicate is on computed_at, so there
  -- is no range to seek and the whole 2026 index is walked. Materialising first removes
  -- the ordering incentive; the planner then seeks the index that already exists for
  -- exactly this, idx_fmv_snapshots_2026_computed_at_desc, and pays a tiny quicksort.
  -- Measured 2026-08-28, warm-vs-warm, same 12,600 output rows: 21,291 buffers as
  -- written vs 956 wrapped. Diffed with EXCEPT ALL in BOTH directions, 0 rows each way.
  -- AS MATERIALIZED is load-bearing -- PG12+ inlines a CTE referenced once, which
  -- restores the ordering incentive and the defect with it.
  -- The identical defect and the identical fix live in refresh_wmc_fmv_changed
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
    -- DRIVE FROM THE 26 WALLETS, NOT FROM THE EDITION. See this migration's header: leading
    -- with (collection_id, edition_key) returns every holder on a 2.5M-row table and discards
    -- ~92% of them after a heap fetch, because only 8.1% of wmc belongs to an active wallet.
    --
    -- ⚠⚠ `OFFSET 0` IS A PLANNER FENCE, NOT DEAD SYNTAX. Without it the planner pulls this
    -- lateral up into a hash join and reverts to idx_wmc_coll_ek_serial_cover -- measured, same
    -- rows out, 6,711 buffers instead of 2,983. It will do this because it estimates rows=39 per
    -- edition where the actual is 304-385. DO NOT REMOVE IT, and do not "simplify" this into a
    -- plain join. Same fence, same reason, as refresh_unmapped_backlog_growth (0dcd689).
    targets AS MATERIALIZED (
      SELECT h.id AS wmc_id, p.fmv_usd
      FROM popped p
      JOIN public.editions e ON e.id = p.edition_id
      CROSS JOIN _rwfd_wallets w
      CROSS JOIN LATERAL (
        SELECT wmc.id, wmc.fmv_usd
          FROM public.wallet_moments_cache wmc
         WHERE wmc.wallet_address = w.wallet_address
           AND wmc.collection_id  = e.collection_id
           AND wmc.edition_key    = e.external_id
         OFFSET 0
      ) h
      WHERE h.fmv_usd IS NULL
         OR abs(h.fmv_usd - p.fmv_usd) > p.fmv_usd * v_frac
    ),
    upd AS (
      UPDATE public.wallet_moments_cache t
         SET fmv_usd = tg.fmv_usd
        FROM targets tg
       WHERE t.id = tg.wmc_id
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

DO $mig$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'refresh_wmc_fmv_drift_active';

  -- The fence is the whole fix. Assert it survived, so a future edit that "tidies" it away
  -- cannot pass silently.
  IF v_def IS NULL OR v_def NOT LIKE '%OFFSET 0%' THEN
    RAISE EXCEPTION 'POST-STATE FAILED: the OFFSET 0 planner fence is missing from refresh_wmc_fmv_drift_active';
  END IF;
  IF v_def NOT LIKE '%_rwfd_wallets w%' THEN
    RAISE EXCEPTION 'POST-STATE FAILED: the loop does not drive from the wallet set';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname = 'idx_wmc_wallet_coll_ek_fmv' AND i.indisvalid
  ) THEN
    RAISE EXCEPTION 'POST-STATE FAILED: idx_wmc_wallet_coll_ek_fmv missing or INVALID';
  END IF;

  IF has_function_privilege('anon', 'public.refresh_wmc_fmv_drift_active(numeric, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POST-STATE FAILED: anon can execute refresh_wmc_fmv_drift_active';
  END IF;
END
$mig$;