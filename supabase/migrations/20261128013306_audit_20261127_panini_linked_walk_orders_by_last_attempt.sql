-- audit_20261127_panini_linked_walk_orders_by_last_attempt
--
-- 2026-11-27 (PT, ~5:40 PM; Claude Code cloud, autonomous pass; Trevor: "Figure it out").
--
-- WHY. The linked-username walk (scripts/panini-collector-walk-linked.bat on Trevor's box, every 2 h) asks
-- `plan` for its targets, and panini_collector_walk_targets() orders them by panini_collector_walks.last_walk_at
-- -- a column written ONLY when a walk POSTS its result. A walk that hangs never posts, so its collector keeps
-- the oldest last_walk_at and is planned FIRST again. Live 11-27: joesplosion's walk started 3:52 PM PT (the
-- batch's 8th, at minute 32.6) and never posted -- the 42-min hard watchdog killed it, so it ran > 9 min against
-- a 4-min cap, i.e. it hung -- and at 5:20 PM PT joesplosion was planned first and hung again (heartbeat
-- "started", no result 10+ min later, no further walk). Each batch then spends its whole 42 min on one hung walk
-- and the other 14 linked collectors are never read: one bad profile starves the lane, indefinitely.
--
-- WHAT. Order by the LATER of the last posted walk and the last ATTEMPT -- the walk's own "started" heartbeat,
-- which the route records BEFORE every walk (pipeline_runs `panini-collector-walk-heartbeat`, extra.username;
-- 336 rows in 3 days, inside the ~73 h retention). A collector whose walk was attempted and never finished goes
-- to the back of the line instead of the front; a collector never attempted still goes first. Filters, columns
-- and the returned last_complete_at are unchanged (the route maps them as before). Base md5 asserted
-- (674b85dfbc5138984054e811071186e5). The hang itself is in the box-side script (not reachable from a cloud
-- session); this removes the starvation, which is the part that cost every other collector their walk.
--
-- anon-exec: unchanged (panini_collector_walk_targets) — CREATE OR REPLACE of an existing fn; ACL preserved.
-- REVERT: re-apply 20261111034703_audit_20261110_panini_linked_walk_skips_a_missing_profile_for_a_day.sql.

SET LOCAL lock_timeout = '3s';

DO $mig$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.panini_collector_walk_targets()'::regprocedure)
     IS DISTINCT FROM '674b85dfbc5138984054e811071186e5' THEN
    RAISE EXCEPTION 'base drifted: panini_collector_walk_targets is not the 20261111034703 body';
  END IF;
END
$mig$;

CREATE OR REPLACE FUNCTION public.panini_collector_walk_targets()
RETURNS TABLE(username text, nickname text, last_complete_at timestamp with time zone)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH attempts AS (
    -- 2026-11-27: the walk's own "started" heartbeat, so a walk that hangs (and never posts) still counts
    SELECT lower(btrim(h.extra ->> 'username')) AS username, max(h.started_at) AS last_attempt_at
    FROM pipeline_runs h
    WHERE h.pipeline = 'panini-collector-walk-heartbeat'
      AND h.started_at > now() - interval '3 days'
      AND h.extra ? 'username'
    GROUP BY 1
  )
  SELECT t.username, t.nickname, t.last_complete_at
  FROM (
    SELECT DISTINCT ON (lower(btrim(s.identity_value)))
           lower(btrim(s.identity_value)) AS username, btrim(s.identity_value) AS nickname,
           w.last_complete_at, w.last_walk_at, a.last_attempt_at
    FROM saved_collector_identities s
    LEFT JOIN panini_collector_walks w ON w.username = lower(btrim(s.identity_value))
    LEFT JOIN attempts a ON a.username = lower(btrim(s.identity_value))
    WHERE s.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'
      AND s.identity_kind = 'username'
      AND lower(btrim(s.identity_value)) ~ '^[a-z0-9_.-]{2,16}$'
      -- 2026-11-10: a name whose last walk found NO profile waits 24 h before the next try.
      AND NOT COALESCE(w.profile_state = 'not_found' AND w.last_walk_at > now() - interval '24 hours', false)
    ORDER BY lower(btrim(s.identity_value)), s.created_at
  ) t
  ORDER BY greatest(t.last_walk_at, t.last_attempt_at) ASC NULLS FIRST, t.last_complete_at ASC NULLS FIRST, t.username
$$;
