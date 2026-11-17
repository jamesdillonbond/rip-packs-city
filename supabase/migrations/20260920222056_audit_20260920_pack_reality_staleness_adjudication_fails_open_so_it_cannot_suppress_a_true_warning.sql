-- audit_20260920_pack_reality_staleness_adjudication_fails_open_so_it_cannot_suppress_a_true_warning
--
-- Corrects 20260920220641, applied twenty minutes earlier in the same session.
--
-- ══ WHY ════════════════════════════════════════════════════════════════════
-- That migration added an availability predicate to this view. Register #118 says,
-- twice and in bold: **"⛔ do NOT add an availability predicate to the staleness
-- view … availability is now measured and these packs HAVE it, so that change
-- would suppress a true warning."** I had read an excerpt of #118, not the item,
-- and shipped the thing it forbids.
--
-- ⭐ THE PROHIBITION IS RIGHT, AND THE REASON IS THE IMPORTANT PART. This count
-- reaching 0 flips the board's copy to **"No +EV packs right now."** — a claim
-- about the MARKET. So any predicate that can drop a row on MISSING data hands our
-- own read failure a route to publishing that claim, which is precisely the defect
-- the four-state panel was built to prevent. The first version dropped a candidate
-- whenever `pack_ask_state` had no row for it, or `is_listed` was NULL.
--
-- ══ WHAT CHANGES: THE ASYMMETRY ════════════════════════════════════════════
-- A candidate is now dropped ONLY on positive evidence, on both axes:
--
--                             drop?   why
--   is_listed = false          YES    upsert_pack_ask_state actively sets this when
--                                     a dist leaves the live feed, so it is a fact
--   is_listed = true            no
--   no pack_ask_state row       no    we do not know — keep the warning
--   recompute ok, not +EV      YES    a measurement
--   recompute ok, +EV           no
--   recompute failed            no    we do not know — keep the warning
--
-- ⭐ So the predicate still does the job #118 feared was missing (a genuinely
-- delisted pack stops being counted as buyable) WITHOUT the failure mode #118
-- forbade (an absence suppressing a true warning). Both halves, not a compromise
-- between them.
--
-- ══ AND THE REMOVALS ARE NOW AUDITABLE ═════════════════════════════════════
-- Two more appended columns, `dropped_delisted` and `dropped_no_longer_positive_ev`.
-- Without them "2" is a number; with them it is a measurement someone can check.
-- ⚠ They are deliberately NOT plumbed into the public route: the client's decision
-- needs only the count and whether the verdict was complete, and widening a public
-- payload for an operator's diagnostic is not a trade worth making. Read them from
-- the view.
--
-- ══ VERIFIED LIVE AFTER THE APPLY (2026-09-20 ~3:2x PM PT) ═════════════════
--   qualifying_ignoring_freshness 2 · candidates_considered 3 ·
--   candidates_adjudicated 3 · dropped_delisted 0 ·
--   dropped_no_longer_positive_ev 1   (dist 7812, +7.73 -> -1.68 since August)
--   reloptions {security_invoker=on} · anon SELECT false · authenticated false ·
--   service_role true · the five pre-existing columns unchanged in name, type and
--   order, the two new ones appended.
-- ⭐ Same answer as the fail-closed version on today's data, which is exactly why
-- the difference would never have shown up in a test of the OUTPUT — it is a
-- difference in what happens when an INPUT goes missing, and that is the case the
-- board has to survive.
--
-- REVERT: re-apply 20260920220641's body (the fail-closed predicate). ⛔ Do not,
-- unless you also accept that a missing `pack_ask_state` row can make the board
-- claim the market is empty. Carry `WITH (security_invoker = on)` either way.
-- No data half.
--
-- view-security-invoker: intentional — v_topshot_pack_reality_ranker_staleness is re-declared WITH (security_invoker = on) below, because CREATE OR REPLACE VIEW RESETS reloptions and dropping it would silently make this a definer-rights view.

CREATE OR REPLACE VIEW public.v_topshot_pack_reality_ranker_staleness
WITH (security_invoker = on) AS
WITH filtered AS (
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
capped AS (
  SELECT * FROM filtered ORDER BY snapshotted_at DESC LIMIT 60
),
adjudicated AS (
  SELECT c.dist_id,
         c.snapshotted_at,
         -- ⚠ FAIL OPEN. Register #118 explicitly forbids adding an availability
         -- predicate here, because this count reaching 0 flips the board's copy to
         -- "No +EV packs right now." -- a claim about the MARKET. A predicate that
         -- can drop a row on MISSING data would let our own read failure publish
         -- that claim, which is the exact defect the panel exists to prevent.
         -- So a row is dropped ONLY on positive evidence of delisting:
         --   is_listed = false  -> drop (upsert_pack_ask_state actively sets this
         --                         when a dist leaves the live feed)
         --   is_listed = true   -> keep
         --   no row at all      -> KEEP, because we do not know
         -- ⛔ Do NOT gate on `last_checked_at`: its own COMMENT has said since
         -- 2026-08-26 that it means "last CHANGED", not "last checked", and names
         -- pipeline_runs['snapshot-pack-asks'] as the freshness instrument instead.
         (pas.is_listed IS FALSE) AS known_delisted,
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
         a.known_delisted,
         -- Same asymmetry on the EV side: a recompute that could not run is
         -- UNKNOWN and keeps the row; only a successful recompute saying "not +EV"
         -- removes it.
         ((a.payload ->> 'ok')::boolean IS TRUE
          AND (a.payload ->> 'is_positive_ev')::boolean IS NOT TRUE) AS known_not_positive
  FROM adjudicated a
),
scored AS (
  SELECT v.*, (NOT v.known_delisted AND NOT v.known_not_positive) AS still_qualifies FROM verdict v
)
SELECT
  count(*) FILTER (WHERE s.still_qualifies)::integer AS qualifying_ignoring_freshness,
  max(s.snapshotted_at) FILTER (WHERE s.still_qualifies) AS newest_qualifying_snapshot,
  count(*) FILTER (WHERE s.still_qualifies
                     AND s.snapshotted_at >= (now() - '48:00:00'::interval))::integer AS qualifying_and_fresh,
  (SELECT count(*) FROM filtered)::integer AS candidates_considered,
  count(*)::integer AS candidates_adjudicated,
  count(*) FILTER (WHERE s.known_delisted)::integer AS dropped_delisted,
  count(*) FILTER (WHERE s.known_not_positive)::integer AS dropped_no_longer_positive_ev
FROM scored s;

COMMENT ON VIEW public.v_topshot_pack_reality_ranker_staleness IS
  'Why the /insights/pack-reality +EV ranker is empty. `qualifying_ignoring_freshness` is the count behind the board''s staleness sentence, and as of 2026-09-20 the counterfactual is ADJUDICATED rather than assumed: each candidate''s EV is recomputed live with compute_pack_ev_per_edition_weighted at the live ask. ⚠ IT FAILS OPEN, deliberately, because this count reaching 0 flips the copy to a claim about the MARKET: a candidate is dropped only on POSITIVE evidence -- pack_ask_state.is_listed = false, or a successful recompute that says not +EV. A missing ask row or a failed recompute KEEPS the row. `dropped_delisted` and `dropped_no_longer_positive_ev` make each removal auditable; `candidates_considered` > `candidates_adjudicated` means the 60-row recompute cap was hit and the count is a LOWER BOUND. Measured 2026-09-20: 3 considered, 1 dropped as no-longer-+EV (dist 7812, +7.73 -> -1.68 since August), 2 still qualifying. ⛔ Never gate this on pack_ask_state.last_checked_at -- that column means "last CHANGED" (see its own comment).';
