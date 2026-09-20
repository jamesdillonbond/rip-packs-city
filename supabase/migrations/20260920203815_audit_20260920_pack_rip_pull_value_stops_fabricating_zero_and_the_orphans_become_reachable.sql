-- audit_20260920_pack_rip_pull_value_stops_fabricating_zero_and_the_orphans_become_reachable
--
--
-- ⚠ SUPERSEDED TWO MINUTES LATER by 20260920204056, which changes ONE line (the
-- All Day repair leg ORDER BY). The DB-invariant pin therefore names THAT file,
-- not this one. Kept as its own migration because the two are attributable in
-- opposite directions: this one is about what value gets WRITTEN, that one about
-- which rows get LOOKED AT.
--
-- ══ WHAT IS WRONG ═══════════════════════════════════════════════════════════
-- `pack_rips.pull_value_usd` has TWO writers and they mean different things.
--
--   rollup_allday_rip_pull_value()   All Day. ALL-OR-NOTHING: a rip's value is
--                                    written only when EVERY pull is priced.
--                                    Pinned since 2026-09-12 by
--                                    supabase/tests/rollup_allday_rip_pull_value.sql,
--                                    whose own words are "a rip with no pulls at
--                                    all is left NULL, NOT WRITTEN AS 0".
--   backfill_pack_rip_metadata()     everything else. Wrote
--                                    `COALESCE(SUM(fc.fmv_usd), 0)` -- so a pack
--                                    with NOTHING priced got **0**, and a pack
--                                    with SOME priced got the partial sum.
--
-- That All Day pin's header says the Top Shot path is "the same source and same
-- shape". ⛔ It was a MIRROR CLAIM WITH NO TEST, exactly the shape CLAUDE.md
-- names, and the two bodies had opposite behaviour on the case the pin exists for.
--
-- ⚠ AND IT DEFEATS A FIX ALREADY SHIPPED FOR THIS EXACT DEFECT.
-- 20260801204912_audit_20260801_pack_lifecycle_realized_value_never_fabricate_zero
-- made get_pack_lifecycle_row() return NULL when nothing is priced, and divide by
-- the count of rips that ACTUALLY carry a value. A fabricated 0 is not absent:
-- `count(pull_value_usd)` counts it and `sum()` adds it. So the consumer-layer fix
-- reads a fabricated zero as a real measurement and prints it. The writer
-- re-opened the hole the reader had closed.
--
-- ══ EVIDENCE (all measured live 2026-09-20 ~1:2x PM PT; dated samples) ══════
-- POPULATION
--   pack_rips.pull_value_usd = 0 ............ 82,864  (Top Shot; All Day 0)
--   pull_value_usd > 0 ...................... 209,482 Top Shot + 29,941 All Day
--   -> 28.4 % of every valued Top Shot rip is a zero.
--
-- IS ANY OF IT A REAL ZERO? Sampled 600 zero rows (`abs(hashtext(id)) % 100 = 7`,
-- never physical order). NOT ONE is a genuine zero:
--     no acquisition rows at all ................    0
--     acquisitions, NOT ONE priced ..............  148  (24.7 %) -> pure fabrication
--     acquisitions, PARTLY priced ...............   91  (15.2 %) -> understatement
--     fully priced, every fmv non-zero ..........  361  (60.1 %) -> stale 0, priceable NOW
--     every pull priced AND every fmv = 0.00 ....    0  <- the only honest zero
--
-- WHAT IT DOES TO USERS. mv_topshot_pack_rip_values selects
-- `WHERE pull_value_usd IS NOT NULL`, so every fabricated zero enters
-- mv_topshot_pack_realized_ev's realized_mean / median / p10 / p90 / winsorized,
-- and through `calibrated_ev` (realized weighted up to 0.85) the pack-EV ranking.
-- Of 295 Top Shot dists on that board with n_opens >= 10:
--     124 unaffected · 162 diluted · 9 entirely zero
--     median understatement among the diluted .... 1.162x
--     mean   understatement (skewed by the near-all-zero tail) .... 3.22x
--     dists whose realized_mean is exactly $0.00: 7738, 7185, 8431,
--       5270, 8612, 8753, 7730, 1765, 6150
-- Read straight off the surface's own RPC, which is the proof that the 08-01 fix
-- is defeated rather than merely bypassed:
--     SELECT to_jsonb(t) FROM get_pack_lifecycle_row('7738') t;
--       packs_opened 1213, moments_pulled 3639,
--       realized_pull_value_usd 63.42, avg_realized_value_per_pack 0.05
-- `$0.05` is what /nba-top-shot/pack/dist/7738 publishes as the average realized
-- value of a three-moment Top Shot pack. It is not a reading of the market.
--
-- ══ THE SECOND DEFECT, #93, AND WHY IT IS THE SAME COMMIT ══════════════════
-- Removing the fabrication is not enough on its own: a row the body cannot price
-- still gets `metadata_updated_at = now()`, and the old legs re-selected on
-- `metadata_updated_at IS NULL` (drain) and `pull_value_usd IS NOT NULL` (stale),
-- so a stamped-NULL row matched NEITHER, forever. Register #93, re-derived today
-- and WORSE than filed: 385,102 rows (filed 363,336) against 322,287 ever valued.
-- Clearing a zero to NULL would push it straight into that population, so the
-- clear and the reachability fix have to land together or the repair hides itself.
--
-- ⛔ #93 also names the WRONG fix and it is worth repeating: do NOT add a blanket
-- retry leg. 381,278 of those 385,102 rows have NO `moment_acquisitions` row at
-- all and are unpriceable by construction; a blanket leg would spin on them and
-- starve the drain. The `unpriced_retry` leg below is gated on
-- `EXISTS (moment_acquisitions)`, which is what bounds it: population **3,824**.
--
-- ══ WHAT THIS MIGRATION DOES ═══════════════════════════════════════════════
--  1. The generic (non-All-Day) pricing arm becomes ALL-OR-NOTHING and
--     WHOLE-PACK. `COALESCE(..., 0)` is gone. A value is written only when every
--     acquisition of the rip is priced AND the acquisition count equals
--     `moments_pulled`. Measured free: acquisitions = moments_pulled on 727/727
--     sampled valued Top Shot rips, and 478 of 497 sampled POSITIVE rows are
--     already fully priced (so ~3.6 % keep a legacy partial value -- see the
--     KNOWN RESIDUAL below).
--  2. New `zero_repair` leg: selects `pull_value_usd = 0` oldest-stamp-first. A
--     selected row is re-priced or cleared to NULL -- either way it leaves the
--     leg, so the 82,864 drain monotonically and the leg cannot spin.
--  3. New `unpriced_retry` leg: the #93 orphans, gated on
--     `EXISTS (moment_acquisitions)` and ordered oldest-stamp-first so it
--     round-robins rather than re-picking its own head.
--  4. ⚠ A ZERO IS CLEARED TO NULL; A POSITIVE VALUE IS PRESERVED when it cannot
--     be recomputed. `fmv_snapshots` is written DELETE-THEN-INSERT, so "not
--     priceable right now" can be a momentary absence rather than a fact -- a
--     rule that downgraded every uncomputable row could blank a large share of
--     the column on one unlucky tick. A stored 0 has no such defence: it was
--     never a measurement. This asymmetry is the one judgement call here.
--  5. Three new `extra` counters, each meaning rows WRITTEN, not rows looked at:
--     `zero_cleared`, `zero_repriced`, `value_newly_written`.
--  6. Column + function COMMENTs, so the contract lives beside the column
--     (`col_description` was NULL on both).
--
-- SHARES are re-cut WITHIN the existing p_limit, never added on top: stale 40 %
-- -> 20 %, new zero 15 %, new unpriced 5 %, All Day 10 % unchanged, drain stays
-- 50 %. The drain is the leg nothing here may slow: it is 2,983,356 rows deep.
--
-- ══ BUDGET: MEASURED ON THE BOX THAT IS RUNNING NOW ════════════════════════
-- ⚠ `pg_postmaster_start_time()` = 2026-09-20 10:39 AM PT -- the compute upgrade
-- to LARGE restarted Postgres, so ANY earlier timing is a different machine
-- (CLAUDE.md #126). Split on that change point, `backfill-pack-rip-metadata`:
--     before  45 runs, 16 ok (36 %), avg 28,745 ms, max 51,915 ms
--     after    3 runs,  3 ok (100 %), avg  4,959 ms, max  5,829 ms
-- ⭐ So metrics-latest.json's pending lever for this pipeline -- "remaining fails
-- are batch-size (route QUEUE)" -- is SPENT: the timeouts were the SMALL box, not
-- the batch. It is recorded here because acting on it would have cut throughput
-- to fix a problem the resize removed. n=3 is thin; re-derive before quoting.
-- The 5 s / 50 s headroom is also why a 5th leg is affordable at all.
--
-- ══ KNOWN RESIDUALS, stated rather than implied ════════════════════════════
--  · ~3.6 % of positive Top Shot rows carry a LEGACY PARTIAL SUM. They are
--    preserved by rule 4, so they keep an understated value until their pack
--    becomes fully priceable. New writes cannot create one.
--  · The All Day pair (both writers) has NO whole-pack check -- neither compares
--    its pull count to `moments_pulled`. Measured 1,436/1,436 equal, so it is
--    LATENT, not live; fixing it means changing BOTH writers together and
--    re-pinning, which is its own commit.
--  · 381,278 stamped-NULL rows stay unreachable ON PURPOSE (no acquisitions, so
--    nothing to price). That is #93's remaining half and it is an INGEST gap.
--
-- ══ REVERT ═════════════════════════════════════════════════════════════════
-- Re-apply the body from
-- supabase/migrations/20260913032000_audit_20260912_pull_value_usd_is_current_fmv_for_every_collection.sql
-- (then re-apply 20260920014006's `ALTER FUNCTION ... SET statement_timeout`,
-- which a CREATE OR REPLACE does NOT reset -- but the header above carries it, so
-- a revert that copies 20260913032000 verbatim LOSES the 50s budget; add it back).
-- ⛔ THE DATA HALF DOES NOT REVERT. Zeros cleared to NULL cannot be distinguished
-- afterwards from rows that were never priced; nothing recorded which they were.
-- That is acceptable because the zeros were never measurements -- but it means
-- the revert restores the BEHAVIOUR, not the column.
--
-- anon-exec: intentional — CREATE OR REPLACE keeps the ACL of backfill_pack_rip_metadata, so a revoke here would CHANGE production rather than preserve it; verified live before this apply (anon false, authenticated false, service_role true) and again after. Its only caller is /api/cron/backfill-pack-rip-metadata on the service role.

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
    ORDER BY pr.sealed_at DESC
    LIMIT v_allday_share
  ),
  -- The stamped-but-unvalued population (#93). It is reachable ONLY here: the
  -- drain re-selects on `metadata_updated_at IS NULL` and the stale leg on
  -- `pull_value_usd IS NOT NULL`, so a stamped NULL row matches neither.
  -- ⚠ ORDERED OLDEST-STAMP-FIRST, and that ordering is the whole safety
  -- argument: every selected row is restamped now(), so the leg round-robins
  -- its population instead of re-picking the same head forever.
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

COMMENT ON FUNCTION public.backfill_pack_rip_metadata(integer) IS
  'Resolves pack_rips.dist_id and pull_value_usd in bounded batches. Five legs, shares cut from p_limit: stale re-price 20%, zero_repair 15%, All Day cold-start 10%, unpriced_retry 5%, null drain the remainder. ALL-OR-NOTHING and WHOLE-PACK: a value is written only when every acquisition of the rip is priced AND the acquisition count equals moments_pulled. Never writes 0 for "nothing priced" (see migration audit_20260920_pack_rip_pull_value_stops_fabricating_zero and register #93).';

COMMENT ON COLUMN public.pack_rips.pull_value_usd IS
  'CURRENT fair-market value of everything the pack yielded: the sum of the LATEST fmv_snapshots row per pulled edition (register #92, 2026-09-12). ALL-OR-NOTHING -- NULL means "we cannot price every moment in this pack", never "the pack was worth nothing". 0 is NOT a valid value from either writer as of 2026-09-20; a 0 found here is residue of the pre-2026-09-20 backfill and the zero_repair leg is draining it. Two writers: backfill_pack_rip_metadata() (all collections but All Day) and rollup_allday_rip_pull_value() (All Day).';

COMMENT ON COLUMN public.pack_rips.metadata_updated_at IS
  'When backfill_pack_rip_metadata() (or rollup_allday_rip_pull_value()) last LOOKED AT this row -- NOT when a value was last obtained. A stamped row with pull_value_usd IS NULL was attempted and could not be priced; the unpriced_retry leg is what returns to it (register #93).';
