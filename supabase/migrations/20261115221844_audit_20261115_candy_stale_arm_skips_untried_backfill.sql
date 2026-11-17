-- audit_20261115_candy_stale_arm_skips_untried_backfill
--
-- WHY (Claude Code cloud, 2026-11-15 ~2:15 PM PT; inbox 2026-11-15T1604Z candidate 1). candy_sales_stale_hours sits at
-- breach_at 0 through its "indexer unhealthy" arm (> 50 unresolved Candy sales parked in 48 h) while the indexer is
-- healthy: every row it counts is a DELIBERATE history backfill parked `queued_collections_walk` (the 11-14 legacy-
-- collections Magic Eden walk + the 2,529 validated ME sales parked 11-15 8:15 AM PT). Read ~2:10 PM PT: 5,567 open
-- queued rows, ALL attempts = 1, all first_seen < 48 h; candy-sales-indexer ok every tick and resolving its full
-- DRAIN_LIMIT (300/tick, hourly since 11-15 11:00 AM PT). A permanently lit arm during a planned drain teaches the
-- operator to skim the board (the UFC 08-08 / Candy 10-28 lesson).
--
-- DISCRIMINATOR (read in app/api/candy-sales-indexer/route.ts drain loop): a row the drain TRIES and cannot write is
-- re-parked through candy_park_unresolved_sale with its NEW reason (edition_not_ingested, insert_failed:*, ...) and
-- attempts + 1; a written / duplicate / terminal row is closed (resolved_at set). So skip_reason =
-- 'queued_collections_walk' AND attempts <= 1 is exactly "parked by the backfill, not yet tried by the drain". Those
-- rows leave the > 50 count. Every row the drain has tried and failed still counts, under its new reason.
--
-- NEW STALL ARM (so excluding them cannot hide a dead drain): breach_at 0 when untried backfill rows have waited
-- > 6 h AND no parked row of any reason has resolved in 6 h. The 7 h "no ok run" arm still catches a dead indexer;
-- this catches an indexer that runs ok but drains nothing. 6 h = two ticks at the restored 3-hourly cadence.
--
-- Only two fragments change (the count predicate + its description); live definition md5 asserted, each fragment
-- asserted exactly once and gone after; security_invoker re-specified.
--
-- REVERT: the same DO block with old/new swapped (guard md5 = the post-change definition, recorded in the ledger).

DO $$
DECLARE
  d text := pg_get_viewdef('public.v_rpc_trust_health'::regclass, true);
  o1 text := $o$WHERE u.resolved_at IS NULL AND u.first_seen_at > (now() - '48:00:00'::interval))) > 50 THEN 0::numeric$o$;
  n1 text := $n$WHERE u.resolved_at IS NULL AND u.first_seen_at > (now() - '48:00:00'::interval) AND NOT (u.skip_reason = 'queued_collections_walk'::text AND u.attempts <= 1))) > 50 THEN 0::numeric
                    WHEN (EXISTS ( SELECT 1
                       FROM candy_sales_unresolved q
                      WHERE q.resolved_at IS NULL AND q.skip_reason = 'queued_collections_walk'::text AND q.attempts <= 1 AND q.first_seen_at < (now() - '06:00:00'::interval))) AND COALESCE(( SELECT max(r.resolved_at) AS max
                       FROM candy_sales_unresolved r), '-infinity'::timestamp with time zone) < (now() - '06:00:00'::interval) THEN 0::numeric$n$;
  o2 text := $o$OR more than 50 new unresolved Candy sales parked in 48h)$o$;
  n2 text := $n$OR more than 50 new unresolved Candy sales parked in 48h, NOT counting backfill rows parked queued_collections_walk that the drain has not tried yet (attempts <= 1; since 2026-11-15: a deliberate history walk is not an unhealthy indexer; a row the drain tried and failed is re-parked under its new reason and still counts); OR untried backfill rows have waited over 6h while no parked row has resolved in 6h, i.e. the drain stalled)$n$;
  n int;
BEGIN
  IF md5(d) <> 'e23f6a858dd4d000e7acfc85c2c5e5f5' THEN
    RAISE EXCEPTION 'v_rpc_trust_health drifted (md5 %); re-derive before replacing', md5(d);
  END IF;
  n := (length(d) - length(replace(d, o1, ''))) / length(o1);
  IF n <> 1 THEN RAISE EXCEPTION 'expected the Candy parked-count predicate exactly once, found %', n; END IF;
  n := (length(d) - length(replace(d, o2, ''))) / length(o2);
  IF n <> 1 THEN RAISE EXCEPTION 'expected the Candy arm description fragment exactly once, found %', n; END IF;
  EXECUTE 'CREATE OR REPLACE VIEW public.v_rpc_trust_health WITH (security_invoker = on) AS ' || replace(replace(d, o1, n1), o2, n2);
  d := pg_get_viewdef('public.v_rpc_trust_health'::regclass, true);
  IF position(o1 in d) > 0 OR position(o2 in d) > 0 THEN
    RAISE EXCEPTION 'v_rpc_trust_health was not rewritten';
  END IF;
END $$;
