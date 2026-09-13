-- ⭐ DECISION (Trevor delegated, 2026-09-12 PT): `pack_rips.pull_value_usd` is
-- **CURRENT fair-market value, for every collection**. Both writers now agree.
-- This closes register #92.
--
-- THE PROBLEM. The column meant two different things:
--     Top Shot ... latest `fmv_snapshots` per edition   -> CURRENT
--     All Day .... `allday_pack_pull.fmv_usd`           -> value AT OPEN
-- and `/dashboard/packs` summed both into one RIPPED VALUE tile and one NET P&L.
-- Measured on 500 resolved 2026-06+ pulls: at-open mean $8.97 vs current $3.14,
-- agreeing on 22 of 500.
--
-- ⭐ WHY CURRENT, AND WHY IT IS NOT A COIN-FLIP BETWEEN TWO DEFENSIBLE ANSWERS.
-- The "at-open is right for EV calibration" argument only ever described All Day.
-- **The entire Top Shot pack-reality / realized-EV estate ALREADY runs on current
-- FMV** -- `mv_topshot_pack_rip_values`, `mv_topshot_pack_realized_ev`,
-- `mv_topshot_pack_reality_{stats,dist}`, `v_topshot_pack_lifecycle{,_global}`
-- all read this column, and for Top Shot it has always been current. So All Day
-- was not a principled choice, it was an accident of having a different writer.
--   1. Top Shot is ~92% of valued rips -- current is already the house basis.
--   2. The 7-day `stale_valued` re-price loop exists ONLY to keep this column
--      current. Under an at-open basis that machinery is meaningless.
--   3. The user-facing consumer (Pack History NET P&L) wants "what are my pulls
--      worth NOW against what I paid". That is the question users actually ask.
--   4. It covers MORE: 76,376 pulls across 53,309 All Day packs carry an
--      `edition_id` with no stored `fmv_usd` -- unpriceable on the old basis,
--      priceable on this one (3,967 vs 3,780 whole packs per 4,000 measured).
--
-- ⚠ NOTHING IS LOST. The at-open number is still in `allday_pack_pull.fmv_usd`,
-- untouched, per pull. This changes which of the two the shared column carries.
--
-- ⚠ MEASURED IMPACT, over 4,000 already-valued All Day rips:
--     at-open $30,988.51 -> current $27,403.78  (-11.6%); rows LOSING a value: 0
-- Direction is cohort-dependent (over 4,000 *2026* packs current is HIGHER:
-- $70,214 vs $60,022), so this is a re-basing, not a haircut. All Day realized-EV
-- surfaces move accordingly and are now consistent with their Top Shot siblings.
-- `mv_allday_pack_realized` refreshes itself on pg_cron jobid 211 ('35 */6 * * *').
--
-- ⚠ THE ROLLUP'S INCREMENTAL TRIGGER IS NOW A "NEW PULLS" TRIGGER, NOT A "VALUE
-- CHANGED" ONE, AND THAT IS CORRECT. It keys on `allday_pack_pull.updated_at`;
-- under a current-FMV basis a pack's value also moves when the SNAPSHOT moves,
-- with no pull row changing. It does not need to catch that: the 7-day
-- `stale_valued` leg is the drift handler, which is the same division of labour
-- Top Shot has always used (rollup = new arrivals, stale leg = drift). Do NOT
-- "fix" the rollup to watch snapshots -- it would re-scan 1.48M pull rows a tick.
--
-- ⚠ EXISTING ROWS WERE RE-PRICED SEPARATELY, in sealed_at-bounded batches. An
-- id-ordered batch loop TIMES OUT -- no index supports `id > last` on this table,
-- and `idx_pack_rips_collection_time_pv` is (collection_id, sealed_at DESC)
-- INCLUDE (pull_value_usd), so sealed_at windows are the cheap axis. Verified
-- after: 25,340 computable All Day rips, **0 divergent**, sum $318,641.74 ->
-- $312,203.21. ⚠ 2 rips are not computable on the new basis and KEEP their old
-- value rather than being nulled -- never destroy a number you cannot recompute.
--
-- anon-exec: backfill_pack_rip_metadata, rollup_allday_rip_pull_value -- both
-- unchanged (CREATE OR REPLACE preserves grants; service_role callers).
-- REVERT: re-apply 20260913021000 for the backfill, and for the rollup restore
--   sum(p.fmv_usd) AS total_fmv,
--   count(*) FILTER (WHERE p.fmv_usd IS NOT NULL) AS valued_pulls
-- with no LATERAL join to fmv_snapshots. Then re-price by the same batching.
--
-- ⚠ BODIES BELOW ARE `pg_get_functiondef` OUTPUT READ BACK FROM PRODUCTION after
-- the MCP apply, not hand-transcribed -- so this file provably matches live.

-- ── 1. the hourly rollup (pg_cron jobid 72, '14 * * * *') ────────────────
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
    AND r.pull_value_usd IS DISTINCT FROM round(agg.total_fmv,2);
  GET DIAGNOSTICS n = ROW_COUNT;

  UPDATE allday_rip_rollup_state SET last_run_at = t_start WHERE singleton;

  RETURN n;
END
$function$;

-- ── 2. the backfill's All Day arm + its repair-leg predicate ─────────────
CREATE OR REPLACE FUNCTION` does not reset a function ACL, so this
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
        WHERE ap.pack_nft_id = pr.pack_nft_id AND ap.edition_id IS NULL
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
