-- audit_20260828_candy_scarcity_board_scans_wmc_once
--
-- FOLLOW-UP to 20260829003000, and it is the half that entry's FALSIFIER predicted.
-- After scoping the FMV join, `candy_scarcity_board` still ran **8,424 ms / 46,636 buffers**,
-- and the FMV leg was only 398 of those. The cost was `wallet_moments_cache`, scanned TWICE
-- over the same 25,375 Candy rows:
--   · the `treas` CTE  -> 23,082 buffers, to return ONE wallet address
--   · the `h` group-by -> 23,079 buffers, plus a 25,375-row quicksort
-- `candy_treasury_wallet` is a view over the same rows with the same predicate, so referencing
-- it forced a second full pass.
--
-- FIX: scan those rows ONCE into a MATERIALIZED CTE, then derive BOTH the treasury wallet and
-- the per-edition split from that one result. `AS MATERIALIZED` is required — PG12+ inlines a
-- CTE referenced once, and inlining here would re-plan the scan per reference and undo the fix.
--
-- ── MEASURED, ANALYZE + BUFFERS on the live instance ────────────────────────
--   before (post-FMV-fix): 8,424.9 ms · 46,636 buffers (41,000 hit / 5,636 read)
--   after:                   140.0 ms · 30,120 buffers (30,067 hit /    53 read)
--   => ~60x faster, buffers -35%, and the treasury lookup drops 23,082 -> 3 buffers.
--   ⚠ Both figures are single samples on a shared instance. The BUFFER counts are the durable
--     comparison; the 60x wall-clock ratio will move with load and must not be quoted as a
--     guarantee.
--
-- ── EQUIVALENCE, proved against the LIVE view, atomically ───────────────────
-- Rewritten output FULL OUTER JOINed to the current `candy_scarcity_board` in ONE query, so
-- concurrent writes to `wallet_moments_cache` cannot confound it:
--     125 rows · sealed 0 diffs · circulating 0 diffs · holders 0 diffs · fmv_usd 0 diffs
--
-- ⚠ THE ONE SEMANTIC RISK IS A TIE FOR TOP HOLDER, and it was measured rather than argued.
-- `candy_treasury_wallet` is `ORDER BY count(*) DESC LIMIT 1` with NO tiebreak, so a tie makes
-- it arbitrary — and the inline `treas` below inherits exactly the same arbitrariness. Live
-- top holders: **2,129 · 1,821 · 741 · 655**. The margin is 308, so there is no tie and the two
-- forms cannot diverge today. ⛔ If Candy holdings ever converge at the top, BOTH forms become
-- non-deterministic — that is a pre-existing property of the view, not something introduced here.
--
-- ⚠ SCOPE: this migration changes ONE view. `candy_pack_market` and `candy_special_serials_board`
-- also reference `candy_treasury_wallet` and may carry the same double-scan; they are
-- deliberately NOT touched, so this ships as a measured pilot with its own before/after rather
-- than three simultaneous rewrites nobody can attribute.
--
-- 🚨 `WITH (security_invoker = on)` IS LOAD-BEARING. `CREATE OR REPLACE VIEW` without a WITH
-- clause RESETS reloptions and silently strips it; this repo has recorded that four times, and
-- it is invisible to output md5, row counts and buffers alike.
--
-- ⚠ Column names, order and types are byte-identical to the current definition — only the FROM
-- side changes. `CREATE OR REPLACE VIEW` cannot rename or reorder columns (42P16), so drift
-- fails loudly.
--
-- REVERT: re-run 20260829003000's `candy_scarcity_board` statement (the two-scan form that
-- references `candy_treasury_wallet`), keeping `WITH (security_invoker = on)`.
--
-- EXIT CONDITION: the `[candy-mlb] candy_scarcity_board error: canceling statement due to
-- statement timeout` group stops accruing new events in Vercel runtime errors.
-- FALSIFIER: if it keeps accruing at 140 ms warm, the timeouts are not this query's cost at all
-- but contention on the shared `Promise.all` batch in lib/insights/candy-board.ts.

CREATE OR REPLACE VIEW public.candy_scarcity_board
WITH (security_invoker = on) AS
 WITH wmc AS MATERIALIZED (
         SELECT wallet_moments_cache.edition_key,
            wallet_moments_cache.wallet_address
           FROM wallet_moments_cache
          WHERE wallet_moments_cache.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
        ), treas AS MATERIALIZED (
         SELECT wmc.wallet_address
           FROM wmc
          GROUP BY wmc.wallet_address
          ORDER BY (count(*)) DESC
         LIMIT 1
        ), h AS (
         SELECT w.edition_key,
            count(*) FILTER (WHERE w.wallet_address = (( SELECT treas.wallet_address
                   FROM treas))) AS sealed,
            count(*) FILTER (WHERE w.wallet_address <> (( SELECT treas.wallet_address
                   FROM treas))) AS circulating,
            count(DISTINCT w.wallet_address) FILTER (WHERE w.wallet_address <> (( SELECT treas.wallet_address
                   FROM treas))) AS holders
           FROM wmc w
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
