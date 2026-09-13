-- ⚠ NAME CARRIES A UTC DATE, NOT PT. Both this migration and its reverted
-- sibling were applied at ~02:0xZ on 2026-09-13 UTC, which is **19:0x PT on
-- 2026-09-12** -- and this repo dates everything Pacific. The `audit_20260913_`
-- prefix is baked into the APPLIED name, which migration parity matches on, so
-- renaming the file would orphan it. Recorded here rather than churned: the
-- ledger entry for this work is correctly dated 2026-09-12.
--
-- Restores the AT-OPEN All Day basis, reverting
-- audit_20260913_allday_pull_value_uses_current_fmv_not_at_open which I applied
-- ~20 minutes earlier the same night. Nothing was written on that basis (zero
-- runs of the function between the two migrations, verified before reverting),
-- so this is a clean revert with no data to repair.
--
-- ⭐ WHY I REVERTED MY OWN CORRECTION: a SECOND, PRE-EXISTING WRITER of
-- `pack_rips.pull_value_usd` for All Day that I had not found when I wrote
-- either migration. `rollup_allday_rip_pull_value()` sums
-- `allday_pack_pull.fmv_usd` per `pack_nft_id`, all-or-nothing
-- (`valued_pulls = total_pulls`), into the same column -- i.e. it already does
-- what my arm does, on the AT-OPEN basis. It is healthy and current (last ran
-- 01:14 that night; watermark in `allday_rip_rollup_state`).
-- Had the current-FMV version stayed, the two writers would have FOUGHT: the
-- rollup would overwrite a current-FMV value with an at-open one every time a
-- pull's `updated_at` moved, and the column would flip between two definitions
-- with nothing recording which one any given row held. **Two writers with two
-- definitions is strictly worse than one definition I disagree with.**
--
-- ⚠ SO WHY IS THIS ARM NOT REDUNDANT WITH THAT ROLLUP? Because the rollup is
-- INCREMENTAL on `allday_pack_pull.updated_at >= last_run_at`: it only revisits
-- packs whose pulls changed since its last tick, so every pack already fully
-- priced BEFORE its watermark was never swept -- a cold-start gap. Measured:
-- 77,800 All Day packs are fully priced in `allday_pack_pull` while only 25,195
-- All Day rips carry a value. **`allday_repair` is the missing cold-start sweep
-- for that rollup, not a second pricer.** That is a better description of this
-- work than the migration which introduced it gave.
--
-- ⚠⚠ THE REAL FINDING STAYS OPEN, DELIBERATELY UNRESOLVED HERE.
-- `pull_value_usd` means TWO DIFFERENT THINGS depending on the collection:
--     Top Shot ... the LATEST `fmv_snapshots` row per edition  (CURRENT value)
--     All Day .... `allday_pack_pull.fmv_usd`                  (value AT OPEN)
-- Measured on 500 resolved 2026-06+ pulls: at-open mean $8.97 vs current mean
-- $3.14, agreeing on 22 of 500. And `/dashboard/packs` SUMS BOTH into one
-- "RIPPED VALUE" tile and one NET P&L. That inconsistency PREDATES this session.
-- Both answers are correct for different consumers:
--   * realized-EV calibration wants AT-OPEN -- "what did this pack actually
--     yield when opened". Current FMV would make historical pack EV drift with
--     today's market, which is wrong for calibration.
--   * a user's Pack History NET P&L wants CURRENT -- "what are my pulls worth
--     now against what I paid".
-- One column cannot be both. Splitting it (`pull_value_usd_at_open` +
-- `pull_value_usd_current`) is the likely answer, and it is a product decision
-- with a migration behind it. Filed for Trevor; do not resolve it by fiat.
--
-- anon-exec: backfill_pack_rip_metadata -- unchanged, and MEASURED rather than
-- assumed. `CREATE OR REPLACE FUNCTION` does not reset a function ACL, so this
-- migration cannot have moved it, and a REVOKE here would be a change dressed as
-- a no-op. Read live 2026-09-12 (PT) after this migration was applied:
--   has_function_privilege(anon)          = false
--   has_function_privilege(authenticated) = false
--   has_function_privilege(service_role)  = true
-- The only caller is /api/cron/backfill-pack-rip-metadata on the service role.
-- ⚠ This line is the ONLY thing that was missing: its sibling 20260913014000
-- states the same decision at its line 82, this file dropped it, and the guard
-- `migration-new-function-states-its-anon-exec-decision` is keyed PER FUNCTION
-- NAME per FILE -- so a decision stated in one file cannot vouch for another,
-- by design. That is why main went red on a body byte-identical to a green one.
--
-- Body below is the at-open arm from 20260913014000, unchanged.

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
