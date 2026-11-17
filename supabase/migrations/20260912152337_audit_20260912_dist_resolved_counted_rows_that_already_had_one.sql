-- audit_20260912: `dist_resolved` counted rows that ALREADY had a dist_id, so a drain that resolves nothing reports 97 %.
--
-- WHAT IT READ. `pipeline_runs.extra.dist_resolved` for `backfill-pack-rip-metadata`, three
-- consecutive runs on 2026-09-12: **484 / 500 · 484 / 500 · 488 / 500**. That looks like a lane
-- resolving 97 % of what it touches. ⭐ **The tell is that the three numbers barely move** — a drain
-- working through a backlog reports a number that changes as the backlog shrinks.
--
-- WHY IT LIES. The value came from
--     RETURNING pr.dist_id IS NOT NULL AS dist_resolved
-- on an UPDATE whose SET is `dist_id = COALESCE(bd.dist_id, pr.dist_id)`. **`RETURNING` yields the
-- NEW row**, and COALESCE preserves whatever was already there — so the flag is true for every row
-- that ENDS UP with a dist_id, including the ones that walked in with one. The function's own
-- candidate selection guarantees most of them did: the `stale_valued` arm (40 % of the batch) picks
-- rows that have already been processed once (`metadata_updated_at < now() - 7 days`), i.e. exactly
-- the rows most likely to be resolved already. **The field measures the batch's composition, not the
-- drain's progress.**
--
-- WHAT THE OUTCOME TABLE SAYS INSTEAD, which is the number nobody had: `pack_rips` is **97.7 %
-- resolved table-wide (3,602,255 of 3,685,387)** and the residual **83,132** splits **39,708**
-- structurally unreachable by this very function (they carry `metadata_updated_at` set with
-- `dist_id` AND `pull_value_usd` both NULL, so neither candidate arm can select them) · **43,415**
-- retryable through the stale arm · **9** still queued. ⛔ **And the 39,708 are NOT a missed
-- opportunity — sampled 200: every one reports `moments_pulled > 0` and ZERO have a single
-- `moment_acquisitions` row pointing at them, so the dist vote has no editions to count and 0 of 200
-- would resolve on a retry.** Excluding them is correct; reporting 97 % while they sit there is not.
-- Register #72 carries the full derivation.
--
-- THE CHANGE IS TO THE FIELD, NOT THE BEHAVIOUR. Not one row is selected, updated or skipped
-- differently. `processed` and `value_resolved` are untouched.
--
-- ⭐ **`dist_resolved` IS RETIRED RATHER THAN REDEFINED, and that is deliberate.** Silently changing
-- what a key MEANS leaves every historical value in `pipeline_runs.extra` comparable-looking and
-- wrong — this repo's "a rate POOLED ACROSS A FIX measures the fix's ABSENCE" trap, one level down.
-- **A key that disappears at a timestamp tells a reader the definition changed; a key that stays and
-- means something new does not.** Three honest fields replace it:
--     dist_newly_resolved  the row had NO dist_id and now has one   <- the drain's actual progress
--     dist_already_set     the row walked in with one               <- what the old field counted
--     dist_still_null      processed, and still has none            <- the state that was invisible
-- The three sum to `processed`, so a reader can check the instrument against itself.
--
-- ⚠ The before-value is available without a second read: `candidates` already carries
-- `pr.dist_id AS cur_dist` (it exists for `best_dist`'s ORDER BY), and `RETURNING` may reference the
-- UPDATE's FROM-list, so `c.cur_dist` is the pre-image in the same statement.
--
-- REVERT: re-apply the body from 20260830153041 (the `dist_resolved` form), and restore
--         `dist_resolved` in app/api/cron/backfill-pack-rip-metadata/route.ts's p_extra.

CREATE OR REPLACE FUNCTION public.backfill_pack_rip_metadata(p_limit integer DEFAULT 500)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_processed int := 0;
  v_newly_resolved int := 0;
  v_already_set int := 0;
  v_still_null int := 0;
  v_value_resolved int := 0;
  v_safe_limit int := LEAST(GREATEST(COALESCE(p_limit, 500), 1), 5000);
  v_stale_share int;
BEGIN
  v_stale_share := GREATEST(1, (v_safe_limit * 4) / 10);

  WITH stale_valued AS MATERIALIZED (
    SELECT pr.id, pr.pack_nft_id, pr.collection_id, pr.dist_id AS cur_dist
    FROM public.pack_rips pr
    WHERE pr.pull_value_usd IS NOT NULL
      AND pr.metadata_updated_at < now() - interval '7 days'
    ORDER BY pr.metadata_updated_at ASC
    LIMIT v_stale_share
  ),
  null_drain AS MATERIALIZED (
    SELECT pr.id, pr.pack_nft_id, pr.collection_id, pr.dist_id AS cur_dist
    FROM public.pack_rips pr
    WHERE pr.metadata_updated_at IS NULL
    ORDER BY pr.sealed_at DESC
    LIMIT (v_safe_limit - v_stale_share)
  ),
  candidates AS MATERIALIZED (
    SELECT * FROM stale_valued
    UNION ALL
    SELECT * FROM null_drain
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
    -- 2026-08-30: newest snapshot per moment's edition, looked up per row,
    -- instead of LEFT JOIN fmv_current (the DISTINCT ON view, a full pass
    -- over every snapshot per call). Same two steps as the view join.
    LEFT JOIN LATERAL (
      SELECT s.fmv_usd, s.collection_id
      FROM public.fmv_snapshots s
      WHERE s.edition_id = m.edition_id
      ORDER BY s.computed_at DESC
      LIMIT 1
    ) fc ON fc.collection_id = m.collection_id
    GROUP BY c.id
  ),
  upd AS (
    UPDATE public.pack_rips pr
    SET dist_id              = COALESCE(bd.dist_id, pr.dist_id),
        pull_value_usd       = pv.pull_value_usd,
        metadata_updated_at  = now()
    FROM candidates c
    LEFT JOIN best_dist bd  ON bd.rip_id = c.id
    LEFT JOIN pull_values pv ON pv.rip_id = c.id
    WHERE pr.id = c.id
    RETURNING pr.id,
              (pr.dist_id IS NOT NULL AND c.cur_dist IS NULL) AS dist_newly_resolved,
              (c.cur_dist IS NOT NULL)                        AS dist_already_set,
              (pr.dist_id IS NULL)                            AS dist_still_null,
              pr.pull_value_usd > 0                           AS value_resolved
  )
  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE dist_newly_resolved),
    COUNT(*) FILTER (WHERE dist_already_set),
    COUNT(*) FILTER (WHERE dist_still_null),
    COUNT(*) FILTER (WHERE value_resolved)
  INTO v_processed, v_newly_resolved, v_already_set, v_still_null, v_value_resolved
  FROM upd;

  RETURN jsonb_build_object(
    'processed', v_processed,
    'dist_newly_resolved', v_newly_resolved,
    'dist_already_set', v_already_set,
    'dist_still_null', v_still_null,
    'value_resolved', v_value_resolved,
    'finished_at', now()
  );
END;
$$;
-- anon-exec: intentional -- same signature as 20260830153041, ACLs preserved (backfill_pack_rip_metadata)
