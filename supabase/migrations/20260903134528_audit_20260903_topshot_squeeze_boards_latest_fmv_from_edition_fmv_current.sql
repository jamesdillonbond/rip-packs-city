-- audit_20260903_topshot_squeeze_boards_latest_fmv_from_edition_fmv_current
--
-- The next R50-shaped board after allday_scarcity_board. `topshot_set_squeeze_board`
-- was the slowest public board in public_board_liveness_history over the 3 days to
-- 2026-09-03 (p50 5,207 ms, max 8,006 ms against the 8,300 ms budget; 12 samples),
-- and the cause is the same one the 09-03 allday migration removed: its inner view
-- `topshot_squeeze_board` picked the latest FMV per edition with a per-row LATERAL
-- `ORDER BY computed_at DESC LIMIT 1` over fmv_snapshots — 9,470 probes, each
-- walking the 2026 partition's index (and the empty 2027 one) — and the outer view
-- then re-joined `editions` by PK only to reach `set_id`, which the inner view did
-- not expose.
--
-- MEASURED 2026-09-03 13:5xZ, warm, the page's REAL SELECT on the set board
-- (15 columns, ORDER BY avg_squeeze_pct DESC NULLS LAST, total_buyable, LIMIT 100):
--   before: shared hit=89,208 read=816 · 1,097 ms — 56,820 of the buffers in the
--           per-edition fmv_snapshots LATERAL, 28,413 in the redundant editions
--           PK re-join
--   after:  shared hit=45,369 · 119 ms — the FMV side is a PK probe into
--           edition_fmv_current (28,410) and the re-join is gone
--   => −50% buffers warm; the part that balloons under IO saturation (the
--      snapshot-partition walk) is gone entirely. Cold numbers NOT quoted.
-- The edition-level board's default page SELECT (squeeze_pct >= 50, LIMIT 200) was
-- already cheap (6,819 buffers: the LATERAL only ran for the 200 output rows); its
-- `sort=fmv` path, which must price every row, gets the same relief as the set board.
--
-- SAME-SNAPSHOT SET DIFF over all 9,471 badge-covered Top Shot editions, one
-- statement, efc 43 min old at the time: old_priced 9,300 · new_priced 9,300 ·
-- null flips 0 · fmv differs 49 (max |Δ| $69.92) · confidence differs 5 — all
-- bounded by the hourly refresh. Nothing is dropped; a value can lag ≤ 1 h, which
-- is the same source the sniper, series and allday boards already show.
-- `low_ask_disconnected` and the `low_ask` NULL-gate read the same lagging value;
-- both are display flags, not filter predicates (the one case database.md marks
-- unsafe).
--
-- COLUMN CONTRACT: every existing column keeps its name, position and type
-- (`fmv_usd` cast to numeric(12,4), `confidence` to text — CREATE OR REPLACE VIEW
-- refuses a type change, 42P16). ONE column is APPENDED to the inner view,
-- `set_id uuid`, so the outer view can join `sets` directly. Appending is the one
-- shape CREATE OR REPLACE VIEW allows. Readers of the inner view that select
-- named columns (`lib/insights/squeeze-board.ts`, get_edition_insight_links,
-- get_insights_hub_stats, get_team_squeeze) are unaffected.
--
-- ⚠ CREATE OR REPLACE VIEW with no WITH clause RESETS reloptions and strips
-- security_invoker — re-asserted explicitly on both views (both carried it).
-- No grant change (anon/authenticated SELECT stand).
--
-- LIVENESS PROBE caveat as on 08-10 / 09-03: the probe times count(*), and for
-- the SET board count(*) cannot prune the aggregate, so this one the probe CAN
-- see — read the next public_board_liveness_history samples for topshot_set_squeeze_board.
--
-- REVERT: re-create both views with the bodies recorded in docs/overnight/ledger.md
-- (entry of 2026-09-03 "topshot squeeze boards"), i.e. the fmv_snapshots LATERAL
-- and the editions re-join. The appended set_id column cannot be dropped by
-- CREATE OR REPLACE — a revert that must remove it is DROP VIEW … CASCADE +
-- re-create both, then re-grant.

CREATE OR REPLACE VIEW public.topshot_squeeze_board
WITH (security_invoker = on) AS
 SELECT e.id AS edition_id,
    e.external_id,
    COALESCE(e.player_name, be.player_name) AS player_name,
    COALESCE(e.set_name, be.set_name) AS set_name,
    COALESCE(e.tier::text, replace(be.tier, 'MOMENT_TIER_'::text, ''::text)) AS tier,
    COALESCE(e.circulation_count, be.circulation_count) AS circulation,
    be.locked,
    be.burned,
    round(100.0 * COALESCE(be.locked, 0)::numeric / NULLIF(COALESCE(e.circulation_count, be.circulation_count, 0), 0)::numeric, 1) AS lock_pct,
    round(100.0 * COALESCE(be.burned, 0)::numeric / NULLIF(COALESCE(e.circulation_count, be.circulation_count, 0), 0)::numeric, 1) AS burn_pct,
    round(100.0 * (COALESCE(be.locked, 0) + COALESCE(be.burned, 0))::numeric / NULLIF(COALESCE(e.circulation_count, be.circulation_count, 0), 0)::numeric, 1) AS squeeze_pct,
    GREATEST(COALESCE(e.circulation_count, be.circulation_count, 0) - COALESCE(be.locked, 0) - COALESCE(be.burned, 0), 0) AS effectively_buyable,
    CASE WHEN efc.fmv_usd IS NULL THEN NULL::numeric ELSE be.low_ask END AS low_ask,
    -- Materialised latest-per-edition (hourly). Was a per-row LATERAL over
    -- fmv_snapshots; see header. Casts keep the column types unchanged.
    efc.fmv_usd::numeric(12,4) AS fmv_usd,
    efc.confidence::text AS confidence,
    e.game_date,
    e.thumbnail_url,
    efc.fmv_usd IS NOT NULL AND efc.fmv_usd > 0::numeric AND be.low_ask IS NOT NULL AND be.low_ask > (10::numeric * efc.fmv_usd) AS low_ask_disconnected,
    -- APPENDED 2026-09-03 so topshot_set_squeeze_board can reach sets without
    -- re-joining editions by PK (28k buffers per read).
    e.set_id
   FROM badge_editions be
     JOIN editions e ON e.external_id::text = be.external_id AND e.collection_id = be.collection_id
     LEFT JOIN edition_fmv_current efc ON efc.edition_id = e.id
  WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
    AND COALESCE(e.circulation_count, be.circulation_count) IS NOT NULL
    AND COALESCE(e.circulation_count, be.circulation_count) > 0;

CREATE OR REPLACE VIEW public.topshot_set_squeeze_board
WITH (security_invoker = on) AS
 SELECT s.id AS set_id,
    s.name AS set_name,
    s.series,
    s.tier::text AS set_tier,
    count(*) AS editions_covered,
    round(avg(b.squeeze_pct), 1) AS avg_squeeze_pct,
    round(percentile_cont(0.5::double precision) WITHIN GROUP (ORDER BY (b.squeeze_pct::double precision))::numeric, 1) AS median_squeeze_pct,
    round(max(b.squeeze_pct), 1) AS max_squeeze_pct,
    round(min(b.squeeze_pct), 1) AS min_squeeze_pct,
    sum(b.circulation)::integer AS total_circ,
    sum(b.locked)::integer AS total_locked,
    sum(b.burned)::integer AS total_burned,
    sum(b.effectively_buyable)::integer AS total_buyable,
    round(avg(b.fmv_usd) FILTER (WHERE b.fmv_usd IS NOT NULL), 2) AS avg_fmv_usd,
    count(*) FILTER (WHERE b.fmv_usd IS NOT NULL) AS fmv_covered_editions
   FROM topshot_squeeze_board b
     JOIN sets s ON s.id = b.set_id
  WHERE s.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
  GROUP BY s.id, s.name, s.series, s.tier
 HAVING count(*) >= 5
  ORDER BY (avg(b.squeeze_pct)) DESC NULLS LAST;
