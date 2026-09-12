-- pack_table_rows publishes the AS-OF of every depletion / supply number it
-- already publishes. Two new columns at the END of the view, no existing column
-- changed, no row count changed.
--
-- WHY (measured 2026-09-11 PT, register #74). Every pack depletion and
-- packs-remaining figure on this site is derived from a supply counter whose
-- refresh lane is dead, and no surface, guard or alert can tell a 73-day-old
-- number from a fresh one:
--   · topshot_pack_supply   2,085 rows; newest SUCCESSFUL fetch 2026-08-26,
--                           median updated_at 2026-06-28, 2,068 of 2,085 older
--                           than 30 days.
--   · allday_pack_supply    3,195 rows on exactly TWO distinct days — 3,020 at
--                           2026-06-30 (the one-shot hydration) and 175 at
--                           2026-09-01. Migration 20260901071258's own header
--                           says "THIS IS A REPAIR, NOT THE FIX -- the hydrator
--                           will freeze again the moment it finishes". It has.
--   · metadata->>'tier_counts_updated_at' (the v20 EV sweep's tier counts, the
--                           page's third depletion source) — 823 of 2,099 Top
--                           Shot dists carry it, newest 2026-08-28, and ZERO are
--                           fresher than 7 days. The page labelled that path
--                           "live pool". That half is fixed in the page, not here.
--
-- 🚨 AND #74's OWN RECOMMENDATION, TAKEN LITERALLY, WOULD HAVE SHIPPED THE
-- DEFECT IT WAS TRYING TO PREVENT. It says: "render topshot_pack_supply.updated_at
-- as an as-of wherever depletion is shown". But apply_topshot_supply's FAILURE
-- branch (migration 20260802191000) is
--     INSERT ... (dist_id, supply_ok, supply_err, updated_at)
--     VALUES (p_dist_id, false, ..., now())
--     ON CONFLICT (dist_id) DO UPDATE SET supply_ok=false, ..., updated_at=now();
-- i.e. it bumps updated_at on a FAILED fetch and leaves the stale supply columns
-- alone. `updated_at` is an ATTEMPT stamp, not a data-as-of stamp, so rendering
-- it unguarded would print a fresh age over stale numbers — this repo's #1
-- defect class, introduced by the fix for it.
-- ⭐ THE TELL WAS FREE AND IS RECORDED SO THE NEXT READER SEES IT: max(updated_at)
-- over the table is 2026-09-11 08:15Z, while max(updated_at) WHERE supply_ok is
-- 2026-08-26. A sixteen-day gap between "newest row" and "newest good row" is the
-- whole finding. The two freshest rows are supply_err='HTTP 530'.
-- So supply_as_of is guarded on supply_ok below, and is NULL — not a lie — on a
-- failed row.
-- ⚠ STATED LIMIT: because the failure branch OVERWRITES updated_at, a dist that
-- succeeded once and has failed since has lost its last-success timestamp
-- entirely; this view reports NULL for it rather than guessing. Today that costs
-- nothing (both supply_ok=false rows have NULL supply and have never succeeded,
-- so no number is rendered for them at all), but the schema permits the loss. The
-- durable fix is a separate last_success_at column on topshot_pack_supply written
-- only by the success branch — deliberately NOT done here, because it changes a
-- PINNED function (apply_topshot_supply) on a lane that has not written since
-- 08-26, so it is pure shape with no observable effect until the lane returns.
--
-- WHAT THE TWO COLUMNS MEAN — and they are deliberately two, because the numbers
-- they date have DIFFERENT ages and pairing a count from one source with an age
-- from another is worse than showing no age at all:
--
--   supply_as_of     as-of of total_minted / total_opened / total_sealed on this
--                    row. Top Shot: topshot_pack_supply.updated_at, ONLY when
--                    supply_ok. All Day: allday_pack_supply.opened_updated_at,
--                    which is a true data stamp (written with opened_count by the
--                    Dapper searchPackNft leg). Any other collection: NULL —
--                    there is no supply lane, so there is no honest age.
--
--   depletion_as_of  as-of of the depletion_pct column SPECIFICALLY, branch-matched
--                    to the COALESCE that produces it: supply_as_of when the
--                    generated pd.depletion_pct wins, pev.snapshotted_at when the
--                    mv_pack_ev_latest fallback wins, NULL when neither produced a
--                    value. Derived by re-stating the same predicate rather than
--                    by a second guess, so a future edit to depletion_pct that
--                    forgets this column produces a MISMATCH a reader can see,
--                    not a silently wrong age.
--
-- WRITE-THROUGH VERIFIED, BOTH COLLECTIONS, WITH THE NEGATIVE CASE COUNTED —
-- because "the counters match" is worthless without knowing how many rows could
-- not match (measured 2026-09-11):
--   Top Shot  pack_distributions.total_minted/total_opened identical to
--             topshot_pack_supply on 2,083 of 2,083 supply_ok rows, zero
--             divergence either direction (#74's own measurement); the write-through
--             is in apply_topshot_supply's success branch, same transaction.
--   All Day   3,052 dists; pd.total_opened = s.opened_count on 3,018 of 3,018 that
--             HAVE a supply row, pd.total_minted = s.packnft_total on the same
--             3,018. The remaining 34 have no supply row → supply_as_of NULL,
--             which is the correct answer and not a zero.
--
-- COST. Two LEFT JOINs onto PK-keyed tables of 2,085 and 3,195 rows, each scoped
-- by collection_id in its ON clause so a Top Shot row never probes the All Day
-- table and vice versa. Measured before/after, warm-vs-warm, on the query the
-- pack detail page actually issues (get_pack_detail_bundle's to_jsonb(t) read of
-- one dist): see the verification block at the foot of this file.
--
-- SECURITY MODE — definer-view: intentional.
-- pack_table_rows is DEFINER today (reloptions NULL) and is in
-- public.security_definer_view_allowlist ("baseline 2026-06-28: pre-existing
-- intentional definer view"), with SELECT revoked from anon AND authenticated
-- (verified live 2026-09-11: has_table_privilege reads false for both, true for
-- service_role). This CREATE OR REPLACE carries no WITH clause, which PRESERVES
-- that state — the reset trap CLAUDE.md records applies to a view that HAS
-- security_invoker=on and loses it; there is nothing here to lose. The mode is
-- named rather than left silent, per __tests__/migration-view-security-invoker-guard.ts.
-- The two new source tables carry no anon grant either, so the view exposes
-- nothing anon could not already reach through it.
--
-- REVERT: re-run the immediately-preceding definition of public.pack_table_rows
-- (this file minus the two trailing columns and the two LEFT JOINs). Nothing
-- reads the new columns until the page change lands, so reverting this file
-- alone is safe in either order.
-- anon-exec: n/a — this migration creates no function.

CREATE OR REPLACE VIEW public.pack_table_rows AS
 SELECT pd.dist_id,
    pd.collection_id,
    c.name AS collection_name,
        CASE
            WHEN c.name::text = 'NBA Top Shot'::text THEN 'nba-top-shot'::text
            WHEN c.name::text = 'NFL All Day'::text THEN 'nfl-all-day'::text
            WHEN c.name::text = 'LaLiga Golazos'::text THEN 'laliga-golazos'::text
            WHEN c.name::text = 'UFC Strike'::text THEN 'ufc-strike'::text
            ELSE lower(replace(c.name::text, ' '::text, '-'::text))
        END AS collection_slug,
    COALESCE(pd.title, pd.metadata ->> 'name'::text) AS title,
    COALESCE(pd.metadata ->> 'thumbnail'::text, pd.image_url) AS image_url,
    pd.nft_type,
    lower(pd.metadata ->> 'tier'::text) AS tier,
    pd.metadata ->> 'pack_type'::text AS pack_type,
    pd.metadata ->> 'description'::text AS description,
        CASE
            WHEN (pd.metadata ->> 'retail_price_usd'::text) IS NULL THEN NULL::numeric
            WHEN ((pd.metadata ->> 'retail_price_usd'::text)::numeric) >= 1000000::numeric THEN round(((pd.metadata ->> 'retail_price_usd'::text)::numeric) / 100000000::numeric, 2)
            ELSE round((pd.metadata ->> 'retail_price_usd'::text)::numeric, 2)
        END AS retail_price_usd,
    (pd.metadata ->> 'number_of_pack_slots'::text)::integer AS slots,
    pd.total_minted,
    pd.total_opened,
    pd.total_sealed,
    COALESCE(NULLIF(pd.depletion_pct, 0::smallint),
        CASE
            WHEN sent.is_sentinel THEN NULL::smallint
            ELSE round(pev.depletion_pct::double precision)::smallint
        END) AS depletion_pct,
        CASE
            WHEN sent.is_sentinel THEN NULL::numeric
            ELSE pev.pack_ev
        END::numeric(10,2) AS pack_ev,
        CASE
            WHEN sent.is_sentinel THEN NULL::numeric
            ELSE pev.gross_ev
        END::numeric(10,2) AS gross_ev,
    pev.pack_price AS ev_pack_price,
        CASE
            WHEN sent.is_sentinel THEN NULL::numeric
            ELSE pev.value_ratio
        END::numeric(12,4) AS value_ratio,
        CASE
            WHEN sent.is_sentinel THEN NULL::boolean
            ELSE pev.is_positive_ev
        END AS is_positive_ev,
        CASE
            WHEN sent.is_sentinel THEN NULL::smallint
            ELSE pev.fmv_coverage_pct
        END AS fmv_coverage_pct,
    pev.edition_count,
    pev.total_unopened,
        CASE
            WHEN sent.is_sentinel THEN NULL::smallint
            ELSE pev.depletion_pct
        END AS ev_depletion_pct,
    pev.snapshotted_at AS ev_snapshotted_at,
        CASE
            WHEN sent.is_sentinel THEN NULL::numeric
            WHEN pev.pack_ev IS NOT NULL AND pev.pack_price > 0::numeric THEN round(pev.pack_ev / pev.pack_price * 100::numeric, 1)
            ELSE NULL::numeric
        END AS ev_margin_pct,
    pd.first_seen_at,
    pd.updated_at,
        CASE
            WHEN pev.edition_count = 1 AND pev.pack_ev > 500::numeric THEN true
            ELSE false
        END AS is_rare_single_pack,
    pev.primary_price,
    COALESCE(pas.live_ask, pev.secondary_ask) AS secondary_ask,
    pev.price_source,
    pev.primary_available,
        CASE
            WHEN pas.live_ask IS NOT NULL THEN true
            ELSE pev.secondary_available
        END AS secondary_available,
        CASE
            WHEN sent.is_sentinel THEN NULL::numeric
            ELSE pev.typical_ev
        END::numeric(10,2) AS typical_ev,
    -- ── NEW 2026-09-11 ────────────────────────────────────────────────────────
    -- As-of of total_minted / total_opened / total_sealed. See the header: the
    -- supply_ok guard is load-bearing, because apply_topshot_supply bumps
    -- updated_at on a FAILED fetch while leaving the stale counters in place.
        CASE
            WHEN pd.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
              THEN CASE WHEN tss.supply_ok THEN tss.updated_at ELSE NULL::timestamptz END
            WHEN pd.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
              THEN ads.opened_updated_at
            ELSE NULL::timestamptz
        END AS supply_as_of,
    -- As-of of depletion_pct SPECIFICALLY, branch-matched to the COALESCE that
    -- produces it twenty lines above. Restating the predicate (rather than
    -- guessing a single source) is what keeps the age attached to the number that
    -- was actually rendered.
        CASE
            WHEN NULLIF(pd.depletion_pct, 0::smallint) IS NOT NULL
              THEN CASE
                     WHEN pd.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
                       THEN CASE WHEN tss.supply_ok THEN tss.updated_at ELSE NULL::timestamptz END
                     WHEN pd.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
                       THEN ads.opened_updated_at
                     ELSE NULL::timestamptz
                   END
            WHEN NOT sent.is_sentinel AND pev.depletion_pct IS NOT NULL
              THEN pev.snapshotted_at
            ELSE NULL::timestamptz
        END AS depletion_as_of
   FROM pack_distributions pd
     JOIN collections c ON c.id = pd.collection_id
     LEFT JOIN mv_pack_ev_latest pev ON pev.dist_id = pd.dist_id AND pev.collection_id = pd.collection_id AND NOT (pd.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid AND (EXISTS ( SELECT 1
           FROM pack_ask_state a
          WHERE a.collection_slug = 'nba-top-shot'::text AND a.dist_id = pev.dist_id AND a.is_listed IS TRUE AND a.lowest_ask > 0::numeric AND pev.gross_ev > (3::numeric * a.lowest_ask)))) AND (EXISTS ( SELECT 1
           FROM pack_drop_pool dp
          WHERE dp.collection_id = pd.collection_id AND dp.dist_id = pd.dist_id)) AND (pev.pack_price IS NULL OR pev.pack_price < 9999::numeric) AND (pev.fmv_coverage_pct IS NULL OR pev.fmv_coverage_pct >= 25)
     LEFT JOIN LATERAL ( SELECT
                CASE
                    WHEN pas0.is_listed IS TRUE AND pas0.lowest_ask > 0::numeric THEN pas0.lowest_ask
                    ELSE NULL::numeric
                END AS live_ask
           FROM pack_ask_state pas0
          WHERE pas0.dist_id = pd.dist_id AND (pd.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid AND pas0.collection_slug = 'nba-top-shot'::text OR pd.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid AND pas0.collection_slug = 'nfl-all-day'::text)
         LIMIT 1) pas ON true
     LEFT JOIN LATERAL ( SELECT pev.gross_ev = 0::numeric AND pev.edition_count = 0 AS is_sentinel) sent ON true
     -- Collection-scoped so a Top Shot row never probes the All Day supply table
     -- and vice versa; both are PK lookups on dist_id.
     LEFT JOIN topshot_pack_supply tss ON tss.dist_id = pd.dist_id
          AND pd.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
     LEFT JOIN allday_pack_supply ads ON ads.dist_id = pd.dist_id
          AND pd.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid;

COMMENT ON VIEW public.pack_table_rows IS
  'Pack catalogue read model. supply_as_of / depletion_as_of (added 2026-09-11) date the numbers beside them: supply_as_of is topshot_pack_supply.updated_at GUARDED ON supply_ok (the failure branch of apply_topshot_supply bumps that stamp while leaving stale counters, so unguarded it would report a fresh age over 73-day-old data) for Top Shot and allday_pack_supply.opened_updated_at for All Day, NULL elsewhere; depletion_as_of is branch-matched to the COALESCE producing depletion_pct, falling back to mv_pack_ev_latest.snapshotted_at. NULL means "no honest age", never "fresh".';

-- ── VERIFICATION, run against production 2026-09-11 PT ────────────────────────
--
-- 1. EQUIVALENCE OF THE 36 PRE-EXISTING COLUMNS — done in ONE statement, before
--    apply, with the new definition inlined as a CTE beside the live view:
--       new_md5  f2afe8b3ef5f6d6f03c714cb2f9be5cd   new_rows  5529
--       live_md5 f2afe8b3ef5f6d6f03c714cb2f9be5cd   live_rows 5529
--    ⚠ ONE STATEMENT IS THE POINT, NOT A CONVENIENCE. A first attempt md5'd the
--    live view, and a later md5 of the same live view differed — pack_ask_state
--    is written under the view and feeds secondary_ask, so a before/after pair
--    taken minutes apart would have reported a spurious difference (or, with the
--    opposite luck, hidden a real one). Comparing both sides inside a single
--    snapshot removes the concurrent writer from the measurement.
--    ⭐ Equal row counts also prove the two LEFT JOINs multiply nothing: both
--    tables are keyed on dist_id, so it was expected — now it is measured.
--
-- 2. SECURITY MODE PRESERVED (the whole reason the guard exists):
--       reloptions NULL (unchanged) · anon SELECT false · authenticated false
--       · service_role true · 36 columns → 38.
--
-- 3. COST, WARM-VS-WARM, on the query the pack detail page actually issues
--    (get_pack_detail_bundle's `to_jsonb(t)` read of one dist):
--       before  19 buffers (all hit), 0.586 ms
--       after   24 buffers (all hit), 0.733 ms
--    +5 buffers = a 3-buffer topshot_pack_supply PK probe and a 2-buffer
--    allday_pack_supply PK probe. ⚠ BOTH probes run on every row: the planner
--    puts the collection_id predicate in a Join Filter ABOVE the index scan
--    rather than short-circuiting it, so a Top Shot row still probes the All Day
--    table. Left as-is deliberately — 5 buffers of PK lookup on two fully-cached
--    tables (2,085 and 3,195 rows) is not worth a lateral, and no caller reads
--    this view unfiltered.
--
-- 4. THE NEW COLUMNS, POPULATED AND WITH THE NEGATIVE CASE COUNTED:
--       NFL All Day     3,052 dists, 3,018 with an as-of, 2,867 older than 30d,
--                       oldest 2026-06-30, newest 2026-09-01
--       NBA Top Shot    2,099 dists, 2,083 with an as-of, 2,068 older than 30d,
--                       oldest 2026-06-28, newest 2026-08-26
--       LaLiga Golazos    224 dists, 0 with an as-of
--       Disney Pinnacle   154 dists, 0 with an as-of
--    ⭐ The two zeros are the NEGATIVE CONTROL, not a gap: neither collection has
--    a supply lane, so NULL is the correct answer and the page renders no age
--    clause for them. A column that produced a stamp for all four would be the
--    bug.
