-- FOURTH and final pass on candy_holder_board, and the first one that addresses
-- the COLD path rather than the warm one.
--   v1 scope the fmv_current join   82.3s -> 2.9s (only under ORDER BY..LIMIT 50)
--   v2 MATERIALIZED CTEs pin plan    40.8s
--   v3 single wmc scan + cover idx   13.4s cold / 1.2s warm
--   v4 (this)                        materialize -> sub-ms
--
-- Why v3 wasn't enough: 16,626 ms measured under refresher contention, over its
-- 15,000 ms liveness cap. I checked the obvious cause before acting and DISPROVED
-- it — `wallet_moments_cache` is 95.7% all-visible and was autovacuumed 1.5h ago,
-- so a VACUUM would not have helped. The residual ~10.7k heap fetches come from the
-- 4.3% of pages that are legitimately hot: wmc is 2,361 MB and written continuously
-- by the wallet-backfill family. Scanning 25,375 of its rows is simply not cheap,
-- and no index makes it cheap while the table is being written.
--
-- So the right move is the one already applied to the other slow public boards
-- today (market-index, perfect-mint-premiums, pack-reality x3): snapshot it. Holder
-- COMPOSITION changes slowly — it moves when a Candy NFT changes hands, not
-- continuously — so hourly freshness is appropriate for what this board asserts.
-- The alternative was raising the liveness cap a second time, which would have been
-- moving a threshold to fit a slow query instead of fixing the query.
CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_candy_holder_board AS
WITH held AS MATERIALIZED (
  SELECT wallet_address, edition_key
    FROM wallet_moments_cache
   WHERE collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
), treas AS MATERIALIZED (
  SELECT wallet_address FROM held GROUP BY wallet_address ORDER BY count(*) DESC LIMIT 1
), key_fmv AS MATERIALIZED (
  SELECT e.external_id::text AS edition_key, c.fmv_usd
    FROM editions e
    LEFT JOIN (
      SELECT DISTINCT ON (edition_id) edition_id, fmv_usd
        FROM fmv_snapshots
       WHERE collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
       ORDER BY edition_id, computed_at DESC
    ) c ON c.edition_id = e.id
   WHERE e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
)
SELECT h.wallet_address,
       count(*)                                      AS serials,
       count(DISTINCT h.edition_key)                 AS editions,
       round(sum(k.fmv_usd), 2)                      AS est_fmv_usd,
       count(*) FILTER (WHERE k.fmv_usd IS NOT NULL) AS priced_serials
  FROM held h
  LEFT JOIN key_fmv k ON k.edition_key = h.edition_key
 WHERE h.wallet_address <> (SELECT wallet_address FROM treas)
 GROUP BY h.wallet_address;

-- required for REFRESH ... CONCURRENTLY
CREATE UNIQUE INDEX IF NOT EXISTS mv_candy_holder_board_wallet_uidx
  ON public.mv_candy_holder_board (wallet_address);

-- The VIEW keeps its name, columns, security_invoker and grants, so the board's
-- consumer is unchanged — it just reads the snapshot now.
CREATE OR REPLACE VIEW public.candy_holder_board AS
SELECT wallet_address, serials, editions, est_fmv_usd, priced_serials
  FROM public.mv_candy_holder_board;

ALTER VIEW public.candy_holder_board SET (security_invoker = on);
REVOKE SELECT ON public.candy_holder_board FROM anon, authenticated;
REVOKE SELECT ON public.mv_candy_holder_board FROM anon, authenticated;

-- Hourly refresh at :47, clear of the existing :07/:12/:15/:17/:27/:42 refresh slots.
-- SET statement_timeout FIRST: pg_cron jobs inherit the postgres role's 120s cluster
-- default, NOT cron_heavy's 600s — a refresh silently died at exactly 120,000 ms today.
SELECT cron.schedule(
  'rpc-refresh-candy-holder-board', '47 * * * *',
  $$SET statement_timeout='600s'; REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_candy_holder_board;$$
);

-- Watchlist it so board_mv_refresh_stale_hours can see a dead/unscheduled refresh —
-- a materialized board fails as PLAUSIBLE STALE DATA, invisible to the row-count
-- and latency arms.
INSERT INTO public.board_mv_refresh_watchlist (matview_name, max_stale_hours, note)
VALUES ('mv_candy_holder_board', 6,
        'backs the /insights/candy-mlb Holders tab; pg_cron rpc-refresh-candy-holder-board 47 * * * *')
ON CONFLICT (matview_name) DO NOTHING;

-- Restore the liveness cap to something a snapshot read should never approach; the
-- 15,000 ms set earlier today was sized for the live-query cold path, which is gone.
UPDATE public.public_board_liveness_watchlist
   SET max_ms = 3000,
       note = coalesce(note,'') || ' | materialized 2026-08-02 (mv_candy_holder_board, hourly); '
              || 'cap returned 15000->3000 since a snapshot read is sub-ms — the earlier widening '
              || 'was sized for a live query that no longer runs.'
 WHERE view_name = 'candy_holder_board';

-- Revert:
--   SELECT cron.unschedule('rpc-refresh-candy-holder-board');
--   DELETE FROM public.board_mv_refresh_watchlist WHERE matview_name='mv_candy_holder_board';
--   UPDATE public.public_board_liveness_watchlist SET max_ms=15000 WHERE view_name='candy_holder_board';
--   -- then re-apply the v3 live-query view body from audit_20260801_candy_holder_board_single_wmc_scan
--   DROP MATERIALIZED VIEW public.mv_candy_holder_board;