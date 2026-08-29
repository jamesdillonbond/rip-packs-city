-- audit_20260828_candy_boards_join_the_scoped_fmv_view
--
-- WHAT IS WRONG. Four `candy_*` boards LEFT JOIN the GLOBAL `fmv_current`, which is
-- `SELECT DISTINCT ON (edition_id) … FROM fmv_snapshots` with NO predicate. `DISTINCT ON`
-- is an optimization fence, so the Candy collection filter cannot push into it: the
-- planner materialises the WHOLE snapshot history and then throws ~all of it away
-- against 125 Candy editions.
--
-- MEASURED (plan estimate, `candy_scarcity_board`, ORDER BY … LIMIT 500):
--   before: total cost 99,950 — of which the FMV leg is
--           Merge Append rows=1,289,541 (cost 75,396) -> Unique cost 78,620  = 79% of the query
--   after:  total cost 21,382 — FMV leg
--           Merge Append rows=3,699 (cost 164) -> Unique cost 173.69
--   => FMV leg 78,620 -> 173.69 (~452x), whole query ~4.7x cheaper. The scoped path is an
--      INDEX ONLY SCAN on `fmv_snapshots_2026_coll_ed_ct_fmv_conf_idx`, which already exists.
--   ⚠ Estimates, not BUFFERS: measuring the "before" for real means running the 1.29M-row
--     scan this migration exists to stop. The row counts (1,289,541 vs 3,699) are the
--     honest evidence; do not quote the cost units as a speedup factor.
--
-- WHY IT MATTERS. These boards are user-facing and they fail in PRODUCTION. Vercel runtime
-- errors, 24 h to 2026-08-29T00:02Z, all `canceling statement due to statement timeout`:
--   candy_scarcity_board 148 · candy_parallel_premium 137 · candy_offer_spread_board 136
--   candy_player_board 134 · candy_special_serials_board 102 · candy_pack_market 85
--   candy_deals_board 41 · candy_secondary_board 33
-- ⚠ THE FIX TARGETS FOUR OF THOSE EIGHT. The other four were ALREADY scoped by an earlier
--   pass; they appear in the error list because `lib/insights/candy-board.ts` fetches all
--   boards in one `Promise.all`, so the expensive four can starve the cheap ones. **Expect
--   the already-scoped boards' errors to fall too — and do NOT read that as this migration
--   fixing them directly.**
--
-- 🚨 HOW I NEARLY GOT THE SCOPE WRONG. My first sweep used
--   `pg_get_viewdef(...) ILIKE '%fmv_current%'` and reported EIGHT views to fix. That
--   substring also matches `candy_fmv_current`, so four already-correct views were counted
--   as broken. Word-boundary matching (`\mfmv_current\M` vs `\mcandy_fmv_current\M`) gives
--   the true split: 4 unscoped, 4 already scoped. This repo's own rule — *a substring test
--   on a definition is not a state check* — met in the wild.
--
-- ── EQUIVALENCE: PROVED AT THE ROOT, over the whole population ───────────────
-- `candy_fmv_current` is the same DISTINCT ON with the collection predicate INSIDE it.
-- Compared against the global view across every Candy edition:
--     global_rows 125 · scoped_rows 125 · disagreements 0
-- over `fmv_usd`, `confidence` AND `computed_at` (a FULL OUTER JOIN on edition_id, so a row
-- present on only one side would count). Everything these four views compute is a pure
-- function of that join, so the root equivalence carries.
-- Baseline output fingerprints captured immediately before this migration, for corroboration:
--     candy_scarcity_board      125 rows  e7c4b9311713fbced26af9542aa286d4
--     candy_player_board        100 rows  889e9412d3e2d6d44ef00c8b994798e2
--     candy_parallel_premium      2 rows  67656ba03ac13b473c45a8d70217c5bc
--     candy_offer_spread_board  125 rows  b1c234b24f619c2fc6f78fb3b2a9ebac
-- ⚠ A fingerprint mismatch after this migration is NOT automatically a defect: `fmv_current`
--   moves whenever a new snapshot lands. Re-check the ROOT comparison above before concluding.
--
-- ⚠ COLUMN USAGE CHECKED BEFORE SWAPPING, not assumed. `candy_fmv_current` exposes only
--   (edition_id, fmv_usd, confidence, computed_at). The four views below reference exactly
--   `fc.edition_id`, `fc.fmv_usd` and `fc.confidence` — no view needs a column the scoped
--   view lacks. (`candy_secondary_board`, already scoped, is the only one using computed_at.)
--
-- 🚨 `WITH (security_invoker = on)` IS LOAD-BEARING ON EVERY STATEMENT BELOW.
--   `CREATE OR REPLACE VIEW` with no WITH clause RESETS reloptions and silently strips it —
--   this repo has recorded that happening at least FOUR times, and it is invisible to output
--   md5, row counts and buffers alike. All four views carry `security_invoker=on` today
--   (read from `pg_class.reloptions` before writing this) and must carry it after.
--
-- ⚠ Column names and order are BYTE-IDENTICAL to the current definitions; only the joined
--   relation changes. `CREATE OR REPLACE VIEW` cannot rename or reorder columns (42P16), so
--   any drift here fails loudly rather than silently.
--
-- REVERT: re-run these four statements with `candy_fmv_current` changed back to
-- `fmv_current`, keeping the `WITH (security_invoker = on)` clause on each.
--
-- EXIT CONDITION: the `[candy-mlb] candy_*_board error: canceling statement due to statement
-- timeout` groups stop accruing new events in Vercel runtime errors.
-- FALSIFIER: if they keep accruing at the same rate, the boards are not FMV-bound and the
-- remaining cost is the `wallet_moments_cache` aggregate (the `treas` CTE and `h` group-by
-- are ~20,400 of the residual 21,382 estimate) — in which case the next lever is there,
-- NOT a bigger statement_timeout.

CREATE OR REPLACE VIEW public.candy_scarcity_board
WITH (security_invoker = on) AS
 WITH treas AS (
         SELECT candy_treasury_wallet.wallet_address
           FROM candy_treasury_wallet
        ), h AS (
         SELECT w.edition_key,
            count(*) FILTER (WHERE w.wallet_address = (( SELECT treas.wallet_address
                   FROM treas))) AS sealed,
            count(*) FILTER (WHERE w.wallet_address <> (( SELECT treas.wallet_address
                   FROM treas))) AS circulating,
            count(DISTINCT w.wallet_address) FILTER (WHERE w.wallet_address <> (( SELECT treas.wallet_address
                   FROM treas))) AS holders
           FROM wallet_moments_cache w
          WHERE w.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
          GROUP BY w.edition_key
        )
 SELECT e.external_id,
    e.player_name,
    e.name AS edition_name,
    e.tier::text AS tier,
    e.tier = 'LEGENDARY'::tier_type AS is_rainbow,
    e.circulation_count,
    COALESCE(h.sealed, 0::bigint) AS sealed,
    COALESCE(h.circulating, 0::bigint) AS circulating,
    round(100.0 * COALESCE(h.circulating, 0::bigint)::numeric / NULLIF(e.circulation_count, 0)::numeric, 1) AS circulating_pct,
    COALESCE(h.holders, 0::bigint) AS holders,
    fc.fmv_usd,
    fc.confidence::text AS confidence
   FROM editions e
     LEFT JOIN h ON h.edition_key = e.external_id::text
     LEFT JOIN candy_fmv_current fc ON fc.edition_id = e.id
  WHERE e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid;

CREATE OR REPLACE VIEW public.candy_player_board
WITH (security_invoker = on) AS
 WITH sale_ct AS (
         SELECT sales.edition_id,
            count(*) AS sales_all
           FROM sales
          WHERE sales.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid AND sales.edition_id IS NOT NULL
          GROUP BY sales.edition_id
        )
 SELECT e.player_name,
    max(e.team_name) AS team_name,
    count(*) AS editions,
    count(*) FILTER (WHERE e.tier = 'LEGENDARY'::tier_type) AS rainbow_editions,
    sum(e.circulation_count) AS total_supply,
    count(fc.fmv_usd) AS priced,
    round(avg(fc.fmv_usd), 2) AS avg_fmv,
    round(max(fc.fmv_usd), 2) AS top_fmv,
    COALESCE(sum(sc.sales_all), 0::numeric) AS sales_all
   FROM editions e
     LEFT JOIN candy_fmv_current fc ON fc.edition_id = e.id
     LEFT JOIN sale_ct sc ON sc.edition_id = e.id
  WHERE e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid AND e.player_name IS NOT NULL
  GROUP BY e.player_name;

CREATE OR REPLACE VIEW public.candy_parallel_premium
WITH (security_invoker = on) AS
 SELECT
        CASE
            WHEN e.tier = 'LEGENDARY'::tier_type THEN 'Rainbow'::text
            ELSE 'Core (ICON)'::text
        END AS parallel_group,
    e.tier = 'LEGENDARY'::tier_type AS is_rainbow,
    count(*) AS editions,
    count(fc.fmv_usd) AS priced,
    round(avg(fc.fmv_usd), 2) AS avg_fmv,
    round(min(fc.fmv_usd), 2) AS min_fmv,
    round(max(fc.fmv_usd), 2) AS max_fmv,
    sum(e.circulation_count) AS total_supply
   FROM editions e
     LEFT JOIN candy_fmv_current fc ON fc.edition_id = e.id
  WHERE e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
  GROUP BY (e.tier = 'LEGENDARY'::tier_type);

CREATE OR REPLACE VIEW public.candy_offer_spread_board
WITH (security_invoker = on) AS
 WITH top_offer AS (
         SELECT DISTINCT ON (o.edition_id) o.edition_id,
            o.token_mint AS best_offer_mint
           FROM candy_offers o
          WHERE o.is_active AND (o.expiry IS NULL OR o.expiry > now())
          ORDER BY o.edition_id, o.price_usd DESC, o.token_mint
        ), floor_mint AS (
         SELECT DISTINCT ON (l.edition_id) l.edition_id,
            l.token_mint AS floor_mint
           FROM candy_listings l
             JOIN candy_listing_floor lf_1 ON lf_1.edition_id = l.edition_id AND l.price_usd = lf_1.floor_usd
          WHERE l.is_active
          ORDER BY l.edition_id, l.token_mint
        ), floor_copy_bid AS (
         SELECT fm_1.edition_id,
            max(o.price_usd) AS floor_copy_bid_usd
           FROM floor_mint fm_1
             JOIN candy_offers o ON o.token_mint = fm_1.floor_mint AND o.is_active AND (o.expiry IS NULL OR o.expiry > now())
          GROUP BY fm_1.edition_id
        )
 SELECT e.external_id,
    e.player_name,
    e.name AS edition_name,
    e.tier::text AS tier,
    e.tier = 'LEGENDARY'::tier_type AS is_rainbow,
    e.circulation_count,
    lf.floor_usd,
    lf.listing_count,
    bo.best_offer_usd,
    bo.distinct_bidders,
    fc.fmv_usd,
    fm.floor_mint,
    t.best_offer_mint,
        CASE
            WHEN fm.floor_mint IS NOT NULL AND t.best_offer_mint IS NOT NULL THEN fm.floor_mint = t.best_offer_mint
            ELSE NULL::boolean
        END AS same_copy,
    fcb.floor_copy_bid_usd,
        CASE
            WHEN lf.floor_usd IS NOT NULL AND fcb.floor_copy_bid_usd IS NOT NULL THEN round(lf.floor_usd - fcb.floor_copy_bid_usd, 2)
            ELSE NULL::numeric
        END AS exec_spread_usd,
        CASE
            WHEN lf.floor_usd IS NOT NULL AND lf.floor_usd > 0::numeric AND fcb.floor_copy_bid_usd IS NOT NULL THEN round(100.0 * (lf.floor_usd - fcb.floor_copy_bid_usd) / lf.floor_usd, 1)
            ELSE NULL::numeric
        END AS exec_spread_pct
   FROM editions e
     LEFT JOIN candy_listing_floor lf ON lf.edition_id = e.id
     LEFT JOIN candy_best_offers bo ON bo.edition_id = e.id
     LEFT JOIN candy_fmv_current fc ON fc.edition_id = e.id
     LEFT JOIN floor_mint fm ON fm.edition_id = e.id
     LEFT JOIN top_offer t ON t.edition_id = e.id
     LEFT JOIN floor_copy_bid fcb ON fcb.edition_id = e.id
  WHERE e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid AND (lf.floor_usd IS NOT NULL OR bo.best_offer_usd IS NOT NULL);
