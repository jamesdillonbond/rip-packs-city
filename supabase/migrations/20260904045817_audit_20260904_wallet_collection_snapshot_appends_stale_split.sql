-- audit_20260904_wallet_collection_snapshot_appends_stale_split
-- Applied to prod via MCP apply_migration 2026-09-04 04:58Z (version 20260904045817).
--
-- FINDING (2026-09-04 new-user walk): the front door (/share/<wallet>, backed by this RPC) headlined
-- the RAW wmc.fmv_usd sum — $98,325 for the founder's wallet — while the dashboard and public profile
-- the same collector signs up into say $47,641 + $52,005 across 366 stale-priced moments (the 09-02
-- decision: public headline = total − stale, migrations 20260903023012 / 20260903142035). A collector
-- who runs the front door and then signs up watched their number halve.
--
-- FIX: APPEND `staleFmv` (sum of fmv_usd over Moments whose edition's CURRENT confidence is STALE,
-- closed markets excluded exactly like totalFmv) and `staleCount` (all Moments, closed included, so the
-- caption's count matches the profile's). Confidence is read the sanctioned way (editions →
-- edition_fmv_current), never wmc.fmv_confidence (a lagging denorm). `totalFmv` keeps its meaning;
-- the page subtracts, exactly as the profile does, so the two cannot drift again.
--
-- MEASURED (EXPLAIN ANALYZE BUFFERS, the 19,403-Moment wallet): the stale CTE adds ~10.1K buffers,
-- nearly all hits (the planner drives from the 3,067 STALE editions, not the wallet); the wmc index
-- scan that dominates the function is unchanged. Result on that wallet: staleFmv 50,695 / staleCount
-- 367 — the same split the dashboard shows. Empty-wallet control: 0.00 / 0.
-- anon-exec: unchanged (get_wallet_collection_snapshot) — splice; stays postgres/service_role only.
--
-- REVERT: the same two-anchor block with v_old/v_new swapped.
DO $mig$
DECLARE v_def text; v_def2 text; v_hits int;
  v_old1 text := $o1$  rarest AS ($o1$;
  v_new1 text := $n1$  -- 2026-09-04: stale split, so the front door can headline total − stale like the profile
  stale AS (
    SELECT
      round(COALESCE(sum(w.fmv_usd) FILTER (
        WHERE w.collection_id NOT IN (SELECT id FROM collections WHERE market_closed_at IS NOT NULL)
      ), 0)::numeric, 2) AS stale_fmv,
      count(*)::int AS stale_count
    FROM w
    JOIN editions e ON e.external_id = w.edition_key AND e.collection_id = w.collection_id
    JOIN edition_fmv_current l ON l.edition_id = e.id
    WHERE l.confidence = 'STALE'
  ),
  rarest AS ($n1$;
  v_old2 text := $o2$    'rarest', (SELECT obj FROM rarest)$o2$;
  v_new2 text := $n2$    'rarest', (SELECT obj FROM rarest),
    'staleFmv', COALESCE((SELECT stale_fmv FROM stale), 0),
    'staleCount', COALESCE((SELECT stale_count FROM stale), 0)$n2$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='get_wallet_collection_snapshot';
  IF v_def IS NULL THEN RAISE EXCEPTION 'get_wallet_collection_snapshot not found'; END IF;
  v_hits := (length(v_def) - length(replace(v_def, v_old1, ''))) / length(v_old1);
  IF v_hits <> 1 THEN RAISE EXCEPTION 'anchor 1: expected 1 occurrence, found %', v_hits; END IF;
  v_hits := (length(v_def) - length(replace(v_def, v_old2, ''))) / length(v_old2);
  IF v_hits <> 1 THEN RAISE EXCEPTION 'anchor 2: expected 1 occurrence, found %', v_hits; END IF;
  v_def2 := replace(replace(v_def, v_old1, v_new1), v_old2, v_new2);
  IF v_def2 = v_def THEN RAISE EXCEPTION 'replacement was a no-op'; END IF;
  EXECUTE v_def2;
END $mig$;
