-- audit_20260902_allday_scarcity_board_latest_fmv_from_edition_fmv_current
--
-- Closes deep-audit register R50. The board's `latest_fmv` CTE still ran
-- `DISTINCT ON (edition_id) … ORDER BY computed_at DESC` over EVERY AllDay
-- fmv_snapshots row (417,577 rows on 2026-09-03) to pick 6,190 latest — the 08-10
-- migration's own header called it "STILL OVER BUDGET" and named the durable fix
-- as "the standing materialize-latest-FMV-per-edition item". That item exists:
-- `edition_fmv_current` (a table, refreshed hourly by refresh_edition_fmv_current,
-- keyed by edition_id, carries collection_id), already the source for
-- get_series_editions / get_series_rollups / get_topshot_sniper_deals /
-- get_market_summary, and sanctioned by docs/reference/database.md as a DISPLAY
-- source. This board only DISPLAYS fmv_usd / confidence (and sorts on fmv_usd when
-- asked); no filter predicate reads them, which is the one case database.md marks
-- unsafe.
--
-- EVIDENCE (register R50): 12 days of public_board_liveness_history to 08-23 —
-- 86.1% of samples over the 8,300 ms budget, p50 23,429 ms, max 725 s; 08-27
-- re-measure p50 169 s at 18Z.
--
-- MEASURED 2026-09-03 05:5xZ, warm, the page's REAL SELECT (13 columns,
-- family_size >= 3, scarcity > 0, ORDER BY scarcity DESC, LIMIT 50):
--   before: shared hit=22,742 read=1 — 19,969 of them the Merge Append -> Unique
--           over 417,577 snapshot rows (15,528 heap fetches), 174 ms
--   after:  shared hit=8,888 read=207 — a per-row PK probe into
--           edition_fmv_current (6,114 + 207), 134 ms
--   => -60% buffers warm, and the part that balloons under IO saturation (the
--      snapshot scan) is gone entirely. Cold numbers are NOT quoted: the
--      saturation regime confounds timings both ways.
--
-- SAME-SNAPSHOT SET DIFF over all 6,190 in-scope editions, one statement:
--   old_priced 6,190 · new_priced 6,190 · fmv differs 11 (max |Δ| $47.70) ·
--   confidence differs 6 — all bounded by the hourly refresh (efc was 51 min
--   old at the time). Nothing is dropped; a value can lag by up to an hour.
--   Accepted: the sniper and series pages already show this same source.
--
-- ⚠ CREATE OR REPLACE VIEW with no WITH clause RESETS reloptions and strips
-- security_invoker (four prior occurrences) — re-asserted explicitly below.
-- No column / type / order change (CREATE OR REPLACE VIEW cannot do that, 42P16).
-- No grant change.
--
-- LIVENESS PROBE caveat carries over from 08-10: the probe times count(*),
-- which the planner prunes past the LEFT JOIN either way, so the arm cannot
-- see this change; verify on the page's real SELECT and on the next
-- public_board_liveness_history samples read with that caveat in mind.
--
-- REVERT: re-apply supabase/migrations/20260810185031_audit_20260810_allday_scarcity_board_latest_fmv_setbased.sql

CREATE OR REPLACE VIEW public.allday_scarcity_board
WITH (security_invoker = on) AS
WITH family_avg AS (
  SELECT editions.set_name,
         editions.tier,
         avg(editions.circulation_count) AS family_avg_mint,
         count(*) AS family_size
  FROM editions
  WHERE editions.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
    AND editions.circulation_count IS NOT NULL
    AND editions.circulation_count > 0
    AND editions.set_name IS NOT NULL
  GROUP BY editions.set_name, editions.tier
), latest_fmv AS (
  -- Materialised latest-per-edition (hourly). Was a DISTINCT ON over every
  -- AllDay snapshot row; see header.
  -- Cast keeps the view column type numeric(12,4) (fmv_snapshots.fmv_usd's
  -- type) — CREATE OR REPLACE VIEW refuses a column type change (42P16), and
  -- edition_fmv_current.fmv_usd is bare numeric.
  SELECT efc.edition_id,
         efc.fmv_usd::numeric(12,4) AS fmv_usd,
         efc.confidence
  FROM edition_fmv_current efc
  WHERE efc.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
)
SELECT e.external_id,
       e.player_name,
       e.set_name,
       e.tier::text AS tier,
       e.team_name,
       e.series,
       e.circulation_count AS mint_count,
       round(fa.family_avg_mint, 0) AS family_avg_mint,
       fa.family_size,
       round(100.0 * (1::numeric - e.circulation_count::numeric / NULLIF(fa.family_avg_mint, 0::numeric)), 1) AS scarcity_vs_family_pct,
       latest.fmv_usd,
       latest.confidence::text AS fmv_confidence,
       e.thumbnail_url,
       e.video_url
FROM editions e
JOIN family_avg fa
  ON fa.set_name = e.set_name
 AND NOT fa.tier IS DISTINCT FROM e.tier
LEFT JOIN latest_fmv latest ON latest.edition_id = e.id
WHERE e.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
  AND e.circulation_count IS NOT NULL
  AND e.circulation_count > 0
  AND e.set_name IS NOT NULL;
