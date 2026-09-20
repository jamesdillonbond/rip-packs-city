-- audit_20260920_allday_repair_leg_gets_the_index_predicate_its_new_order_by_needs
--
-- TWO LINES CHANGE in the All Day repair leg: it gains
-- `AND pr.metadata_updated_at IS NOT NULL`, and its ORDER BY drops `NULLS FIRST`
-- (there are no NULLs left to order). Everything else is byte-identical to
-- 20260920204628.
--
-- ══ WHY: I SHIPPED A 28x COST REGRESSION AN HOUR EARLIER AND THE CORRECTNESS
--         MEASUREMENT COULD NOT SEE IT ═══════════════════════════════════════
-- 20260920204056 re-ordered this leg from `sealed_at DESC` to the stamp the
-- function itself writes. That fix is right and stays: an immutable ORDER BY means
-- a row the leg cannot price is re-selected forever, so the unpriceable pile up at
-- the head and throughput decays to zero (measured: 10 of 10 slots wasted).
-- ⛔ But `metadata_updated_at` had no usable index, so the leg went from an
-- ordered index walk to a parallel seq scan of 3.69M rows plus a 16 MB
-- external-merge sort -- and the before/after I ran to prove the CORRECTNESS fix
-- (`allday_resolved` 0 -> 10) is silent about cost by construction.
--
-- ⭐ WHAT CAUGHT IT: the production `pipeline_runs` row, not my own probe.
-- The 20:53Z tick read `duration_ms` 37,000 against 4,746 an hour earlier, on the
-- same box, at the same p_limit. A probe that asks "is the output right?" cannot
-- answer "what did it cost?" -- and the lane had ~13 s of margin left on its 50 s
-- budget, so one more slow leg would have started killing ticks whose deltas all
-- roll back.
--
-- ══ MEASURED, same leg, same LIMIT 50, EXPLAIN (ANALYZE, BUFFERS) ══════════
-- All on the LARGE instance (postmaster start 2026-09-20 10:39 AM PT), so none of
-- this is a tier difference (CLAUDE.md #126):
--     sealed_at DESC, using idx_pack_rips_collection_time_pv
--                                         6,908 buffers ·    18 ms
--     metadata_updated_at, no index     195,112 shared + 22,834 temp ·  2,144 ms
--     metadata_updated_at, indexed        1,778 buffers ·    10 ms
--   unpriced_retry, same index               81 buffers ·   0.6 ms
--   whole RPC at the production p_limit 500:  36.4 s -> 5.8 s of a 50 s budget
-- ⭐ The indexed stamp order is CHEAPER than the sealed_at order it replaced.
--
-- ══ WHY A PREDICATE AND NOT JUST AN INDEX ══════════════════════════════════
-- The index is partial -- `WHERE pull_value_usd IS NULL AND metadata_updated_at IS
-- NOT NULL`, 385,909 rows / 2,720 kB, versus ~3.37M rows / ~110 MB without the
-- second clause on a table already carrying 11 indexes and 1.5 GB of them. A
-- partial index is only usable when the query REPEATS its predicate, so the leg
-- has to carry `metadata_updated_at IS NOT NULL` too. That is why this is a
-- function change and not only an index.
--
-- ⚠ NOTHING IS LOST BY EXCLUDING NEVER-STAMPED ROWS. `null_drain` selects exactly
-- `metadata_updated_at IS NULL` and stamps whatever it touches, so a never-stamped
-- All Day rip enters this leg's population on the following pass. The two legs
-- partition the table rather than compete for it -- which is also why the previous
-- version's `NULLS FIRST` was redundant work: it re-selected rows the drain had
-- already queued.
--
-- The index is the repo record in
-- supabase/migrations/20260920205900_idx_pack_rips_unvalued_stamped.sql.
-- ⛔ REVERT ORDER MATTERS: revert this function BEFORE dropping that index, or the
-- leg silently returns to the 195k-buffer plan with nothing reporting it.
--
-- REVERT: re-apply the body from 20260920204628. No data half.
--
-- anon-exec: intentional — CREATE OR REPLACE keeps the ACL of backfill_pack_rip_metadata, so a revoke here would CHANGE production rather than preserve it; verified live after the apply (anon false, authenticated false, service_role true, proconfig still search_path + statement_timeout=50s). Its only caller is /api/cron/backfill-pack-rip-metadata on the service role.
--
-- ⚠ The DDL below is BYTE-IDENTICAL to production: prosrc md5
-- db0798a87fad8de84215f839ebe013f7, length 11557, read back after the apply.

CREATE OR REPLACE FUNCTION public.backfill_pack_rip_metadata(p_limit integer DEFAULT 500)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '50s'
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
  allday_repair AS MATERIALIZED (
    SELECT pr.id, pr.pack_nft_id, pr.collection_id, pr.dist_id AS cur_dist,
           pr.pull_value_usd AS cur_value, pr.moments_pulled
    FROM public.pack_rips pr
    WHERE pr.collection_id = v_allday
      AND pr.pull_value_usd IS NULL
      AND pr.metadata_updated_at IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.allday_pack_pull ap
        WHERE ap.pack_nft_id = pr.pack_nft_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.allday_pack_pull ap
        WHERE ap.pack_nft_id = pr.pack_nft_id AND ap.edition_id IS NULL
      )
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
  unpriced_retry AS MATERIALIZED (
    SELECT pr.id, pr.pack_nft_id, pr.collection_id, pr.dist_id AS cur_dist,
           pr.pull_value_usd AS cur_value, pr.moments_pulled
    FROM public.pack_rips pr
    WHERE pr.pull_value_usd IS NULL
      AND pr.metadata_updated_at IS NOT NULL
      AND pr.collection_id IS DISTINCT FROM v_allday
      AND EXISTS (
        SELECT 1 FROM public.moment_acquisitions ma
        WHERE ma.source_pack_rip_id = pr.id
      )
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
  best_dist AS (
    SELECT DISTINCT ON (fm.rip_id) fm.rip_id, fm.dist_id
    FROM full_matches fm
    JOIN candidates c ON c.id = fm.rip_id
    ORDER BY fm.rip_id, (fm.dist_id = c.cur_dist) DESC, fm.dist_id
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
    GROUP BY c.id
    HAVING count(*) = count(fc.fmv_usd)
  ),
  upd AS (
    UPDATE public.pack_rips pr
    SET dist_id              = COALESCE(bd.dist_id, pr.dist_id),
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
