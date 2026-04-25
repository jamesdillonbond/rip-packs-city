-- Dual-format Top Shot edition lookup.
--
-- Background: Top Shot editions live in `editions` under two different
-- `external_id` shapes — historical rows use the integer-pair "setID:playID"
-- format (e.g. "84:2892") while newer rows use UUID-style external_ids. A
-- single literal-match RPC therefore misses ~half the table whenever a caller
-- supplies a key in the opposite format. The pack-EV pipeline hit this gap
-- when joining drop-pool edition keys against `editions`.
--
-- This rewrite gives the function two match paths:
--   1. Literal match on `external_id` (covers UUID-format rows and any
--      already-stored "setID:playID" literals).
--   2. Onchain fallback: when the requested key parses as "<int>:<int>",
--      match against `set_id_onchain + play_id_onchain`. Catches integer-pair
--      keys whose `external_id` is stored in UUID form.
-- Both paths are scoped to the NBA Top Shot collection. Literal matches win
-- ties via priority ordering so existing behavior is preserved.
--
-- Mirrors production version 20260425193430 (apply_migration deploy).

CREATE OR REPLACE FUNCTION public.get_topshot_editions_by_setplay(p_keys text[])
 RETURNS TABLE(external_id text, edition_id uuid, tier text)
 LANGUAGE sql
 STABLE
AS $function$
  WITH input_keys AS (
    SELECT
      k AS requested_key,
      -- Parse "set:play" pair into integers if possible
      CASE WHEN k ~ '^[0-9]+:[0-9]+$'
        THEN split_part(k, ':', 1)::int
        ELSE NULL
      END AS req_set_id,
      CASE WHEN k ~ '^[0-9]+:[0-9]+$'
        THEN split_part(k, ':', 2)::int
        ELSE NULL
      END AS req_play_id
    FROM unnest(p_keys) AS k
  ),
  -- Match path 1: literal external_id match
  literal_matches AS (
    SELECT ik.requested_key, e.id AS edition_id, e.tier::text AS tier, 1 AS priority
    FROM input_keys ik
    JOIN editions e
      ON e.external_id = ik.requested_key
      AND e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
  ),
  -- Match path 2: onchain ID fallback for integer-format keys
  onchain_matches AS (
    SELECT ik.requested_key, e.id AS edition_id, e.tier::text AS tier, 2 AS priority
    FROM input_keys ik
    JOIN editions e
      ON e.set_id_onchain = ik.req_set_id
      AND e.play_id_onchain = ik.req_play_id
      AND e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
    WHERE ik.req_set_id IS NOT NULL
  ),
  -- Combine + dedupe by priority (literal wins ties)
  combined AS (
    SELECT * FROM literal_matches
    UNION ALL
    SELECT * FROM onchain_matches
  ),
  ranked AS (
    SELECT requested_key, edition_id, tier,
      row_number() OVER (PARTITION BY requested_key ORDER BY priority) AS rn
    FROM combined
  )
  SELECT requested_key AS external_id, edition_id, tier
  FROM ranked
  WHERE rn = 1;
$function$;
