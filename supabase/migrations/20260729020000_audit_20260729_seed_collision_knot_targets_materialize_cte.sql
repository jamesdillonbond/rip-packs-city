-- 2026-07-29 — fix `drain-conflated-subeditions` step 1d timing out on 100% of runs.
--
-- ROOT CAUSE (measured, not assumed): the mis-key set X was an inline subquery, so the
-- planner was free to invert the join order. It estimated the driving
-- `editions ey` regexp filter at 159 rows (ACTUAL 12,986 — an 82x underestimate),
-- chose nested loops, and probed `moments` through
-- moments_edition_id_serial_number_key with ONLY `serial_number` bound — the
-- TRAILING column of that composite index, which degenerates to a full index scan
-- per outer row (cost 4,337 each). >120s even with LIMIT 5.
--
-- FIX: materialize X first (the same decoupling the sibling
-- resolve_topshot_subedition_collision_knots already does with a temp table).
-- The outer join then probes moments on BOTH index columns.
-- Measured: >120,000 ms (timeout, 0 rows) -> 1,048 ms returning 96 real rows.
--
-- Semantics are otherwise byte-identical: same signature, same filters, same
-- DISTINCT, same LIMIT greatest(1, p_limit), same ON CONFLICT DO NOTHING.
--
-- Revert: restore the prior body (inline subquery instead of the MATERIALIZED CTE).

CREATE OR REPLACE FUNCTION public.seed_topshot_collision_knot_targets(p_limit integer DEFAULT 200)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_ts uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  n integer := 0;
BEGIN
  WITH x AS MATERIALIZED (
    -- resolved, mis-keyed X whose on-chain-correct target edition exists.
    -- MATERIALIZED is load-bearing: without it the planner inverts the join and
    -- probes `moments` on serial_number alone (trailing composite-index column).
    SELECT c.nft_id, c.serial_number, tgt.id AS correct_ed
    FROM (
      SELECT m.nft_id, m.serial_number, m.edition_id,
             e.external_id AS cur_ext, split_part(e.external_id,'::',1) AS base
      FROM moments m JOIN editions e ON e.id = m.edition_id
      WHERE m.collection_id = v_ts
    ) c
    JOIN topshot_moment_subeditions s
      ON s.nft_id = c.nft_id AND s.subedition_id IS NOT NULL AND s.base_external_id = c.base
    JOIN editions tgt
      ON tgt.collection_id = v_ts
     AND tgt.external_id = (CASE WHEN s.subedition_id = 0 THEN s.base_external_id
                                 ELSE s.base_external_id || '::' || s.subedition_id END)
    WHERE c.cur_ext <> (CASE WHEN s.subedition_id = 0 THEN s.base_external_id
                             ELSE s.base_external_id || '::' || s.subedition_id END)
  )
  INSERT INTO topshot_moment_subeditions (nft_id, base_external_id, subedition_id)
  SELECT DISTINCT ym.nft_id, split_part(ey.external_id,'::',1), NULL::smallint
  FROM x
  JOIN moments ym
    ON ym.edition_id = x.correct_ed AND ym.serial_number = x.serial_number
   AND ym.nft_id <> x.nft_id AND ym.collection_id = v_ts
  JOIN editions ey ON ey.id = ym.edition_id
  WHERE NOT EXISTS (SELECT 1 FROM topshot_moment_subeditions t WHERE t.nft_id = ym.nft_id)
    AND ym.nft_id ~ '^[0-9]+$'
    AND split_part(ey.external_id,'::',1) ~ '^[0-9]+:[0-9]+$'
  LIMIT greatest(1, p_limit)
  ON CONFLICT (nft_id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$function$;
