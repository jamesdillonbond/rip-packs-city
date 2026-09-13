-- backfill_pack_rip_metadata gains an ALL DAY pull-value source, and stops
-- overwriting a known value with NULL.
--
-- ⚠ CORRECTION TO THE AS-APPLIED COPY. The version applied via MCP under this
-- name said All Day had "~2 priced before this". That was WRONG and it was my
-- error: 2 is the count on ONE WALLET (0xbd94…50ac, 2 of its 385 All Day rips),
-- not the collection. The collection actually had **24,845** All Day rips valued
-- before this change. The mistake does not affect the function body -- only that
-- sentence -- and the real figure is used throughout this file. Recorded rather
-- than silently fixed, because "~2 -> 77,800" would have read as a 40,000x win
-- and the true number is a little over 3x.
--
-- ⭐ WHY: `pull_value_usd` was structurally a TOP-SHOT-ONLY feature and nothing
-- said so. The function prices a rip by joining `moment_acquisitions` ->
-- `moments`, and measured 2026-09-12:
--   * `moment_acquisitions.acquisition_method = 'pack_pull'` exists for Top Shot
--     ONLY -- 843,061 rows, 837,024 linked to a rip. All Day has 77,117
--     acquisition rows and ALL of them are 'marketplace'; Pinnacle, Golazos and
--     UFC likewise. Zero pack_pull rows outside Top Shot, ever.
--   * `moments` holds ZERO All Day rows, so even the join's second hop is empty.
-- So for four of five collections that join could never match. Product-wide
-- coverage sat at 312,202 of 3,685,525 (8.5%) and was NOT a backfill ramp.
--
-- ⭐ THE SOURCE THAT ALREADY EXISTED: `allday_pack_pull`, written at open by the
-- `ingest-allday-pack-opens` edge fn precisely so "realized pull-value can be
-- resolved later without re-fetching txs" (2026-06-29 schema comment). Measured:
-- 1,485,444 pull rows over 419,012 distinct packs, and every one of those packs
-- matches a `pack_rips` row on `pack_nft_id` -- an EXACT KEY JOIN, not the
-- +-5/30min time-window heuristic the Top Shot linkage had to use.
--   * 2026-Q1 onward: edition_id and fmv_usd resolved on 100% of pulls.
--   * 2025 and earlier: ~0-24% resolved. The historical edition backfill was
--     never run, `moments` cannot help (no All Day rows), and
--     `wallet_moments_cache` covers only 7.1% of unresolved pulls because it
--     holds only currently-HELD moments. Closing that tail needs a Flow re-fetch
--     and is NOT this change.
-- Immediately priceable: 77,800 All Day packs fully priced, $943,452.72 of
-- realized pull value, against 24,845 All Day rips valued before.
-- Every FUTURE All Day open is priced on arrival, which is the durable half.
--
-- ⚠ ALL-OR-NOTHING PER PACK, VIA `HAVING count(*) = count(ap.fmv_usd)`. A pack
-- whose pulls are only partly priced contributes NOTHING rather than a partial
-- sum. The partial sum is the worse failure: the pack says it pulled 8 moments,
-- we would price 3, and the result renders as a measured pack value with no
-- missing figure anywhere for a reader or a test to notice. 1,997 All Day packs
-- are in exactly that state and are deliberately skipped.
--
-- ⚠ NEW LEG `allday_repair`, and its predicate is what makes retrying SAFE.
-- The general drain re-selects on `metadata_updated_at IS NULL`, and this
-- function stamps that column on every candidate INCLUDING ones whose value came
-- back NULL -- so 363,336 rows are already stamped-but-unpriced and invisible to
-- both existing legs. ⛔ Do NOT add a blanket retry for those: sampled 2,000 and
-- ZERO had acquisition rows, so a blanket leg would spin on ~363k permanently
-- unpriceable rows and starve the real drain. This leg selects ONLY rips that
-- CAN be priced right now -- All Day, value still NULL, and every one of the
-- pack's pulls already carries an fmv_usd. A row it picks either gets a value
-- (and leaves the leg forever) or was never selected. Self-limiting by
-- construction, and it drains newest-first, which is also the order in which All
-- Day pulls are resolved, so it walks at the recoverable population rather than
-- through the unrecoverable 2024-25 tail.
-- Measured cost of that selection, cold: 1.9 s / 1,628 buffers for 50 rows.
-- Measured yield, 5 consecutive live runs: EXACTLY 50 net-new per run (the cap).
-- `allday_resolved` reads higher (135-217) because the stale leg re-prices All
-- Day rows through the new source too; that is a re-price, not a new value.
--
-- ⛔ A SAVED-WALLET PRIORITY LEG WAS MEASURED AND REJECTED -- do not re-propose
-- it without new numbers. Ordering the repair at real users first is attractive
-- (their Pack History is what anybody actually looks at), but the selection
-- measured **4.3 s and 23,226 buffers cold for 50 rows**: it walks 3,745
-- saved-wallet rips to find 602 with pulls. Worse, that cost is PERMANENT --
-- once the ~600 recoverable rows are valued the leg still pays the full scan
-- every run and returns nothing. On a function that already times out on 2 of 62
-- runs against a ~30 s wall, a permanent 4.3 s for a one-time 600-row benefit is
-- the wrong trade.
--
-- ⚠ `pull_value_usd` NO LONGER GETS CLOBBERED TO NULL. The UPDATE used to
-- `SET pull_value_usd = pv.pull_value_usd` unconditionally, so any candidate the
-- pricing CTE could not resolve had its EXISTING value erased -- and the stale
-- leg re-reads rows that already have a value, so a transient gap in
-- `moment_acquisitions` would silently destroy a good number. NULL is never a
-- legitimate new value here, so the write is COALESCE(allday, moments, existing).
--
-- anon-exec: backfill_pack_rip_metadata -- unchanged (CREATE OR REPLACE keeps
-- existing grants; service_role caller via /api/cron/backfill-pack-rip-metadata).
--
-- Exit (24 h): pipeline_runs `backfill-pack-rip-metadata`.extra carries
-- `allday_resolved` > 0 every run, All Day valued rips climb ~1,200/day from
-- 25,095 toward ~77,800 (~44 days), and run duration stays inside the ~30 s wall
-- (2 of 62 timed out BEFORE this change -- if that rate rises, cut
-- v_allday_share, which is the one tuning knob here).
-- Falsifier: allday_resolved stays 0 -> candidates are not reaching the new CTE
-- (check the collection_id literal) rather than the data being absent.
-- REVERT: re-apply the prior body from migration 20260830153041; it is this file
-- minus `allday_repair`, `allday_pull_values`, the DISTINCT ON in `candidates`,
-- the COALESCE in the UPDATE, and the `allday_resolved` accounting.

CREATE OR REPLACE FUNCTION public.backfill_pack_rip_metadata(p_limit integer DEFAULT 500)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_processed int := 0;
  v_newly_resolved int := 0;
  v_already_set int := 0;
  v_still_null int := 0;
  v_value_resolved int := 0;
  v_allday_resolved int := 0;
  v_safe_limit int := LEAST(GREATEST(COALESCE(p_limit, 500), 1), 5000);
  v_stale_share int;
  v_allday_share int;
  v_allday uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';
BEGIN
  v_stale_share  := GREATEST(1, (v_safe_limit * 4) / 10);
  v_allday_share := GREATEST(1, v_safe_limit / 10);

  WITH stale_valued AS MATERIALIZED (
    SELECT pr.id, pr.pack_nft_id, pr.collection_id, pr.dist_id AS cur_dist
    FROM public.pack_rips pr
    WHERE pr.pull_value_usd IS NOT NULL
      AND pr.metadata_updated_at < now() - interval '7 days'
    ORDER BY pr.metadata_updated_at ASC
    LIMIT v_stale_share
  ),
  -- Self-limiting: only rips that CAN be priced right now. See the header.
  allday_repair AS MATERIALIZED (
    SELECT pr.id, pr.pack_nft_id, pr.collection_id, pr.dist_id AS cur_dist
    FROM public.pack_rips pr
    WHERE pr.collection_id = v_allday
      AND pr.pull_value_usd IS NULL
      AND EXISTS (
        SELECT 1 FROM public.allday_pack_pull ap
        WHERE ap.pack_nft_id = pr.pack_nft_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.allday_pack_pull ap
        WHERE ap.pack_nft_id = pr.pack_nft_id AND ap.fmv_usd IS NULL
      )
    ORDER BY pr.sealed_at DESC
    LIMIT v_allday_share
  ),
  null_drain AS MATERIALIZED (
    SELECT pr.id, pr.pack_nft_id, pr.collection_id, pr.dist_id AS cur_dist
    FROM public.pack_rips pr
    WHERE pr.metadata_updated_at IS NULL
    ORDER BY pr.sealed_at DESC
    LIMIT (v_safe_limit - v_stale_share - v_allday_share)
  ),
  candidates AS MATERIALIZED (
    -- DISTINCT ON: allday_repair can overlap null_drain (an All Day rip that is
    -- both never-touched and now priceable). The UPDATE joins candidates by id,
    -- so a duplicate id would make Postgres raise on a double update of one row.
    SELECT DISTINCT ON (id) id, pack_nft_id, collection_id, cur_dist
    FROM (
      SELECT * FROM stale_valued
      UNION ALL
      SELECT * FROM allday_repair
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
  pull_values AS (
    SELECT c.id AS rip_id,
           COALESCE(SUM(fc.fmv_usd), 0)::numeric(14,2) AS pull_value_usd
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
    GROUP BY c.id
  ),
  -- All Day: exact join on pack_nft_id, and ALL-OR-NOTHING on fmv coverage.
  allday_pull_values AS (
    SELECT c.id AS rip_id,
           SUM(ap.fmv_usd)::numeric(14,2) AS pull_value_usd
    FROM candidates c
    JOIN public.allday_pack_pull ap ON ap.pack_nft_id = c.pack_nft_id
    WHERE c.collection_id = v_allday
    GROUP BY c.id
    HAVING count(*) = count(ap.fmv_usd)
  ),
  upd AS (
    UPDATE public.pack_rips pr
    SET dist_id              = COALESCE(bd.dist_id, pr.dist_id),
        -- never clobber a known value with NULL; see the header.
        pull_value_usd       = COALESCE(apv.pull_value_usd, pv.pull_value_usd, pr.pull_value_usd),
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
              (apv.pull_value_usd IS NOT NULL)                AS allday_resolved
  )
  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE dist_newly_resolved),
    COUNT(*) FILTER (WHERE dist_already_set),
    COUNT(*) FILTER (WHERE dist_still_null),
    COUNT(*) FILTER (WHERE value_resolved),
    COUNT(*) FILTER (WHERE allday_resolved)
  INTO v_processed, v_newly_resolved, v_already_set, v_still_null, v_value_resolved, v_allday_resolved
  FROM upd;

  RETURN jsonb_build_object(
    'processed', v_processed,
    'dist_newly_resolved', v_newly_resolved,
    'dist_already_set', v_already_set,
    'dist_still_null', v_still_null,
    'value_resolved', v_value_resolved,
    'allday_resolved', v_allday_resolved,
    'finished_at', now()
  );
END;
$function$;
