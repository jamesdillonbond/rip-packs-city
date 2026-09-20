-- audit_20260920_allday_repair_leg_ordered_by_sealed_at_accumulates_permanent_residue_at_its_head
--
-- ONE LINE CHANGES: the All Day repair leg's ORDER BY, `pr.sealed_at DESC` ->
-- `pr.metadata_updated_at ASC NULLS FIRST`. Everything else is byte-identical to
-- 20260920203815, applied two minutes earlier.
--
-- ══ HOW IT WAS FOUND ═══════════════════════════════════════════════════════
-- By reading the payload of the smoke-test call for 20260920203815, not by
-- reading the code. That run returned `allday_resolved: 0` with a 10-slot All Day
-- share, and 0 is the reading register #93 warns about in the abstract: a repair
-- leg whose ORDER BY cannot move, re-selecting its own head forever.
--
-- ══ THE MECHANISM ══════════════════════════════════════════════════════════
-- `sealed_at` is IMMUTABLE. The leg selects the newest N All Day rips it could
-- price; a row it CAN price gets a value and leaves the population; a row it
-- cannot stays exactly where it was, at the head, and is selected again next
-- tick. So the leg advances through everything priceable and accumulates the
-- unpriceable permanently above its own frontier. Throughput decays to zero,
-- monotonically, with nothing reporting it.
--
-- ⚠ AND NOTHING WOULD HAVE REPORTED IT. `pipeline_runs.extra.allday_resolved`
-- read 135-217/tick through the decay, because the STALE leg re-prices All Day
-- rows through the same `allday_pull_values` arm and its count is not
-- per-leg -- the route's own comment already says so ("It counts PRICED-BY-THAT-
-- ARM, not NEWLY-VALUED... this reads 135-217 while the net-new count is the
-- repair leg's cap of 50"). The repair leg's contribution was 0 and the shared
-- counter hid it.
--
-- ══ MEASURED, 2026-09-20 ~1:4x PM PT (dated samples; re-derive before quoting) ══
-- The leg's population (All Day, value NULL, has pulls, no NULL edition_id):
--     stamped rows ......... 54,255, of which 53,527 (98.7 %) fully priceable
--     never-stamped rows ....  4,142, of which  4,123 (99.5 %) fully priceable
-- The ten rows the leg actually selected at p_limit 100, BEFORE this change --
-- every one partly priced, so every one unwritable:
--     moments_pulled/priced: 1/0 · 5/4 · 5/4 · 2/1 · 5/4 · 5/4 · 2/1 · 5/4 · 1/0 · 2/1
-- ⭐ Ten unpriceable rows at the head of a 98.7 %-priceable population is not a
-- sample outcome. It is the residue, and it is the proof of the mechanism.
--
-- BEFORE / AFTER, same box, same p_limit, 153 seconds apart (10:39 AM PT
-- postmaster start, so both readings are the LARGE instance -- CLAUDE.md #126):
--     p_limit 100, before: allday_resolved  0 of 10 slots, value_newly_written  5
--     p_limit 100, after:  allday_resolved 10 of 10 slots, value_newly_written 15
--     p_limit 500, after:  allday_resolved 50 of 50 slots, value_newly_written 75,
--                          zero_repriced 70, zero_cleared 5, 6.7 s of a 50 s budget
--
-- ══ WHY `NULLS FIRST` ══════════════════════════════════════════════════════
-- The 4,142 never-stamped rows are 99.5 % priceable, so putting them first drains
-- them in ~83 ticks and they then stop competing. After that the leg is ordered by
-- a column the leg itself WRITES, so each pass rotates the population instead of
-- re-reading its own head -- the same rule the `zero_repair` and `unpriced_retry`
-- legs use, for the same reason.
--
-- ⚠ WHAT THIS DOES NOT FIX. The ~747 genuinely unpriceable rows are still
-- unpriceable; they now cost one visit per full rotation instead of one per tick.
-- Their cause is upstream (an edition with no `fmv_snapshots` row), not here.
--
-- REVERT: re-apply the body from 20260920203815 (the ONLY difference is this
-- leg's ORDER BY). No data half.
--
-- anon-exec: intentional — CREATE OR REPLACE keeps the ACL of backfill_pack_rip_metadata, so a revoke here would CHANGE production rather than preserve it; verified live after the apply (anon false, authenticated false, service_role true). Its only caller is /api/cron/backfill-pack-rip-metadata on the service role.

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
  -- ⚠ ORDERED BY THE STAMP, NOT BY `sealed_at DESC`, AND THAT IS THE WHOLE
  -- POINT OF THIS VERSION. `sealed_at` is IMMUTABLE, so a row this leg selects
  -- and cannot price is selected again on the next tick, forever, while the leg
  -- advances past everything it CAN price. The unpriceable rows therefore pile
  -- up permanently at the head and the leg's throughput decays to zero --
  -- measured 2026-09-20: 10 of 10 slots at p_limit 100 were such residue
  -- (`allday_resolved` 0) although 57,650 of 58,397 rows in this leg's
  -- population (98.7 %) are fully priceable right now. NULLS FIRST keeps the
  -- 4,142 never-stamped rows at the front (99.5 % priceable); after that the
  -- restamp rotates the population instead of re-reading its own head.
  allday_repair AS MATERIALIZED (
    SELECT pr.id, pr.pack_nft_id, pr.collection_id, pr.dist_id AS cur_dist,
           pr.pull_value_usd AS cur_value, pr.moments_pulled
    FROM public.pack_rips pr
    WHERE pr.collection_id = v_allday
      AND pr.pull_value_usd IS NULL
      AND EXISTS (
        SELECT 1 FROM public.allday_pack_pull ap
        WHERE ap.pack_nft_id = pr.pack_nft_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.allday_pack_pull ap
        WHERE ap.pack_nft_id = pr.pack_nft_id AND ap.edition_id IS NULL
      )
    ORDER BY pr.metadata_updated_at ASC NULLS FIRST
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
    LIMIT (v_safe_limit - v_stale_share - v_allday_share - v_zero_share - v_unpriced_share)
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
