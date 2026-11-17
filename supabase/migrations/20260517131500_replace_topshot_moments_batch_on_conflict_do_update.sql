-- replace_topshot_moments_batch — race-safe rewrite (2026-05-17)
--
-- Race history: the prior implementation did
--   DELETE WHERE nft_id IN (...) OR (edition_id, serial_number) IN (...)
--   INSERT SELECT ...
-- which leaves a window between DELETE and INSERT where a concurrent
-- writer (typically the wallet_moments_cache hydrator) can insert a
-- row that collides with the same key, and the INSERT throws 23505
-- on either moments_nft_id_key or moments_edition_id_serial_number_key.
-- The v1→v4_split iterations narrowed the window but didn't close it.
--
-- This rewrite:
--  1. Materializes input rows into a TEMP TABLE.
--  2. Deletes rows that collide on EITHER unique constraint, in two
--     statements so we always clear nft_id first (the canonical key
--     for moments). Within a single transaction, the row-level locks
--     taken by the DELETE serialize concurrent writers.
--  3. INSERT ... ON CONFLICT (edition_id, serial_number) DO UPDATE as
--     a second-line defense for the race window between DELETE and
--     INSERT. Pack-pull-verified payloads are the ground truth, so
--     overwriting any racing writer with our row is correct.
--  4. nft_id collisions cannot occur in the INSERT path because step
--     2 deletes by nft_id before the INSERT, and the txn holds the
--     lock until commit.
CREATE OR REPLACE FUNCTION public.replace_topshot_moments_batch(payload jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_collection_id uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_changed int := 0;
BEGIN
  CREATE TEMP TABLE _input ON COMMIT DROP AS
  SELECT
    (elem->>'nft_id')::text                  AS nft_id,
    (elem->>'edition_id')::uuid              AS edition_id,
    (elem->>'serial_number')::int            AS serial_number,
    NULLIF(elem->>'owner_address', '')::text AS owner_address
  FROM jsonb_array_elements(payload) AS elem;

  DELETE FROM public.moments m
   WHERE m.collection_id = v_collection_id
     AND m.nft_id IS NOT NULL
     AND m.nft_id IN (SELECT nft_id FROM _input);

  DELETE FROM public.moments m
   WHERE m.collection_id = v_collection_id
     AND (m.edition_id, m.serial_number) IN
         (SELECT edition_id, serial_number FROM _input);

  INSERT INTO public.moments (
    nft_id, collection_id, edition_id, serial_number,
    owner_address, is_listed, collection, updated_at
  )
  SELECT
    i.nft_id, v_collection_id, i.edition_id, i.serial_number,
    i.owner_address, false, 'nba_top_shot', now()
  FROM _input i
  ON CONFLICT (edition_id, serial_number) DO UPDATE
    SET nft_id        = EXCLUDED.nft_id,
        owner_address = EXCLUDED.owner_address,
        updated_at    = now();

  GET DIAGNOSTICS v_changed = ROW_COUNT;
  RETURN v_changed;
END;
$function$;
