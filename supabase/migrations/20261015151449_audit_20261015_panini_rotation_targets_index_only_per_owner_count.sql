-- 2026-10-15 (Claude Code cloud, ~8:20 AM PT). panini_collector_rotation_targets: 36 s / ~594k buffers
-- (~4.6 GB) + a temp spill to return 6 rows, once a day from the Panini collector walk's `rotation` op.
-- It hit 57014 statement_timeout on 10-08 and 10-15 (Vercel runtime errors on
-- /api/cron/panini-collector-walk, both just before the day's first walk heartbeat).
--
-- CAUSE: the body aggregated EVERY panini_card_serials row (3.4M, 6.4 GB) by lower(owner) before
-- joining to the ~8.7k candidate usernames, of which 322 own any Panini card.
--
-- FIX (two halves):
--  1. idx_panini_serials_owner_lower_incl = the existing idx_panini_serials_owner_lower key and
--     predicate plus INCLUDE (owner), so a per-owner count + min(owner) is an INDEX-ONLY scan
--     (the table is ~98% all-visible). The expression-only index cannot serve one: the planner
--     needs `owner` itself. RECORD-ONLY here, following 20260919141500: it was built live by a
--     one-statement pg_cron job (CREATE INDEX CONCURRENTLY, 79 s, 114 MB, indisvalid = true) under
--     the database.md recipe — self-restoring net armed first, `ALTER ROLE postgres IN DATABASE
--     postgres SET statement_timeout='1800s'` for ~2 min, RESET as soon as the build had logged in,
--     job parked then unscheduled; role settings verified back to the single ALL-DATABASES
--     search_path row; 0 helper jobs left. The statement below is a no-op against it and the
--     correct non-concurrent form for a fresh database.
--  2. The function drives from the candidate usernames and counts each one's cards with a LATERAL
--     on that index, instead of aggregating the whole table first.
--
-- MEASURED (EXPLAIN ANALYZE BUFFERS, LIMIT 6): before 593,854 buffers + temp 10.5k, 35,964 ms;
-- after 46,949 buffers, 3,331 ms cold, Index Only Scan (7,389 heap fetches). EQUIVALENCE: the live
-- body and this body returned the same 50 rows in the same order (p_limit 50, 0 differences).
--
-- STILL OWED: the redundant idx_panini_serials_owner_lower (39 MB) — every query it served is served
-- by the new index (same key, same predicate). Dropping it is a DROP (MCP-held): see
-- docs/pending-sql/audit_20261015_drop_redundant_panini_owner_lower_index.sql.
--
-- anon-exec: intentional — same signature, so the 20260929015334 ACL (service_role only) is preserved (panini_collector_rotation_targets)
--
-- REVERT: re-apply the function body of 20260929015334 verbatim; the index can stay (harmless) or
--   `DROP INDEX CONCURRENTLY IF EXISTS public.idx_panini_serials_owner_lower_incl;` from a
--   one-statement pg_cron job.

SET LOCAL lock_timeout = '3s';

CREATE INDEX IF NOT EXISTS idx_panini_serials_owner_lower_incl
  ON public.panini_card_serials USING btree (lower(owner)) INCLUDE (owner)
  WHERE (owner <> ''::text);

CREATE OR REPLACE FUNCTION public.panini_collector_rotation_targets(p_limit integer)
RETURNS TABLE (username text, nickname text, cards_seen bigint, last_walk_at timestamptz)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH ts AS (
    SELECT lower(u.username) AS u FROM wallet_usernames u WHERE u.username IS NOT NULL
    UNION
    SELECT lower(sw.username) FROM seeded_wallets sw WHERE sw.username IS NOT NULL
  ), cand AS (
    SELECT ts.u, w.last_walk_at
    FROM ts
    LEFT JOIN panini_collector_walks w ON w.username = ts.u
    WHERE length(ts.u) >= 5
      AND ts.u ~ '^[a-z0-9_.-]{2,16}$'
      AND (w.last_walk_at IS NULL OR w.last_walk_at < now() - interval '20 hours')
  )
  SELECT c.u, x.nickname, x.cards_seen, c.last_walk_at
  FROM cand c
  CROSS JOIN LATERAL (
    SELECT min(s.owner) AS nickname, count(*) AS cards_seen
    FROM panini_card_serials s
    WHERE lower(s.owner) = c.u AND s.owner <> ''
  ) x
  WHERE x.cards_seen > 0
  ORDER BY c.last_walk_at NULLS FIRST, x.cards_seen DESC, c.u
  LIMIT greatest(0, least(coalesce(p_limit, 0), 50))
$$;
