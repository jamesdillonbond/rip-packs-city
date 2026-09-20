-- audit_20260920_pack_reality_staleness_adjudicates_its_counterfactual_instead_of_assuming_it
--
-- Register #118.
--
-- ⚠⚠ READ #118 BEFORE THIS FILE. A PRIOR SESSION HAD ALREADY DONE MOST OF THE
-- DIAGNOSIS AND I RE-DERIVED IT WITHOUT KNOWING, off an excerpt rather than the
-- whole item. Everything in this list was ALREADY in the register and is NOT a
-- finding of this migration:
--   · the sold-out hypothesis is refuted — all three dists are still listed;
--   · `pack_ask_state.last_checked_at` means "last CHANGED", not "last checked",
--     so it must never carry a freshness gate;
--   · the root cause is a LANE-COVERAGE GAP: the only lane that prices at the
--     live ask is `refresh_atlas_pack_ev`, which iterates
--     `pack_drop_pool WHERE pool_source = 'atlas'` and so structurally excludes
--     these three (`pool_source = 'gql'`);
--   · the 48h freshness gate must NOT be widened, and the historical backfill
--     lane must NOT be ordered (it prices at RETAIL: $24 against a $388 ask).
-- ⭐ Re-deriving it was not wasted — the register's own rule requires it — but the
-- credit is not mine and a reader of this file must not think these are new.
--
-- 🚨 AND ON ONE POINT THE REGISTER TOLD ME NOT TO DO WHAT I DID. #118 says, twice:
-- "⛔ do NOT add an availability predicate to the staleness view … availability is
-- now measured and these packs HAVE it, so that change would suppress a true
-- warning." This migration adds one. **The prohibition is right and the reason is
-- right**, so 20260920222056 — twenty minutes later — rebuilds the predicate to
-- FAIL OPEN, dropping a row only on POSITIVE evidence of delisting and never on
-- missing data. Read that file as part of this one.
--
-- ⚠ I ALSO REPEATED THAT SESSION'S OWN RECORDED MISTAKE. #118 says, of the
-- `last_checked_at` trap: *"THE ANSWER WAS ALREADY WRITTEN ON THE COLUMN — I DID
-- NOT RUN col_description()."* I reached the same conclusion by reading the
-- writer's WHERE clause, which took several queries, and I did not run
-- `col_description()` either. It returns the whole answer, including *"Do NOT hang
-- a staleness or freshness monitor on this column"*, in one query. **A rule this
-- repo has written down twice and now missed twice is a rule to run, not to admire.**
--
-- ══ WHAT IS GENUINELY NEW HERE, and it is one thing ════════════════════════
-- The board's third state says N packs "would otherwise qualify" — a
-- COUNTERFACTUAL asserting that freshness is the ONLY thing between them and
-- qualifying. Nothing tested it. The view counted rows passing the ranker's
-- filters on a snapshot that was, by the sentence's own admission, 23 days old.
--
-- Recomputing each candidate with `compute_pack_ev_per_edition_weighted` — the
-- SAME function `refresh_atlas_pack_ev` uses, at the SAME `slots` expression, at
-- the live ask:
--
--   dist  slots  listed now  stored pack_ev (Aug)  LIVE pack_ev   still qualifies
--   461     6        yes           +21.49            +19.47             YES
--   474     6        yes          +535.17           +529.24             YES
--   7812    1        yes            +7.73             -1.68             NO
--
-- **So the count is 2, not 3.** One row had gone negative since its snapshot and
-- was still being counted as a pack that would qualify — small today, in the
-- direction that flatters a buy, and drifting further every day the snapshot ages.
-- ⭐ The durable gain is not the -1: it is that the sentence is now CHECKED every
-- time it is shown, so the next divergence cannot accumulate silently.
--
-- ⚠ A CORRECTION TO MY OWN FIRST MEASUREMENT, kept because the error is the
-- instructive part. My first probe hardcoded `slots = 1` and read
-- -320.09 / -556.79 / -1.68 — "all three are negative, the banner is a lie". 461
-- and 474 are SIX-slot Premium Packs, so that understated them sixfold and
-- inverted the conclusion. CLAUDE.md names it exactly: *a probe whose HARNESS
-- differs from production in the ONE dimension the answer depends on is not a
-- measurement of production.* The table above is the production-shaped query, and
-- the honest finding is an overcount of one rather than a fabricated banner.
--
-- ══ THE CAP, AND WHY IT IS A COLUMN AND NOT A COMMENT ══════════════════════
-- Each adjudicated row costs one function call (measured 2,100 buffers / 9.2 ms),
-- so the recompute is capped at 60 candidates — ~20x the observed population of 3.
-- Past the cap the count is a LOWER BOUND, and **a partial count with no way to
-- tell that it is partial is the exact defect this panel exists to prevent**, so
-- `candidates_considered` and `candidates_adjudicated` ship WITH the number.
--
-- ══ COST ═══════════════════════════════════════════════════════════════════
-- The marginal cost is ~3 x 9 ms. ⚠ Worth knowing what it is marginal TO, because
-- it dwarfs the change: reading `pack_ev_latest` at all costs **16,162 buffers +
-- 4,230 temp and ~1.58 s**, dominated by a Seq Scan over 368,771
-- `pack_ev_history` rows and a **33 MB external merge sort** inside that view's
-- own `DISTINCT ON`. The public route pays that on every uncached request. Filed
-- separately; deliberately not touched here.
--
-- ⚠ `security_invoker = on` is RE-DECLARED below. `CREATE OR REPLACE VIEW` resets
-- reloptions, so omitting it would silently convert this to a definer-rights view.
-- Verified live after the apply: reloptions {security_invoker=on}, anon SELECT
-- false, authenticated false, service_role true, and the three original columns
-- unchanged in name, type and order.
--
-- REVERT: re-apply the view body from
-- supabase/migrations/20260902032401_audit_20260902_pack_reality_ranker_staleness_so_an_empty_board_stops_claiming_the_market_is_empty.sql
-- (verified 2026-09-20 to be the only other migration in the repo carrying a
-- `CREATE OR REPLACE VIEW public.v_topshot_pack_reality_ranker_staleness`).
-- ⭐ That file already carries `WITH (security_invoker = on)` at its line 49, so a
-- straight copy is safe — checked rather than assumed, because the reloption
-- resets on every CREATE OR REPLACE. The appended columns then disappear; the
-- route reads them with null-guards and the client treats absent as UNKNOWN rather
-- than as complete, so a revert degrades to the unhedged count instead of
-- erroring. No data half.
--
-- view-security-invoker: intentional — v_topshot_pack_reality_ranker_staleness is re-declared WITH (security_invoker = on) below, because CREATE OR REPLACE VIEW RESETS reloptions and dropping it would silently make this a definer-rights view.

CREATE OR REPLACE VIEW public.v_topshot_pack_reality_ranker_staleness
WITH (security_invoker = on) AS
WITH filtered AS (
  -- The ranker's own filters, byte-for-byte as the previous definition carried
  -- them, MINUS the 48h freshness one. `slots` is read from the SAME expression
  -- refresh_atlas_pack_ev uses, so this is the one authority rather than a
  -- second opinion.
  SELECT pev.dist_id,
         pev.pack_price,
         pev.snapshotted_at,
         GREATEST(COALESCE((pd.metadata ->> 'number_of_pack_slots')::int, 1), 1) AS slots
  FROM pack_ev_latest pev
    LEFT JOIN pack_distributions_v pdv
      ON pdv.collection_id = pev.collection_id AND pdv.dist_id = pev.dist_id
    LEFT JOIN pack_distributions pd
      ON pd.collection_id = pev.collection_id AND pd.dist_id = pev.dist_id
  WHERE pev.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
    AND pev.is_positive_ev = true
    AND COALESCE(pev.pack_price, 0::numeric) > 0::numeric
    AND COALESCE(pdv.is_reward_pack, false) = false
    AND pev.dist_id IS NOT NULL
    AND COALESCE(pev.depletion_pct::integer, 100) < 90
    AND COALESCE(pev.fmv_coverage_pct::integer, 0) >= 40
),
-- ⚠ THE CAP IS VISIBLE, NOT SILENT. Each adjudicated row costs one
-- compute_pack_ev_per_edition_weighted call (~2,100 buffers / 9 ms measured
-- 2026-09-20), so an unbounded LATERAL would be an anon-reachable cost. 60 is
-- ~20x the observed population of 3. `candidates_considered` vs
-- `candidates_adjudicated` is how a caller tells a complete verdict from a
-- truncated one -- a partial count with no way to know it is partial is the
-- defect this view exists to prevent, and it must not reappear in the fix.
capped AS (
  SELECT * FROM filtered ORDER BY snapshotted_at DESC LIMIT 60
),
adjudicated AS (
  SELECT c.dist_id,
         c.snapshotted_at,
         -- ⚠ A POSITIVE availability signal, which is what #118 asked for.
         -- `is_listed` is actively RETIRED by upsert_pack_ask_state's final arm
         -- when a dist leaves the live feed, and that feed returns 2,963-2,966
         -- dists on every one of ~270 ticks a day -- so `true` here means listed
         -- now, not merely listed once. ⛔ Do NOT gate on `last_checked_at`
         -- instead: that column only advances when the ask CHANGES (a WAL
         -- optimisation in the upsert's WHERE clause), so 1,869 of 1,988
         -- currently-listed packs look 48h+ stale while being verified every
         -- five minutes. Gating on it would fail 94% of a healthy population.
         (pas.is_listed IS TRUE AND pas.lowest_ask > 0::numeric) AS listed_now,
         ev.payload
  FROM capped c
    LEFT JOIN pack_ask_state pas
      ON pas.collection_slug = 'nba-top-shot' AND pas.dist_id = c.dist_id
    LEFT JOIN LATERAL (
      SELECT public.compute_pack_ev_per_edition_weighted(
               '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid,
               c.dist_id,
               COALESCE(NULLIF(pas.lowest_ask, 0::numeric), c.pack_price),
               c.slots) AS payload
    ) ev ON true
),
verdict AS (
  SELECT a.snapshotted_at,
         (a.listed_now
          AND (a.payload ->> 'ok')::boolean IS TRUE
          AND (a.payload ->> 'is_positive_ev')::boolean IS TRUE) AS still_qualifies
  FROM adjudicated a
)
SELECT
  count(*) FILTER (WHERE v.still_qualifies)::integer AS qualifying_ignoring_freshness,
  max(v.snapshotted_at) FILTER (WHERE v.still_qualifies) AS newest_qualifying_snapshot,
  count(*) FILTER (WHERE v.still_qualifies
                     AND v.snapshotted_at >= (now() - '48:00:00'::interval))::integer AS qualifying_and_fresh,
  (SELECT count(*) FROM filtered)::integer AS candidates_considered,
  count(*)::integer AS candidates_adjudicated
FROM verdict v;

COMMENT ON VIEW public.v_topshot_pack_reality_ranker_staleness IS
  'Why the /insights/pack-reality +EV ranker is empty. `qualifying_ignoring_freshness` is the count behind the board''s "N packs would otherwise qualify" sentence, and as of 2026-09-20 that counterfactual is ADJUDICATED rather than assumed: a pack counts only if it is listed RIGHT NOW (pack_ask_state.is_listed, which is actively retired) AND a live compute_pack_ev_per_edition_weighted call still says it is +EV. Before this, a row that had gone negative since its last snapshot was counted as "would qualify" -- measured on 2026-09-20: 3 counted, only 2 still qualified (dist 7812 had moved from +7.73 to -1.68). ⚠ candidates_considered > candidates_adjudicated means the LATERAL hit its 60-row cap and the count is a LOWER BOUND; read those two columns before quoting the first.';
