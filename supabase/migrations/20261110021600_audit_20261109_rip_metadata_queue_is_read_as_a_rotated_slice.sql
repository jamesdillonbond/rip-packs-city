-- audit_20261109_rip_metadata_queue_is_read_as_a_rotated_slice
--
-- #242, second step (2026-11-09 ~6:10 PM PT, Claude Code cloud). The first step (20261110005700,
-- applied by Cowork 4:57 PM PT) moved the two eligibility SETS into pack_rip_backfill_eligible. The
-- first production call on it (5:53 PM PT) ran 40.6 s vs 44.6 s the hour before: the unpriced leg
-- still re-checked EVERY queued row — 33,716 pack_rips probes, 11.5 s / 135 k buffers cold (EXPLAIN,
-- ~6 PM PT) — to keep the oldest 75. The queue holds 34,169 rows, not the "few hundred" the first
-- step's runbook assumed (that was the per-call take).
--
-- WHAT. The queue carries each row's pack_rips stamp (`stamp`, indexed with `leg`); the refresh
-- writes it; each backfill leg reads the oldest 4 x share rows BY THAT STAMP, re-checks only those,
-- and rotates the whole slice to now() so a queued row that stopped qualifying cannot hold the head
-- until the next refresh. A row the backfill takes gets now() in both places, so the order stays
-- oldest-stamp-first. Same predicates, same shares, every other leg byte-identical.
--
-- PIN: supabase/tests/backfill_pack_rip_metadata.sql (both functions verbatim; +1 property: a slice
--      of rows that no longer qualify is rotated away and the qualifying row behind it is reached).
-- anon-exec: unchanged (backfill_pack_rip_metadata) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved.
-- anon-exec: unchanged (refresh_pack_rip_backfill_eligible) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved.
-- REVERT: re-apply both functions from 20261110005700_audit_20261109_rip_metadata_eligibility_is_precomputed.sql
--         (the extra column and index can stay; that body ignores them).

ALTER TABLE public.pack_rip_backfill_eligible ADD COLUMN IF NOT EXISTS stamp timestamptz;
UPDATE public.pack_rip_backfill_eligible q
   SET stamp = pr.metadata_updated_at
  FROM public.pack_rips pr
 WHERE pr.id = q.rip_id AND q.stamp IS NULL;
CREATE INDEX IF NOT EXISTS idx_pack_rip_backfill_eligible_leg_stamp
  ON public.pack_rip_backfill_eligible (leg, stamp NULLS FIRST, rip_id);

CREATE OR REPLACE FUNCTION public.refresh_pack_rip_backfill_eligible()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_allday  uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';
  v_allday_n int := 0;
  v_unpriced_n int := 0;
  v_removed int := 0;
BEGIN
  -- The two eligibility sets backfill_pack_rip_metadata's allday_repair and unpriced_retry legs
  -- used to build on EVERY call (#242). Same predicates as those legs had inline (2026-10-16
  -- set form). WRITE FIRST, then delete only what this refresh did not write: a reader never
  -- sees an empty queue mid-refresh.
  -- 2026-11-09 evening: each row carries its pack_rips stamp so the backfill reads an ordered SLICE.
  WITH allday_unresolved AS MATERIALIZED (
    SELECT DISTINCT ap.pack_nft_id
    FROM public.allday_pack_pull ap
    WHERE ap.edition_id IS NULL
  ),
  allday_set AS (
    SELECT pr.id, pr.metadata_updated_at AS stamp
    FROM public.pack_rips pr
    WHERE pr.collection_id = v_allday
      AND pr.pull_value_usd IS NULL
      AND pr.metadata_updated_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM allday_unresolved u WHERE u.pack_nft_id = pr.pack_nft_id)
      AND EXISTS (SELECT 1 FROM public.allday_pack_pull ap WHERE ap.pack_nft_id = pr.pack_nft_id)
  ),
  ins AS (
    INSERT INTO public.pack_rip_backfill_eligible (leg, rip_id, refreshed_at, stamp)
    SELECT 'allday', id, v_started, stamp FROM allday_set
    ON CONFLICT (leg, rip_id) DO UPDATE SET refreshed_at = EXCLUDED.refreshed_at, stamp = EXCLUDED.stamp
    RETURNING 1
  )
  SELECT count(*) INTO v_allday_n FROM ins;

  WITH unpriced_set AS (
    SELECT pr.id, pr.metadata_updated_at AS stamp
    FROM (SELECT DISTINCT ma.source_pack_rip_id AS rid
            FROM public.moment_acquisitions ma
           WHERE ma.source_pack_rip_id IS NOT NULL) r
    JOIN public.pack_rips pr ON pr.id = r.rid
    WHERE pr.pull_value_usd IS NULL
      AND pr.metadata_updated_at IS NOT NULL
      AND pr.collection_id IS DISTINCT FROM v_allday
  ),
  ins AS (
    INSERT INTO public.pack_rip_backfill_eligible (leg, rip_id, refreshed_at, stamp)
    SELECT 'unpriced', id, v_started, stamp FROM unpriced_set
    ON CONFLICT (leg, rip_id) DO UPDATE SET refreshed_at = EXCLUDED.refreshed_at, stamp = EXCLUDED.stamp
    RETURNING 1
  )
  SELECT count(*) INTO v_unpriced_n FROM ins;

  DELETE FROM public.pack_rip_backfill_eligible WHERE refreshed_at < v_started;
  GET DIAGNOSTICS v_removed = ROW_COUNT;

  PERFORM public.log_pipeline_run(
    'pack-rip-backfill-eligible-refresh', v_started,
    v_allday_n + v_unpriced_n, v_allday_n + v_unpriced_n, 0,
    true, NULL, NULL, NULL, NULL,
    jsonb_build_object('allday', v_allday_n, 'unpriced', v_unpriced_n, 'removed', v_removed));

  RETURN jsonb_build_object('ok', true, 'allday', v_allday_n, 'unpriced', v_unpriced_n, 'removed', v_removed);
END
$function$;

CREATE OR REPLACE FUNCTION public.backfill_pack_rip_metadata(p_limit integer DEFAULT 500)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '50s'
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
DECLARE
  v_processed int := 0;
  v_newly_resolved int := 0;
  v_already_set int := 0;
  v_still_null int := 0;
  v_value_resolved int := 0;
  v_allday_resolved int := 0;
  v_zero_cleared int := 0;
  v_zero_repriced int := 0;
  v_value_newly_written int := 0;
  v_safe_limit int := LEAST(GREATEST(COALESCE(p_limit, 500), 1), 5000);
  v_stale_share int;
  v_allday_share int;
  v_zero_share int;
  v_unpriced_share int;
  v_allday uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';
BEGIN
  v_stale_share    := GREATEST(1, (v_safe_limit * 2) / 10);
  v_allday_share   := GREATEST(1, v_safe_limit / 10);
  v_zero_share     := GREATEST(1, (v_safe_limit * 15) / 100);
  v_unpriced_share := GREATEST(1, v_safe_limit / 20);

  WITH stale_valued AS MATERIALIZED (
    SELECT pr.id, pr.pack_nft_id, pr.collection_id, pr.dist_id AS cur_dist,
           pr.pull_value_usd AS cur_value, pr.moments_pulled
    FROM public.pack_rips pr
    WHERE pr.pull_value_usd IS NOT NULL
      AND pr.metadata_updated_at < now() - interval '7 days'
    ORDER BY pr.metadata_updated_at ASC
    LIMIT v_stale_share
  ),
  -- Clears the fabricated zeros the pre-2026-09-20 body wrote (82,864 Top Shot
  -- rows at filing). Oldest stamp first, and a selected row leaves this leg
  -- whatever happens -- it is priced, or it becomes NULL -- so the leg drains
  -- monotonically and cannot spin.
  zero_repair AS MATERIALIZED (
    SELECT pr.id, pr.pack_nft_id, pr.collection_id, pr.dist_id AS cur_dist,
           pr.pull_value_usd AS cur_value, pr.moments_pulled
    FROM public.pack_rips pr
    WHERE pr.pull_value_usd = 0
    ORDER BY pr.metadata_updated_at ASC
    LIMIT v_zero_share
  ),
  -- Cold-start sweep for rollup_allday_rip_pull_value()'s watermark.
  -- Every pull's EDITION must be known; the snapshot lookup decides the rest.
  -- ⚠ ORDERED BY THE STAMP, NOT BY `sealed_at DESC`. `sealed_at` is IMMUTABLE,
  -- so a row this leg selects and cannot price is selected again on the next tick,
  -- forever, while the leg advances past everything it CAN price -- the
  -- unpriceable pile up permanently at the head and throughput decays to zero.
  -- Measured 2026-09-20: 10 of 10 slots at p_limit 100 were such residue
  -- (`allday_resolved` 0) although 98.7 % of this leg's population was fully
  -- priceable. A stamp the function itself writes rotates the population instead.
  -- ⚠ `metadata_updated_at IS NOT NULL` IS NOT A NARROWING, IT IS THE INDEX
  -- PREDICATE. Without it this ORDER BY has no usable index and the leg becomes a
  -- parallel seq scan of pack_rips plus a 16 MB external-merge sort: 195,112
  -- shared + 22,834 temp buffers, versus 1,778 with
  -- `idx_pack_rips_unvalued_stamped (metadata_updated_at) WHERE pull_value_usd IS
  -- NULL AND metadata_updated_at IS NOT NULL` (2,720 kB). Never-stamped rows lose
  -- nothing: `null_drain` stamps them, and they enter this leg on the next pass.
  -- 2026-10-16: the two eligibility tests are read ONCE as sets instead of probed per row.
  -- Walked in stamp order with per-row EXISTS / NOT EXISTS, this leg had to pass every
  -- stamped-unvalued All Day rip that fails them -- they are never selected, so never
  -- re-stamped, so they never leave the head: 615,744 rows walked and 3.2 M buffers / 11 s
  -- per run to find 150 of the 535 that qualify (10-16). Same predicate, same ORDER BY and
  -- LIMIT; the set is built by hash joins (3.6 s / 238 k buffers standalone).
  -- Through the function (rolled-back EXPLAIN, p_limit 1500, 10-16): 4.28 M -> 453 k buffers,
  -- 6.4 s -> 3.7 s warm. The 10-04 attempt (reverted, 20261004172500) ran slower INSIDE the
  -- function; force_custom_plan has been set since, and this one was timed there first.
  -- 2026-11-09 (#242): the eligibility SET is precomputed. Built inline it cost ~7 s / 247 k
  -- buffers per call regardless of p_limit (the WHOLE set before a LIMIT of 150), and with the
  -- unpriced leg below it was ~19 s of fixed cost inside a 50 s budget: 40 % of hours timed out
  -- on 11-09. refresh_pack_rip_backfill_eligible() (pg_cron, every 2 h) writes the set into
  -- pack_rip_backfill_eligible; here every queued row is RE-CHECKED against the same predicate
  -- (index probes on a few hundred rows), so a row that stopped qualifying is never taken. Same
  -- ORDER BY and LIMIT. A row that STARTS qualifying waits for the next refresh (<= 2 h).
  -- 2026-11-09 evening (#242, second step): re-checking EVERY queued row cost a pack_rips probe
  -- per row (unpriced: 33,716 probes, 11.5 s / 135 k buffers cold, measured 6 PM PT) to keep the
  -- oldest 75. The queue now carries each row's stamp: read the oldest SLICE (4 x the share) by it,
  -- re-check only those, and ROTATE the whole slice (its stamp -> now(), in allday_rotate /
  -- unpriced_rotate) so a queued row that no longer qualifies cannot hold the head until the next
  -- refresh. A taken row's queue stamp moves with its pack_rips stamp, so the order is the same
  -- oldest-stamp-first the legs always had.
  allday_slice AS MATERIALIZED (
    SELECT q.rip_id
    FROM public.pack_rip_backfill_eligible q
    WHERE q.leg = 'allday'
    ORDER BY q.stamp ASC NULLS FIRST, q.rip_id
    LIMIT v_allday_share * 4
  ),
  allday_rotate AS (
    UPDATE public.pack_rip_backfill_eligible q
       SET stamp = now()
      FROM allday_slice s
     WHERE q.leg = 'allday' AND q.rip_id = s.rip_id
  ),
  allday_repair AS MATERIALIZED (
    SELECT pr.id, pr.pack_nft_id, pr.collection_id, pr.dist_id AS cur_dist,
           pr.pull_value_usd AS cur_value, pr.moments_pulled
    FROM allday_slice s
    JOIN public.pack_rips pr ON pr.id = s.rip_id
    WHERE pr.collection_id = v_allday
      AND pr.pull_value_usd IS NULL
      AND pr.metadata_updated_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.allday_pack_pull u
                       WHERE u.pack_nft_id = pr.pack_nft_id AND u.edition_id IS NULL)
      AND EXISTS (SELECT 1 FROM public.allday_pack_pull ap WHERE ap.pack_nft_id = pr.pack_nft_id)
    ORDER BY pr.metadata_updated_at ASC
    LIMIT v_allday_share
  ),
  -- The stamped-but-unvalued population (#93). It is reachable ONLY here: the
  -- drain re-selects on `metadata_updated_at IS NULL` and the stale leg on
  -- `pull_value_usd IS NOT NULL`, so a stamped NULL row matches neither.
  -- ⚠ ORDERED OLDEST-STAMP-FIRST, same reason as the leg above.
  -- ⚠ `EXISTS (moment_acquisitions)` is what keeps the population bounded:
  -- 381,278 of the 385,102 stamped-NULL rows at filing have NO acquisition row
  -- at all and are unpriceable by construction, so they are never selected.
  -- 2026-10-16: same head-pile-up as allday_repair above. Rows with no acquisition are
  -- never selected, so never re-stamped: the per-row EXISTS walk passed 167,274 of them
  -- (977 k buffers / 14.4 s) for 75 picks. The eligible set is built from the acquisitions
  -- side once (33 k rows, 168 k buffers / 1.7 s standalone); same predicate, ORDER BY, LIMIT.
  -- 2026-11-09 (#242): precomputed, same as allday_repair above. Built inline this set cost
  -- ~12 s / 233 k buffers per call (348 k distinct acquisition rip ids hashed against 451 k
  -- stamped-unvalued rips) for a share of 75. Queued rows are re-checked here.
  unpriced_slice AS MATERIALIZED (
    SELECT q.rip_id
    FROM public.pack_rip_backfill_eligible q
    WHERE q.leg = 'unpriced'
    ORDER BY q.stamp ASC NULLS FIRST, q.rip_id
    LIMIT v_unpriced_share * 4
  ),
  unpriced_rotate AS (
    UPDATE public.pack_rip_backfill_eligible q
       SET stamp = now()
      FROM unpriced_slice s
     WHERE q.leg = 'unpriced' AND q.rip_id = s.rip_id
  ),
  unpriced_retry AS MATERIALIZED (
    SELECT pr.id, pr.pack_nft_id, pr.collection_id, pr.dist_id AS cur_dist,
           pr.pull_value_usd AS cur_value, pr.moments_pulled
    FROM unpriced_slice s
    JOIN public.pack_rips pr ON pr.id = s.rip_id
    WHERE pr.pull_value_usd IS NULL
      AND pr.metadata_updated_at IS NOT NULL
      AND pr.collection_id IS DISTINCT FROM v_allday
      AND EXISTS (SELECT 1 FROM public.moment_acquisitions ma WHERE ma.source_pack_rip_id = pr.id)
    ORDER BY pr.metadata_updated_at ASC
    LIMIT v_unpriced_share
  ),
  null_drain AS MATERIALIZED (
    SELECT pr.id, pr.pack_nft_id, pr.collection_id, pr.dist_id AS cur_dist,
           pr.pull_value_usd AS cur_value, pr.moments_pulled
    FROM public.pack_rips pr
    WHERE pr.metadata_updated_at IS NULL
    ORDER BY pr.sealed_at DESC
    -- ⚠ GREATEST(0, ...): every other share has a GREATEST(1, ...) floor, so at
    -- a small p_limit the shares can exceed the limit and this expression goes
    -- NEGATIVE -- `LIMIT -1` is a runtime error (22023), not a small batch. It
    -- errored for p_limit 1..3 (and for 1..2 before the two new legs existed).
    -- No production caller passes such a value; a test harness does.
    LIMIT GREATEST(0, v_safe_limit - v_stale_share - v_allday_share - v_zero_share - v_unpriced_share)
  ),
  candidates AS MATERIALIZED (
    SELECT DISTINCT ON (id) id, pack_nft_id, collection_id, cur_dist, cur_value, moments_pulled
    FROM (
      SELECT * FROM stale_valued
      UNION ALL
      SELECT * FROM zero_repair
      UNION ALL
      SELECT * FROM allday_repair
      UNION ALL
      SELECT * FROM unpriced_retry
      UNION ALL
      SELECT * FROM null_drain
    ) u
  ),
  rip_editions AS MATERIALIZED (
    SELECT c.id AS rip_id, c.collection_id, m.edition_id
    FROM candidates c
    JOIN public.moment_acquisitions ma ON ma.source_pack_rip_id = c.id
    JOIN public.moments m ON m.nft_id = ma.nft_id AND m.collection_id = c.collection_id
    WHERE m.edition_id IS NOT NULL
    GROUP BY 1, 2, 3
  ),
  rip_counts AS (
    SELECT rip_id, count(*) AS n_ed FROM rip_editions GROUP BY 1
  ),
  votes AS (
    SELECT re.rip_id, pdp.dist_id, count(*) AS matched
    FROM rip_editions re
    JOIN public.pack_drop_pool pdp ON pdp.edition_id = re.edition_id AND pdp.collection_id = re.collection_id
    GROUP BY 1, 2
  ),
  full_matches AS (
    SELECT v.rip_id, v.dist_id
    FROM votes v
    JOIN rip_counts rc ON rc.rip_id = v.rip_id
    WHERE v.matched = rc.n_ed
  ),
  -- ⚠ A UNIQUE FULL MATCH ONLY (2026-11-02). The vote used to take the LOWEST dist_id among
  -- every pool that contained all pulled editions, so a pack whose real drop had no pool
  -- yet was filed under whichever older drop happened to share its editions: the 8911 AJ
  -- Dybantsa Tip-Off (absent from Dapper's frozen pack index, no pool) put 436 rips into
  -- 8552, 82 into 8447, 37 into 8545 and 36 into its sibling Tip-Offs. Ambiguous = unknown.
  best_dist AS (
    SELECT fm.rip_id, min(fm.dist_id) AS dist_id
    FROM full_matches fm
    GROUP BY fm.rip_id
    HAVING count(*) = 1
  ),
  -- ⚠ ALL-OR-NOTHING, AND WHOLE-PACK -- the property
  -- rollup_allday_rip_pull_value has been pinned on since 2026-09-12 and this
  -- arm did not have. It used to read `COALESCE(SUM(fc.fmv_usd), 0)`, which
  -- published TWO false claims as measured numbers: 0 for "not one of this
  -- pack's moments is priced", and a partial sum for "some are".
  --   count(*) = count(fc.fmv_usd)  -> every acquisition priced
  --   count(*) = c.moments_pulled   -> every moment the pack yielded is IN
  --                                    moment_acquisitions (a rip whose
  --                                    acquisitions are still landing is
  --                                    unknown, not cheap)
  pull_values AS (
    SELECT c.id AS rip_id,
           SUM(fc.fmv_usd)::numeric(14,2) AS pull_value_usd
    FROM candidates c
    JOIN public.moment_acquisitions ma ON ma.source_pack_rip_id = c.id
    LEFT JOIN public.moments m  ON m.nft_id = ma.nft_id AND m.collection_id = c.collection_id
    LEFT JOIN LATERAL (
      SELECT s.fmv_usd, s.collection_id
      FROM public.fmv_snapshots s
      WHERE s.edition_id = m.edition_id
      ORDER BY s.computed_at DESC
      LIMIT 1
    ) fc ON fc.collection_id = m.collection_id
    WHERE c.collection_id IS DISTINCT FROM v_allday
    GROUP BY c.id, c.moments_pulled
    HAVING count(*) = count(fc.fmv_usd)
       AND count(*) = c.moments_pulled
  ),
  -- All Day: exact join on pack_nft_id, priced from the SAME current-FMV source
  -- as Top Shot, ALL-OR-NOTHING per pack.
  -- ⚠ WHOLE-PACK TOO, since 2026-09-20, and it had to change in the SAME
  -- migration as rollup_allday_rip_pull_value(): they are the two writers of this
  -- one column and changing one alone makes them fight. Without
  -- `count(*) = c.moments_pulled`, "every allday_pack_pull row we hold is priced"
  -- silently becomes "the pack is worth this much" on a pack whose pull rows are
  -- still landing. Measured FREE when added: pull-row count = moments_pulled on
  -- 419,233 of 419,233 All Day rips that have any pull rows -- zero mismatches
  -- estate-wide, so it removes nothing today and bans the shape going forward.
  allday_pull_values AS (
    SELECT c.id AS rip_id,
           SUM(fc.fmv_usd)::numeric(14,2) AS pull_value_usd
    FROM candidates c
    JOIN public.allday_pack_pull ap ON ap.pack_nft_id = c.pack_nft_id
    LEFT JOIN LATERAL (
      SELECT f.fmv_usd
      FROM public.fmv_snapshots f
      WHERE f.edition_id = ap.edition_id
      ORDER BY f.computed_at DESC
      LIMIT 1
    ) fc ON true
    WHERE c.collection_id = v_allday
    GROUP BY c.id, c.moments_pulled
    HAVING count(*) = count(fc.fmv_usd)
       AND count(*) = c.moments_pulled
  ),
  upd AS (
    UPDATE public.pack_rips pr
    -- ⚠ FILL-ONLY (2026-09-24). An existing dist came from Dapper's own index
    -- (upsert_pack_rips_from_api / name_packs_from_identity); the pool vote is
    -- an INFERENCE and picked an OLD dist whose pool happens to contain every
    -- pulled edition when the pack's real (new) dist had no pool yet —
    -- 6,274 rips / 3,368 purchases disagreed with pack_nft_identity.
    SET dist_id              = COALESCE(pr.dist_id, bd.dist_id),
        -- ⚠ A ZERO IS CLEARED TO NULL; A POSITIVE VALUE IS PRESERVED. The
        -- asymmetry is deliberate. fmv_snapshots is written delete-then-insert,
        -- so "not priceable right now" can be a momentary absence rather than a
        -- fact -- a rule that downgraded every uncomputable row would blank a
        -- large share of the column on one unlucky tick. A stored 0 has no such
        -- defence: it was never a measurement.
        pull_value_usd       = COALESCE(
                                 apv.pull_value_usd,
                                 pv.pull_value_usd,
                                 CASE WHEN pr.pull_value_usd = 0 THEN NULL ELSE pr.pull_value_usd END
                               ),
        metadata_updated_at  = now()
    FROM candidates c
    LEFT JOIN best_dist bd            ON bd.rip_id = c.id
    LEFT JOIN pull_values pv          ON pv.rip_id = c.id
    LEFT JOIN allday_pull_values apv  ON apv.rip_id = c.id
    WHERE pr.id = c.id
    RETURNING pr.id,
              (pr.dist_id IS NOT NULL AND c.cur_dist IS NULL) AS dist_newly_resolved,
              (c.cur_dist IS NOT NULL)                        AS dist_already_set,
              (pr.dist_id IS NULL)                            AS dist_still_null,
              pr.pull_value_usd > 0                           AS value_resolved,
              (apv.pull_value_usd IS NOT NULL)                AS allday_resolved,
              (c.cur_value = 0 AND pr.pull_value_usd IS NULL) AS zero_cleared,
              (c.cur_value = 0 AND pr.pull_value_usd > 0)     AS zero_repriced,
              (c.cur_value IS NULL AND pr.pull_value_usd IS NOT NULL) AS value_newly_written
  )
  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE dist_newly_resolved),
    COUNT(*) FILTER (WHERE dist_already_set),
    COUNT(*) FILTER (WHERE dist_still_null),
    COUNT(*) FILTER (WHERE value_resolved),
    COUNT(*) FILTER (WHERE allday_resolved),
    COUNT(*) FILTER (WHERE zero_cleared),
    COUNT(*) FILTER (WHERE zero_repriced),
    COUNT(*) FILTER (WHERE value_newly_written)
  INTO v_processed, v_newly_resolved, v_already_set, v_still_null, v_value_resolved,
       v_allday_resolved, v_zero_cleared, v_zero_repriced, v_value_newly_written
  FROM upd;

  RETURN jsonb_build_object(
    'processed', v_processed,
    'dist_newly_resolved', v_newly_resolved,
    'dist_already_set', v_already_set,
    'dist_still_null', v_still_null,
    'value_resolved', v_value_resolved,
    'allday_resolved', v_allday_resolved,
    'zero_cleared', v_zero_cleared,
    'zero_repriced', v_zero_repriced,
    'value_newly_written', v_value_newly_written,
    'finished_at', now()
  );
END
$function$;
