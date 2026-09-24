-- audit_20260924_pack_dist_vote_fills_never_overwrites_and_identity_relabel
--
-- WHAT WAS WRONG (found 2026-09-24 ~6:00 AM PT while reconciling pack sales):
-- backfill_pack_rip_metadata() infers a rip's dist by a pack_drop_pool
-- full-match vote and wrote `dist_id = COALESCE(bd.dist_id, pr.dist_id)` — the
-- INFERENCE overwrote a dist that came from Dapper's own index. A pack from a
-- NEW dist (no pool yet: 8776/8777/8778 in September) whose pulls all sit in an
-- OLD dist's pool was relabelled to the old dist (e.g. 5353, 8597, 8616). The
-- propagate trigger then copied the wrong dist into pack_purchases.
--   pack_rips disagreeing with pack_nft_identity: 6,274 (579 in the last 30 d,
--   2 % of rips with an identity); pack_purchases: 3,368. Every checked case was
--   a pack SOLD and RIPPED within seconds, identity/studio saying the new dist
--   and pack_rips the old one.
-- Blast radius: per-dist rip counts, rip P&L by dist, the EV backtest's
-- realized side, and per-dist pack sale stats.
--
-- FIX:
--   1. backfill_pack_rip_metadata: `COALESCE(pr.dist_id, bd.dist_id)` — the
--      vote FILLS a NULL, never overwrites (pin: supabase/tests/
--      backfill_pack_rip_metadata.sql property 8, planted-defect red).
--   2. (not shipped) making name_packs_from_identity CORRECT disagreements, not
--      only fill NULLs: measured 6.3 s / 612k buffers per 5-min tick against
--      41 ms for the NULL-only leg, so it stays NULL-only. With (1) the only
--      remaining source of a wrong dist is a vote filling a NULL before the
--      index answers; the watch below decides whether that needs a job.
--   3. One-off relabel of every disagreeing row to the identity dist, recorded
--      in audit_20260924_pack_dist_relabel for revert.
--
-- anon-exec: intentional — CREATE OR REPLACE of the existing signature keeps its live ACL (anon/authenticated EXECUTE false, checked 2026-09-24) (backfill_pack_rip_metadata)
--
-- REVERT:
--   UPDATE public.pack_rips r SET dist_id = a.old_dist FROM public.audit_20260924_pack_dist_relabel a
--    WHERE a.tbl = 'pack_rips' AND r.id = a.row_id;
--   UPDATE public.pack_purchases p SET pack_dist_id = a.old_dist FROM public.audit_20260924_pack_dist_relabel a
--    WHERE a.tbl = 'pack_purchases' AND p.id = a.row_id;
--   re-apply backfill_pack_rip_metadata from 20260920230950.
--
-- WATCH: rips sealed after this migration whose dist disagrees with
-- pack_nft_identity. Falsifier: > 0.5 % of identity-matched rips in a day.

-- 1. backfill_pack_rip_metadata: the vote fills, never overwrites (body = the pin's verbatim block).
-- Applied through MCP as an ASSERTED in-DB replace of the one SET line; the
-- resulting prosrc md5 (whitespace-normalised) c5cc24e333fe47dac599a6cd1aab41d1
-- equals this block's, checked 2026-09-24.
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

-- 2. One-off relabel to the identity dist, recorded for revert.
CREATE TABLE IF NOT EXISTS public.audit_20260924_pack_dist_relabel (
  tbl text NOT NULL, row_id uuid NOT NULL, collection_id uuid, pack_nft_id text,
  old_dist text, new_dist text, relabelled_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tbl, row_id)
);
REVOKE ALL ON public.audit_20260924_pack_dist_relabel FROM PUBLIC, anon, authenticated;
ALTER TABLE public.audit_20260924_pack_dist_relabel ENABLE ROW LEVEL SECURITY;

INSERT INTO public.audit_20260924_pack_dist_relabel (tbl, row_id, collection_id, pack_nft_id, old_dist, new_dist)
SELECT 'pack_rips', r.id, r.collection_id, r.pack_nft_id, r.dist_id, i.dist_id
  FROM public.pack_rips r
  JOIN public.pack_nft_identity i ON i.collection_id = r.collection_id AND i.pack_nft_id = r.pack_nft_id
 WHERE i.dist_id IS NOT NULL AND i.dist_id <> '0' AND r.dist_id IS DISTINCT FROM i.dist_id
ON CONFLICT DO NOTHING;

INSERT INTO public.audit_20260924_pack_dist_relabel (tbl, row_id, collection_id, pack_nft_id, old_dist, new_dist)
SELECT 'pack_purchases', p.id, p.collection_id, p.pack_nft_id, p.pack_dist_id, i.dist_id
  FROM public.pack_purchases p
  JOIN public.pack_nft_identity i ON i.collection_id = p.collection_id AND i.pack_nft_id = p.pack_nft_id
 WHERE i.dist_id IS NOT NULL AND i.dist_id <> '0' AND p.pack_dist_id IS DISTINCT FROM i.dist_id
ON CONFLICT DO NOTHING;

UPDATE public.pack_rips r SET dist_id = a.new_dist
  FROM public.audit_20260924_pack_dist_relabel a
 WHERE a.tbl = 'pack_rips' AND r.id = a.row_id;

UPDATE public.pack_purchases p SET pack_dist_id = a.new_dist
  FROM public.audit_20260924_pack_dist_relabel a
 WHERE a.tbl = 'pack_purchases' AND p.id = a.row_id;

-- Re-queue the pack market cache for every dist either side of a relabel.
UPDATE public.pack_market_sales_cache c SET computed_at = '1970-01-01'::timestamptz
 WHERE c.computed_at > '-infinity'::timestamptz
   AND EXISTS (SELECT 1 FROM public.audit_20260924_pack_dist_relabel a
                WHERE a.tbl = 'pack_purchases' AND a.collection_id = c.collection_id
                  AND c.dist_id IN (a.old_dist, a.new_dist));
