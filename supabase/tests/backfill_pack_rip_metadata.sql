-- DB invariant: public.backfill_pack_rip_metadata(integer) -- the hourly
-- /api/cron/backfill-pack-rip-metadata lane (cron-job.org, p_limit 500).
--
-- WHAT IT DOES. Resolves `pack_rips.dist_id` and `pack_rips.pull_value_usd` in
-- bounded batches over five legs whose shares are cut out of p_limit.
--
-- ⚠ WHY THIS FILE EXISTS. Its sibling pin,
-- supabase/tests/rollup_allday_rip_pull_value.sql, has asserted since 2026-09-12
-- that a partly-priced pack is left NULL and that "a rip with no pulls at all is
-- left NULL, NOT WRITTEN AS 0" -- and its header describes the Top Shot path as
-- "the same source and same shape". That was a MIRROR CLAIM WITH NO TEST. The
-- other writer of the SAME COLUMN read `COALESCE(SUM(fc.fmv_usd), 0)` and did the
-- opposite on exactly the case the sibling pin exists for: 82,864 Top Shot rows
-- (28.4 % of every valued Top Shot rip) carried a 0, and a sample of 600 found
-- NOT ONE genuine zero. Two writers, one column, opposite contracts, and the
-- estate had a test for one of them. Fixed and measured in
-- supabase/migrations/20260920203815_audit_20260920_pack_rip_pull_value_stops_fabricating_zero_and_the_orphans_become_reachable.sql.
--
-- ── THE SEVEN PROPERTIES ───────────────────────────────────────────────────
--
--   1. ⚠ ALL-OR-NOTHING. A rip with ANY unpriced acquisition is left NULL. Both
--      halves are asserted separately because they take different paths: NOTHING
--      priced (which used to write 0 -- the fabrication) and SOME priced (which
--      used to write a partial sum -- the understatement). The second is the one
--      that fails in the reassuring direction: a smaller number that reads
--      exactly like a real one.
--   2. ⚠ WHOLE-PACK. `count(*) = moments_pulled`. A rip whose acquisitions are
--      still landing is UNKNOWN, not cheap. Without this, "every acquisition we
--      have is priced" silently becomes "the pack is worth this much" on a
--      half-ingested rip. Measured free when added: acquisitions = moments_pulled
--      on 727 of 727 sampled valued Top Shot rips.
--   3. ⚠ A STORED 0 IS CLEARED TO NULL. This is what drains the 82,864. It is
--      asserted in both outcomes -- repriced when the pack can be priced now,
--      cleared when it cannot -- because a leg that only ever cleared would be
--      indistinguishable from one that works.
--   4. ⚠ A STORED POSITIVE VALUE IS PRESERVED when the row cannot be recomputed,
--      and this asymmetry against property 3 is the one deliberate judgement in
--      the function. `fmv_snapshots` is written DELETE-THEN-INSERT, so "not
--      priceable right now" can be a momentary absence rather than a fact; a rule
--      that downgraded every uncomputable row could blank a large share of the
--      column on one unlucky tick. A stored 0 has no such defence -- it was never
--      a measurement. ⛔ Do NOT "simplify" this to an unconditional overwrite:
--      the assertion below is what stands between one bad FMV window and a
--      blanked column.
--   5. ⚠ THE STAMPED-BUT-UNVALUED POPULATION IS REACHABLE (register #93). The
--      drain re-selects on `metadata_updated_at IS NULL` and the stale leg on
--      `pull_value_usd IS NOT NULL`, so a row that was looked at and could not be
--      priced matched NEITHER, forever -- 385,102 rows. The `unpriced_retry` leg
--      is the only thing that returns to them, and it is gated on
--      `EXISTS (moment_acquisitions)` so it cannot spin on the 381,278 that have
--      no acquisitions at all.
--   6. ⚠ EVERY REPAIR LEG ORDERS BY A COLUMN THE FUNCTION ITSELF WRITES
--      (`metadata_updated_at`), never by an immutable one. The All Day leg was
--      ordered `sealed_at DESC` and that is a REAL, MEASURED failure, not a
--      hypothetical: a row it selects and cannot price is selected again next
--      tick forever, so the unpriceable pile up permanently at the head and the
--      leg decays to zero throughput -- observed 10 of 10 slots wasted while
--      98.7 % of that leg's population was priceable. Fixed in
--      20260920204056. ⚠ The assertion below drives the function at a p_limit
--      small enough that the All Day share is ONE ROW, then checks WHICH row it
--      chose -- a re-pin to `sealed_at DESC` picks the other one and reds.
--      ⚠ THAT LEG ALSO CARRIES `metadata_updated_at IS NOT NULL`, and it is NOT
--      a narrowing: it is the predicate of the partial index
--      `idx_pack_rips_unvalued_stamped`, without which the new ORDER BY is a
--      parallel seq scan plus a 16 MB external merge (195,112 + 22,834 temp
--      buffers against 1,778; 36.4 s against 5.8 s at the production p_limit).
--      ⚠ A partial index is unusable unless the query REPEATS its predicate, so
--      dropping that clause as redundant silently restores the seq scan. This file
--      cannot see cost -- the production `duration_ms` is what caught it -- so the
--      clause is recorded here as load-bearing rather than asserted.
--   7. metadata_updated_at is stamped on every candidate the function touches,
--      INCLUDING one it could not price. That is deliberate and property 5 is
--      what makes it safe: the stamp means "looked at", not "valued", and the
--      column comment says so.
--
-- ⚠ NOT ASSERTED HERE, and named rather than left implied:
--   · The dist_id vote (`pack_drop_pool` full-match) is exercised only far enough
--     to prove it does not interfere; it has no dedicated arm. A separate pin
--     covers attribute_topshot_rips_empirical.
--   · The All Day arm has NO whole-pack check (property 2 is generic-arm only) --
--     neither this writer nor rollup_allday_rip_pull_value compares its pull count
--     to moments_pulled. Measured 1,436/1,436 equal on 2026-09-20, so it is LATENT.
--     Closing it means changing BOTH writers together, which is its own commit.
--   · Leg SHARES (20/15/10/5/remainder) are not pinned as numbers. Property 6's
--     assertion depends on the All Day share being 1 at p_limit 10; if the shares
--     are re-cut, that assertion breaks loudly rather than silently, which is the
--     behaviour wanted.
--
-- ── PROVEN WITH PLANTED DEFECTS, 2026-09-20, not by reading it ─────────────
-- Nine mutations against a local throwaway Postgres (the CI recipe). Eight red;
-- the ninth is listed too, because a mutation matrix that only shows its wins is
-- the same shape as a guard that only reports success. Each line is the FIRST
-- assertion that reddened:
--   the exact PRE-FIX body (COALESCE(..,0), no HAVING) .. got [0.00] want [NULL]  (prop 1a)
--   drop only the all-or-nothing arm of HAVING .......... got [30.00] want [NULL] (prop 1b)
--   drop the whole-pack arm of HAVING .................. got [30.00] want [NULL] (prop 2)
--   never clear a stored zero .......................... got [0] want [NULL]      (prop 3)
--   make the value overwrite unconditional ............. got [NULL] want [42.00]  (prop 4)
--   remove the unpriced_retry leg from the UNION ....... got [NULL] want [35.51]  (prop 5)
--   revert the All Day ORDER BY to `sealed_at DESC` .... got [NULL] want [30.00]  (prop 6)
--   remove the GREATEST(0, ...) drain clamp ............ LIMIT must not be negative
--
-- ⛔ NOT CAUGHT, and it is the one a reader should worry about: dropping
-- `metadata_updated_at IS NOT NULL` from the All Day leg. Every assertion still
-- passes because the clause changes only which INDEX the planner can use -- and a
-- rolled-back fixture table of two rows has no plan worth measuring. The real
-- consequence is 195,112 buffers instead of 1,778 and a 36.4 s tick against a 50 s
-- budget, which only the production `duration_ms` can see. ⚠ Do not "fix" this by
-- asserting a plan shape here: the fixture has none. The guard for it is the lane's
-- own duration, and the reason it is written down is so the next reader knows this
-- file is silent about it rather than assuming it is covered.
--
-- ⭐ ONE MUTATION IS A NO-OP AND IT IS WORTH KNOWING WHICH. Restoring
-- `COALESCE(SUM(fc.fmv_usd), 0)` while LEAVING the HAVING in place changes
-- nothing -- exit 0 -- because the HAVING already excludes every row the
-- COALESCE could fire on. So the load-bearing half of the fix is the HAVING, not
-- the removal of the COALESCE, and a reviewer reading only the diff would get
-- that backwards. Recorded so nobody "proves" this file with the wrong mutation
-- and concludes it is vacuous.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260920210651_audit_20260920_allday_repair_leg_gets_the_index_predicate_its_new_order_by_needs.sql),
-- itself byte-identical to production: prosrc md5 db0798a87fad8de84215f839ebe013f7,
-- length 11557, read back after the apply on 2026-09-20.
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.pack_rips (
  id                  uuid PRIMARY KEY,
  collection_id       uuid,
  pack_nft_id         text,
  dist_id             text,
  pull_value_usd      numeric,
  moments_pulled      integer,
  sealed_at           timestamptz,
  metadata_updated_at timestamptz
);

CREATE TABLE public.moment_acquisitions (
  source_pack_rip_id uuid,
  nft_id             text
);

CREATE TABLE public.moments (
  nft_id        text,
  collection_id uuid,
  edition_id    uuid
);

CREATE TABLE public.fmv_snapshots (
  edition_id    uuid,
  collection_id uuid,
  fmv_usd       numeric,
  computed_at   timestamptz
);

CREATE TABLE public.allday_pack_pull (
  pack_nft_id text,
  edition_id  uuid,
  fmv_usd     numeric,
  updated_at  timestamptz
);

CREATE TABLE public.pack_drop_pool (
  collection_id uuid,
  edition_id    uuid,
  dist_id       text
);

-- >>> BEGIN verbatim backfill_pack_rip_metadata (byte-identical to the migration/prod) >>>
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
-- <<< END verbatim backfill_pack_rip_metadata <<<

\set TS '''95f28a17-224a-4025-96ad-adf8a4c63bfd'''
\set AD '''dee28451-5d62-409e-a1ad-a83f763ac070'''

\set E1  '''11111111-1111-1111-1111-111111111111'''
\set E2  '''22222222-2222-2222-2222-222222222222'''
\set E3  '''33333333-3333-3333-3333-333333333333'''
\set ENO '''44444444-4444-4444-4444-444444444444'''
\set ELT '''66666666-6666-6666-6666-666666666666'''

\set R_FULL    '''aaaaaaa1-0000-0000-0000-000000000001'''
\set R_NONE    '''aaaaaaa1-0000-0000-0000-000000000002'''
\set R_PARTIAL '''aaaaaaa1-0000-0000-0000-000000000003'''
\set R_SHORT   '''aaaaaaa1-0000-0000-0000-000000000004'''
\set R_ZEROFIX '''aaaaaaa1-0000-0000-0000-000000000005'''
\set R_ZEROBAD '''aaaaaaa1-0000-0000-0000-000000000006'''
\set R_KEEPPOS '''aaaaaaa1-0000-0000-0000-000000000007'''
\set R_ORPHAN  '''aaaaaaa1-0000-0000-0000-000000000008'''

-- ⚠ EVERY at-open allday_pack_pull.fmv_usd here is 1000.00 -- a value no
-- assertion expects -- for the same reason the sibling pin does it: a body that
-- reverts to the at-open basis fails loudly instead of quietly agreeing.
--
-- E1 10.00 · E2 20.00 · E3 5.505 · ELT stale 99.00 then live 7.00 · ENO: no row.
-- ⚠ ELT's two rows go in stale-FIRST so a body dropping `ORDER BY computed_at
-- DESC` reads 99.00 off the heap and fails. Do not reorder them.
INSERT INTO public.fmv_snapshots (edition_id, collection_id, fmv_usd, computed_at) VALUES
  (:E1::uuid,  :TS::uuid, 10.00,  '2026-06-02T00:00:00Z'),
  (:E2::uuid,  :TS::uuid, 20.00,  '2026-06-02T00:00:00Z'),
  (:E3::uuid,  :TS::uuid,  5.505, '2026-06-02T00:00:00Z'),
  (:ELT::uuid, :TS::uuid, 99.00,  '2026-06-01T00:00:00Z'),
  (:ELT::uuid, :TS::uuid,  7.00,  '2026-06-05T00:00:00Z');

INSERT INTO public.moments (nft_id, collection_id, edition_id) VALUES
  ('m1', :TS::uuid, :E1::uuid),
  ('m2', :TS::uuid, :E2::uuid),
  ('m3', :TS::uuid, :E3::uuid),
  ('mno', :TS::uuid, :ENO::uuid),
  ('mlt', :TS::uuid, :ELT::uuid);

-- Every rip below is STAMPED long ago, so the stale / zero / unpriced legs can
-- see them and the null drain cannot -- the legs under test are addressed
-- individually rather than all at once.
INSERT INTO public.pack_rips
  (id, collection_id, pack_nft_id, dist_id, pull_value_usd, moments_pulled, sealed_at, metadata_updated_at) VALUES
  -- fully priced + whole                          -> 35.51
  (:R_FULL::uuid,    :TS::uuid, 'P-FULL',    NULL, NULL,  3, '2026-06-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  -- acquisitions, NOT ONE priced                  -> NULL  (used to be 0)
  (:R_NONE::uuid,    :TS::uuid, 'P-NONE',    NULL, NULL,  1, '2026-06-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  -- acquisitions, SOME priced                     -> NULL  (used to be 30.00)
  (:R_PARTIAL::uuid, :TS::uuid, 'P-PARTIAL', NULL, NULL,  3, '2026-06-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  -- 2 priced acquisitions but moments_pulled = 3  -> NULL  (whole-pack)
  (:R_SHORT::uuid,   :TS::uuid, 'P-SHORT',   NULL, NULL,  3, '2026-06-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  -- stored 0, priceable now                       -> 7.00  (zero_repriced)
  (:R_ZEROFIX::uuid, :TS::uuid, 'P-ZEROFIX', NULL, 0,     1, '2026-06-01T00:00:00Z', '2026-01-02T00:00:00Z'),
  -- stored 0, NOT priceable                       -> NULL  (zero_cleared)
  (:R_ZEROBAD::uuid, :TS::uuid, 'P-ZEROBAD', NULL, 0,     1, '2026-06-01T00:00:00Z', '2026-01-03T00:00:00Z'),
  -- stored POSITIVE, not recomputable             -> 42.00 PRESERVED
  (:R_KEEPPOS::uuid, :TS::uuid, 'P-KEEPPOS', NULL, 42.00, 1, '2026-06-01T00:00:00Z', '2026-01-04T00:00:00Z'),
  -- stamped + NULL + has acquisitions             -> 10.00 (unpriced_retry, #93)
  (:R_ORPHAN::uuid,  :TS::uuid, 'P-ORPHAN',  NULL, NULL,  1, '2026-06-01T00:00:00Z', '2026-01-05T00:00:00Z');

INSERT INTO public.moment_acquisitions (source_pack_rip_id, nft_id) VALUES
  (:R_FULL::uuid,    'm1'),
  (:R_FULL::uuid,    'm2'),
  (:R_FULL::uuid,    'm3'),
  (:R_NONE::uuid,    'mno'),
  (:R_PARTIAL::uuid, 'm1'),
  (:R_PARTIAL::uuid, 'm2'),
  (:R_PARTIAL::uuid, 'mno'),
  (:R_SHORT::uuid,   'm1'),
  (:R_SHORT::uuid,   'm2'),
  (:R_ZEROFIX::uuid, 'mlt'),
  (:R_ZEROBAD::uuid, 'mno'),
  (:R_KEEPPOS::uuid, 'mno'),
  (:R_ORPHAN::uuid,  'm1');

-- p_limit 5000 puts every leg's share far above the fixture count, so all eight
-- rows are candidates in one call and each assertion is about the WRITE RULE.
SELECT public.backfill_pack_rip_metadata(5000);

-- ── Property 1a: THE FABRICATION. This is the assertion the file exists for.
-- `COALESCE(SUM(fc.fmv_usd), 0)` wrote 0 here, and 0 is a number every consumer
-- reads as a measurement: get_pack_lifecycle_row counts it, sum() adds it, and
-- mv_topshot_pack_rip_values selects it precisely because it IS NOT NULL.
SELECT _assert_eq(
  (SELECT coalesce(pull_value_usd::text, 'NULL') FROM public.pack_rips WHERE id = :R_NONE::uuid),
  'NULL',
  'a rip whose acquisitions are ALL unpriced is left NULL, never written as 0'
);

-- ── Property 1b: the understatement, which fails in the reassuring direction.
-- 30.00 (E1 + E2, skipping the unpriced one) reads exactly like a real value and
-- makes a good pull look like a bad pack.
SELECT _assert_eq(
  (SELECT coalesce(pull_value_usd::text, 'NULL') FROM public.pack_rips WHERE id = :R_PARTIAL::uuid),
  'NULL',
  'a rip with ANY unpriced acquisition is left NULL -- a partial sum would understate it and look real'
);

SELECT _assert_eq(
  (SELECT pull_value_usd::text FROM public.pack_rips WHERE id = :R_FULL::uuid),
  '35.51',
  'a fully-priced whole pack gets the ROUNDED sum of its acquisitions CURRENT fmvs'
);

-- ── Property 2: WHOLE-PACK. Both acquisitions ARE priced (10 + 20), so the
-- all-or-nothing test alone passes and 30.00 would be written for a pack that
-- yielded THREE moments. Only the moments_pulled comparison catches it.
SELECT _assert_eq(
  (SELECT coalesce(pull_value_usd::text, 'NULL') FROM public.pack_rips WHERE id = :R_SHORT::uuid),
  'NULL',
  'a rip with fewer acquisitions than moments_pulled is UNKNOWN, not cheap -- even with every acquisition priced'
);

-- ── Property 3: the 82,864 drain, asserted in BOTH outcomes.
SELECT _assert_eq(
  (SELECT pull_value_usd::text FROM public.pack_rips WHERE id = :R_ZEROFIX::uuid),
  '7.00',
  'a stored 0 that CAN be priced now is repriced -- and from the LATEST snapshot (7.00), not the stale 99.00'
);
SELECT _assert_eq(
  (SELECT coalesce(pull_value_usd::text, 'NULL') FROM public.pack_rips WHERE id = :R_ZEROBAD::uuid),
  'NULL',
  'a stored 0 that cannot be priced is CLEARED to NULL -- it was never a measurement'
);

-- ── Property 4: the deliberate asymmetry. P-KEEPPOS is unpriceable by exactly
-- the same test P-ZEROBAD fails, and keeps its value. ⛔ If this ever reads NULL,
-- the overwrite has been made unconditional and ONE bad fmv_snapshots window
-- (they are written delete-then-insert) can blank the column estate-wide.
SELECT _assert_eq(
  (SELECT pull_value_usd::text FROM public.pack_rips WHERE id = :R_KEEPPOS::uuid),
  '42.00',
  'a stored POSITIVE value is PRESERVED when the row cannot be recomputed -- only a 0 is cleared'
);

-- ── Property 5: register #93. P-ORPHAN is stamped AND NULL, so the drain leg
-- (metadata_updated_at IS NULL) and the stale leg (pull_value_usd IS NOT NULL)
-- both skip it. Before the unpriced_retry leg existed, 385,102 rows sat here
-- permanently unreachable.
SELECT _assert_eq(
  (SELECT pull_value_usd::text FROM public.pack_rips WHERE id = :R_ORPHAN::uuid),
  '10.00',
  'a stamped row with a NULL value and priceable acquisitions IS reached and valued (register #93)'
);

-- ── Property 7: the stamp means LOOKED AT, not VALUED. Every candidate is
-- restamped, including the ones left NULL -- which is only safe because of
-- property 5, and is why the column comment says so.
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.pack_rips
    WHERE metadata_updated_at > '2026-02-01T00:00:00Z' AND pull_value_usd IS NULL),
  '4',
  'a candidate the function could not price is still restamped -- the stamp means looked at, not valued'
);

-- ── Property 6: THE ORDER BY, and it needs its own scenario ────────────────
-- Two All Day rips, both fully priceable is not the test; the test is that the
-- leg reaches the one it can price. NEWER sealed_at + NEWER stamp on the
-- unpriceable one is exactly the residue shape that decayed the live leg:
-- `sealed_at DESC` picks P-AD-STUCK every tick forever, `metadata_updated_at ASC`
-- picks P-AD-OLD. The All Day share at p_limit 10 is GREATEST(1, 10/10) = 1, so
-- the leg gets exactly ONE slot and the choice is forced.
DELETE FROM public.pack_rips;
DELETE FROM public.moment_acquisitions;

INSERT INTO public.pack_rips
  (id, collection_id, pack_nft_id, dist_id, pull_value_usd, moments_pulled, sealed_at, metadata_updated_at) VALUES
  ('bbbbbbb1-0000-0000-0000-000000000001'::uuid, :AD::uuid, 'P-AD-STUCK', NULL, NULL, 2, '2026-09-01T00:00:00Z', '2026-08-01T00:00:00Z'),
  ('bbbbbbb1-0000-0000-0000-000000000002'::uuid, :AD::uuid, 'P-AD-OLD',   NULL, NULL, 2, '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z');

-- P-AD-STUCK: one of its two pulls has no snapshot -> can never be written.
-- P-AD-OLD:   both priced -> 30.00 the moment the leg reaches it.
INSERT INTO public.allday_pack_pull (pack_nft_id, edition_id, fmv_usd, updated_at) VALUES
  ('P-AD-STUCK', :E1::uuid,  1000.00, '2026-06-01T00:00:00Z'),
  ('P-AD-STUCK', :ENO::uuid, 1000.00, '2026-06-01T00:00:00Z'),
  ('P-AD-OLD',   :E1::uuid,  1000.00, '2026-06-01T00:00:00Z'),
  ('P-AD-OLD',   :E2::uuid,  1000.00, '2026-06-01T00:00:00Z');

SELECT public.backfill_pack_rip_metadata(10);

SELECT _assert_eq(
  (SELECT pull_value_usd::text FROM public.pack_rips WHERE pack_nft_id = 'P-AD-OLD'),
  '30.00',
  'the All Day repair leg is ordered by the stamp it WRITES, so its one slot reaches a priceable row'
);

-- The other half of the same claim, and the one that makes it not vacuous: under
-- `sealed_at DESC` this row IS the single candidate and P-AD-OLD stays NULL.
SELECT _assert_eq(
  (SELECT coalesce(pull_value_usd::text, 'NULL') FROM public.pack_rips WHERE pack_nft_id = 'P-AD-STUCK'),
  'NULL',
  'and the permanently-unpriceable row is still left NULL rather than guessed at'
);

-- ⚠ AND IT MUST NOT HAVE SPENT ITS SLOT ON THE STUCK ROW AT ALL. The stamp is
-- the tell: a leg that selected P-AD-STUCK restamps it. Asserted as the ABSENCE
-- of that restamp, because asserting only P-AD-OLD's value passes on a body that
-- was simply given more than one slot.
SELECT _assert_eq(
  (SELECT metadata_updated_at::text FROM public.pack_rips WHERE pack_nft_id = 'P-AD-STUCK'),
  '2026-08-01 00:00:00+00',
  'the leg did not even LOOK at the newer unpriceable row -- its one slot went to the older stamp'
);

-- ── The negative-LIMIT guard (20260920204628). Every other share has a
-- GREATEST(1, ...) floor, so at p_limit 1 the null_drain remainder is -3 and
-- `LIMIT -3` RAISES 22023. Nothing in production passes 1; this pin does.
SELECT _assert_eq(
  (public.backfill_pack_rip_metadata(1) IS NOT NULL)::text,
  'true',
  'p_limit 1 does not raise 22023 -- the drain remainder is clamped at 0, not negative'
);

ROLLBACK;
