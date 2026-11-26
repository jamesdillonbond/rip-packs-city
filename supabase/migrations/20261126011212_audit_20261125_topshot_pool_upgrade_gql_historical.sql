-- 2026-11-25: sync_topshot_pools_from_atlas upgraded a pool only when EVERY row was pool_source 'gql'.
-- Pools written by the 08-28 historical GraphQL lane carry 'gql_historical', so 1,161 dists matched none of
-- fill / upgrade / refresh and were frozen at their 08-28 weights. 59 of them have a fresh Atlas edition list
-- with packs left to draw (6 serve a live Pack EV today, e.g. dist 8603, 2464): their EV weighted a 3-month-old
-- pool and ignored parallels Atlas lists (Blockchain ::17 pulls on 8603 never in the pool).
-- Change: the upgrade arm treats 'gql_historical' like 'gql'. Every existing gate (<= 5 % unmapped original,
-- remaining > 0, at least as many drawable editions as before) is unchanged, so a sold-out dist keeps its rows.
-- Splice is guarded: the old text must occur exactly once. Revert: re-apply with the two strings swapped.
DO $do$
DECLARE d text; o text := 'bool_and(pool_source = ''gql'') AS all_gql';
        n text := 'bool_and(pool_source IN (''gql'', ''gql_historical'')) AS all_gql';
BEGIN
  d := pg_get_functiondef('public.sync_topshot_pools_from_atlas(integer)'::regprocedure);
  IF (length(d) - length(replace(d, o, ''))) / length(o) <> 1 THEN
    RAISE EXCEPTION 'splice guard: expected exactly one occurrence';
  END IF;
  EXECUTE replace(d, o, n);
END
$do$;