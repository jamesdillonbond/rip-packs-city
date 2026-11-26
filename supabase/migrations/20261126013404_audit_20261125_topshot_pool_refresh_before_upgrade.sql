-- 2026-11-25 (follow-up to 20261126011212): sync_topshot_pools_from_atlas takes 400 candidates per hourly tick,
-- ordered fill -> upgrade -> refresh. Opening the upgrade arm to 'gql_historical' put 668 upgrade candidates in
-- the queue; those that fail a gate (> 5 % unmapped, fewer drawable editions) come back every tick ahead of the
-- ordinary Atlas refreshes, which could then be starved of the 400 slots. Order is now fill -> refresh ->
-- upgrade, so an already-Atlas pool with a newer edition list is always re-written first (refreshes are a
-- handful per hour). Guarded splice; revert = swap the strings.
DO $do$
DECLARE d text;
        o text := 'ORDER BY (pool.dist_id IS NULL) DESC, coalesce(pool.all_gql, false) DESC';
        n text := 'ORDER BY (pool.dist_id IS NULL) DESC, coalesce(pool.all_atlas AND lp.f > pool.refreshed, false) DESC, coalesce(pool.all_gql, false) DESC';
BEGIN
  d := pg_get_functiondef('public.sync_topshot_pools_from_atlas(integer)'::regprocedure);
  IF (length(d) - length(replace(d, o, ''))) / length(o) <> 1 THEN
    RAISE EXCEPTION 'splice guard: expected exactly one occurrence';
  END IF;
  EXECUTE replace(d, o, n);
END
$do$;