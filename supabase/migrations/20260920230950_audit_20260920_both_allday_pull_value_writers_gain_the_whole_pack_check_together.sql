-- audit_20260920_both_allday_pull_value_writers_gain_the_whole_pack_check_together
--
-- Closes register **#128 residual (b)**, the one that entry named as LATENT and
-- left open: *"the All Day pair has NO whole-pack check -- neither this writer nor
-- rollup_allday_rip_pull_value compares its pull count to moments_pulled."*
--
-- ══ WHY BOTH IN ONE MIGRATION, WHICH IS THE ONLY INTERESTING PART ══════════
-- `pack_rips.pull_value_usd` has exactly TWO writers. #128 was the defect of them
-- disagreeing — one wrote `COALESCE(SUM(...), 0)` while the other was pinned
-- all-or-nothing — so fixing the Top Shot arm's whole-pack check ALONE would have
-- recreated the same divergence one property over. ⚠ And the repo has already paid
-- for this once: `app/dashboard/packs/PackHistoryClient.tsx` records that the
-- 2026-09-12 basis change had to move both writers together *"because changing one
-- alone makes them fight, which is how the first attempt at this failed."*
--
-- ══ MEASURED FREE, OVER THE POPULATION AND NOT A SAMPLE ════════════════════
-- ⚠ #128 recorded 1,436/1,436 from a **sample**, which is not enough to add a
-- predicate that can only remove rows. Re-derived over every All Day rip holding
-- any `allday_pack_pull` row:
--
--   All Day rips with pull rows ................... 419,233
--   pull-row count = moments_pulled ............... 419,233   (100.00 %)
--   mismatches .................................... 0
--   mismatches that ALSO carry a value ............ 0
--   valued on a SHORT pack (the dangerous shape) .. 0
--
-- ⭐ So this removes nothing today. It is a **ban at zero** — the shape CLAUDE.md
-- prefers — rather than a repair, and it is satisfiable at a population of zero
-- violations, so it cannot punish its own success.
--
-- ══ WHAT IT PREVENTS ═══════════════════════════════════════════════════════
-- Without it, "every `allday_pack_pull` row we hold is priced" silently becomes
-- "the pack is worth this much" on a pack whose pull rows are **still landing** —
-- an understatement that reads exactly like a real value, on a P&L surface. The
-- Top Shot arm's identical guard was measured catching a live case on 2026-09-20
-- (`R_SHORT` in the pin: two priced acquisitions against `moments_pulled` 3, which
-- the all-or-nothing test alone passes).
--
-- ══ VERIFIED LIVE AFTER THE APPLY (2026-09-20 ~4:1x PM PT) ═════════════════
--   prosrc md5 `backfill_pack_rip_metadata`   10c43230629503ec4e846f4450c2d9c4 (12,242)
--   prosrc md5 `rollup_allday_rip_pull_value` 29bca401c90d8af10c5559bc9e9c42a1 (2,173)
--   Both ACLs unchanged: anon EXECUTE false, service_role EXECUTE true.
--   `proconfig` preserved on both (`search_path`; plus `statement_timeout=50s` on
--   the backfill — a CREATE OR REPLACE does not reset it, but a revert copied from
--   an older file WOULD lose it).
--   Smoke: `rollup_allday_rip_pull_value()` ran clean; `backfill_pack_rip_metadata(2000)`
--   returned `allday_resolved 199 · zero_repriced 226 · zero_cleared 74`, so the
--   All Day arm still prices normally — the new clause removed nothing, as measured.
--
-- REVERT: re-apply `rollup_allday_rip_pull_value` from
--   supabase/migrations/20260913032000_audit_20260912_pull_value_usd_is_current_fmv_for_every_collection.sql
--   and `backfill_pack_rip_metadata` from
--   supabase/migrations/20260920210651_audit_20260920_allday_repair_leg_gets_the_index_predicate_its_new_order_by_needs.sql.
-- ⚠ Revert BOTH or neither — a half revert is the divergence this closes.
-- ⛔ And 20260913032000 does NOT carry `SET statement_timeout = '50s'`, so a revert
--   that copies it verbatim silently drops the backfill's budget; re-apply
--   `ALTER FUNCTION public.backfill_pack_rip_metadata(integer) SET statement_timeout = '50s';`
--   after it. No data half — nothing was rewritten.
--
-- anon-exec: intentional — CREATE OR REPLACE keeps the ACL of backfill_pack_rip_metadata, verified live after this apply (anon false, service_role true); its only caller is /api/cron/backfill-pack-rip-metadata on the service role.
-- anon-exec: intentional — CREATE OR REPLACE keeps the ACL of rollup_allday_rip_pull_value, verified live after this apply (anon false, service_role true); its only caller is pg_cron jobid 72.

CREATE OR REPLACE FUNCTION public.rollup_allday_rip_pull_value()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  n int;
  w timestamptz;
  t_start timestamptz := clock_timestamp();
BEGIN
  SELECT last_run_at INTO w FROM allday_rip_rollup_state WHERE singleton;
  w := COALESCE(w, '-infinity'::timestamptz);

  WITH changed AS (
    SELECT DISTINCT pack_nft_id
    FROM allday_pack_pull
    WHERE updated_at >= w
  ),
  agg AS (
    SELECT p.pack_nft_id,
           sum(fc.fmv_usd)                                  AS total_fmv,
           count(*) FILTER (WHERE fc.fmv_usd IS NOT NULL)   AS valued_pulls,
           count(*)                                         AS total_pulls
    FROM allday_pack_pull p
    JOIN changed c ON c.pack_nft_id = p.pack_nft_id
    -- CURRENT fmv, same source and same shape as the Top Shot path.
    LEFT JOIN LATERAL (
      SELECT s.fmv_usd FROM public.fmv_snapshots s
      WHERE s.edition_id = p.edition_id
      ORDER BY s.computed_at DESC
      LIMIT 1
    ) fc ON true
    GROUP BY p.pack_nft_id
  )
  UPDATE pack_rips r
  SET pull_value_usd = round(agg.total_fmv,2), metadata_updated_at = now()
  FROM agg
  WHERE r.collection_id='dee28451-5d62-409e-a1ad-a83f763ac070'
    AND r.pack_nft_id = agg.pack_nft_id
    -- all-or-nothing per pack: a partly priced pack contributes nothing
    AND agg.valued_pulls = agg.total_pulls AND agg.total_fmv IS NOT NULL
    -- ⚠ WHOLE-PACK, added 2026-09-20 in the SAME migration as the sibling check in
    -- backfill_pack_rip_metadata's allday_pull_values CTE. These are the two
    -- writers of this one column; changing one alone makes them fight, which is
    -- how the 2026-09-12 basis change failed on its first attempt. Without it,
    -- "every pull row we hold is priced" silently becomes "the pack is worth this
    -- much" on a pack whose pull rows are still landing. Measured FREE: pull-row
    -- count = moments_pulled on 419,233 of 419,233 All Day rips holding any pull
    -- rows -- zero mismatches estate-wide, so it removes nothing today.
    AND agg.total_pulls = r.moments_pulled
    AND r.pull_value_usd IS DISTINCT FROM round(agg.total_fmv,2);
  GET DIAGNOSTICS n = ROW_COUNT;

  UPDATE allday_rip_rollup_state SET last_run_at = t_start WHERE singleton;

  RETURN n;
END
$function$;

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
