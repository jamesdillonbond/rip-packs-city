-- audit_20260903_candy_scarcity_board_materialize
--
-- `candy_scarcity_board` was the LAST live-scanning Candy board. Every read — the
-- /insights/candy-mlb page's fetchView AND the 6-hourly liveness probe — re-ran a
-- 25,375-row index-only scan of wallet_moments_cache (16,662 buffers, 2,230 heap
-- fetches, 1,085 ms on a quiet instance, EXPLAIN ANALYZE 2026-09-03 22:05Z). Under
-- the disk-IO contention this instance is documented to hit, that same scan read
-- 34 s (08-31), 46 s (08-30), 55 s (08-29) and 390 s (08-28) in
-- public_board_liveness_history — every one of them past the ~30 s page budget, so
-- the board rendered degraded while the arm `public_board_slow_count` flickered
-- BREACH/ok on ordinary variance (daytime-monitor filing 2026-09-03T181027Z).
--
-- ⚠ THE FILING'S SUGGESTED ACTION — raise this board's max_ms — IS REFUTED BY ITS OWN
-- HISTORY. The watchlist note says the budget was calibrated from "125 rows / 2ms";
-- the p50 has been 2.4–4 s on every day since 08-11 (n=4/day). A 3000 ms budget is not
-- "at the floor of ordinary variance" for a 2 ms board; the board stopped being a 2 ms
-- board. Widening the alarm would have hidden a 1,000x regression instead of fixing it.
--
-- Fix: the same shape already applied to its sibling on 2026-08-02
-- (audit_20260802_candy_holder_board_materialize) — an hourly MATERIALIZED VIEW behind
-- a wrapper view with byte-identical columns. A snapshot read is a 125-row scan; the
-- 16k-buffer aggregate runs once per hour at a quiet minute instead of on every page
-- view and every probe. Consumers keep reading `candy_scarcity_board` by name:
-- lib/insights/candy-board.ts (service role) and the liveness sweep.
--
-- Column list is copied verbatim from pg_get_viewdef so CREATE OR REPLACE VIEW cannot
-- hit 42P16 (it cannot rename or reorder). `security_invoker=on` is re-asserted AFTER
-- the replace because a CREATE OR REPLACE VIEW with no WITH clause resets reloptions.
-- Grants before: anon=false auth=false service=true on the view; kept identical, and
-- the MV gets the same REVOKE so it is not a wider surface than the view it backs.
--
-- Refresh: `26 * * * *` — measured free on the hourly grid (2026-09-03; the only job on
-- minute 26 in any schedule is none; minute 53 holds maint-vacuum-sales-hot-partition
-- at 10,20). 300 s statement_timeout per the #27 convention (jobs 352/353/354), not the
-- 600 s the 08-02 pattern used. Watchlisted in board_mv_refresh_watchlist at 6 h so a
-- dead refresh pages as STALE (the arm the MV pattern needs, per the holder-board note).
--
-- REVERT: DROP the wrapper's dependency by re-creating the live view from the body
-- below (same column list), then `SELECT cron.unschedule('rpc-refresh-candy-scarcity-board')`,
-- DELETE the board_mv_refresh_watchlist row, and DROP MATERIALIZED VIEW
-- public.mv_candy_scarcity_board. No data is lost either way — the MV is derived.

CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_candy_scarcity_board AS
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
         count(*) FILTER (WHERE w.wallet_address = (SELECT treas.wallet_address FROM treas))  AS sealed,
         count(*) FILTER (WHERE w.wallet_address <> (SELECT treas.wallet_address FROM treas)) AS circulating,
         count(DISTINCT w.wallet_address) FILTER (WHERE w.wallet_address <> (SELECT treas.wallet_address FROM treas)) AS holders
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

-- REFRESH ... CONCURRENTLY requires a unique index; external_id is the grain of the
-- Candy editions slice (one row per edition, 125 at creation).
CREATE UNIQUE INDEX IF NOT EXISTS mv_candy_scarcity_board_external_id_uidx
  ON public.mv_candy_scarcity_board (external_id);

CREATE OR REPLACE VIEW public.candy_scarcity_board AS
SELECT external_id,
       player_name,
       edition_name,
       tier,
       is_rainbow,
       circulation_count,
       sealed,
       circulating,
       circulating_pct,
       holders,
       fmv_usd,
       confidence
  FROM public.mv_candy_scarcity_board;

ALTER VIEW public.candy_scarcity_board SET (security_invoker = on);
REVOKE SELECT ON public.candy_scarcity_board FROM anon, authenticated;
REVOKE SELECT ON public.mv_candy_scarcity_board FROM anon, authenticated;

SELECT cron.schedule(
  'rpc-refresh-candy-scarcity-board', '26 * * * *',
  $$SET statement_timeout = '300s'; REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_candy_scarcity_board;$$
);

INSERT INTO public.board_mv_refresh_watchlist (matview_name, max_stale_hours, note)
VALUES ('mv_candy_scarcity_board', 6,
        'backs the /insights/candy-mlb Scarcity tab (candy_scarcity_board wrapper); pg_cron rpc-refresh-candy-scarcity-board 26 * * * *')
ON CONFLICT (matview_name) DO NOTHING;

UPDATE public.public_board_liveness_watchlist
   SET note = coalesce(note,'') || ' | materialized 2026-09-03 (mv_candy_scarcity_board, hourly at :26): '
              || 'the "125 rows / 2ms" this budget was calibrated from had been a 2.4-4 s p50 since 08-11 '
              || 'with a 390 s tail (public_board_liveness_history), so the 3000 ms floor was not noise '
              || '-- the board had regressed 1000x. max_ms stays 3000: a snapshot read is sub-ms, and a '
              || 'reading anywhere near 3 s again means the wrapper is no longer reading the MV.'
 WHERE view_name = 'candy_scarcity_board';
