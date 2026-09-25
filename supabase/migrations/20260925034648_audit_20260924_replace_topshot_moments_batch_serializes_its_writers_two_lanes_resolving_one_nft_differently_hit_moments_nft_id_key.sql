-- audit_20260924_replace_topshot_moments_batch_serializes_its_writers_two_lanes_resolving_one_nft_differently_hit_moments_nft_id_key
--
-- Applied from Cowork (cloud + laptop VM) 2026-09-24 8:46 PM PT as version 20260925034648.
--
-- WHY. `topshot-moments-hydrate-wmc` failed 1 of 216 runs on 09-24 and 3 of 68 on 09-20 with
-- `duplicate key value violates unique constraint "moments_nft_id_key"`, then succeeded on the very
-- next tick over the SAME page (the cursor does not advance on a failed tick). That is a race, not a
-- data defect. This RPC is the write chokepoint for every moments writer (the CF
-- topshot-moments-hydrator, hydrate_topshot_moments_from_wmc, the pg_net chain hydrator, the Atlas
-- lane), and two of them can resolve the SAME nft to DIFFERENT (edition_id, serial_number) rows at the
-- same moment: each caller's DELETE cannot see the other's uncommitted insert, and the INSERT's
-- ON CONFLICT arbiter is (edition_id, serial_number), so the second writer's row lands on the nft_id
-- unique index instead and raises 23505. Identical rows were already safe (the 2026-05-17 rewrite and
-- scripts/smoke-replace-topshot-moments-batch-concurrency.mjs cover same-(edition, serial)-different-nft).
--
-- REPRODUCED before the fix, on a throwaway Postgres 16 with the live body: session A writes nft X at
-- (E1, 1) and holds its transaction; session B writes nft X at (E2, 1) -> B raises 23505 on
-- moments_nft_id_key. With the lock: B waits ~1.5 s for A, then wins with its own resolution (the
-- sequential semantics), 0 errors; the 4-way same-(E,S)-different-nft control still lands exactly 1 row.
--
-- FIX. One statement at the top of the body: pg_advisory_xact_lock(hashtext('public.replace_topshot_moments_batch')).
-- Released at transaction end; batches are small (hundreds of rows), so the added wait is milliseconds.
-- Body otherwise byte-identical to 20260702150000 (P8 guard kept). COMMENT updated.
--
-- anon-exec: unchanged (replace_topshot_moments_batch) — CREATE OR REPLACE of an existing fn; ACL preserved, verified after apply: anon=false, authenticated=false, service_role=true (has_function_privilege). SECURITY DEFINER, search_path pinned public, pg_temp.
--
-- WATCH: topshot-moments-hydrate-wmc and the chain hydrator keep writing (ok=true, written>0) and the
-- 23505 never recurs. FALSIFIER: any lock wait visible as `pipeline_runs.extra->>'duration_ms'` growing
-- on the hydrators, or a deadlock naming this advisory lock.
-- REVERT: re-apply the body from 20260702150000_audit_20260702_replace_topshot_moments_batch_parallel_guard.sql
-- (drops the PERFORM line only).

CREATE OR REPLACE FUNCTION public.replace_topshot_moments_batch(payload jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_collection_id uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_changed int := 0;
BEGIN
  -- Serialize the writers. This RPC is the write chokepoint for every moments writer (the CF
  -- topshot-moments-hydrator, hydrate_topshot_moments_from_wmc, the pg_net chain hydrator, the Atlas
  -- lane). Two of them can resolve the SAME nft to DIFFERENT (edition_id, serial_number) rows at the
  -- same moment; each DELETE below cannot see the other's uncommitted insert, and the INSERT's arbiter
  -- is (edition_id, serial_number), so the second writer's row hits moments_nft_id_key instead
  -- (23505 — the 09-20 and 09-24 topshot-moments-hydrate-wmc failures; reproduced 2026-09-24 on a
  -- throwaway Postgres 16 with two sessions). Under the lock the second writer waits, its DELETE sees
  -- the first writer's committed row, and it wins exactly as the sequential path always did. Released
  -- at transaction end; batches are small, so the wait is milliseconds.
  PERFORM pg_advisory_xact_lock(hashtext('public.replace_topshot_moments_batch'));

  -- Parse the payload first
  CREATE TEMP TABLE _input_raw ON COMMIT DROP AS
  SELECT
    (elem->>'nft_id')::text                  AS nft_id,
    (elem->>'edition_id')::uuid              AS edition_id,
    (elem->>'serial_number')::int            AS serial_number,
    NULLIF(elem->>'owner_address', '')::text AS owner_address
  FROM jsonb_array_elements(payload) AS elem
  WHERE elem->>'edition_id' IS NOT NULL
    AND elem->>'serial_number' IS NOT NULL;

  -- Dedupe on the upsert conflict target (edition_id, serial_number).
  -- Tiebreak: prefer the lexicographically largest nft_id, which corresponds to
  -- the most recently minted NFT for that serial position. ALSO dedupe on
  -- nft_id so the same NFT id never lands in _input twice.
  -- P8 GUARD: the `redirected` CTE rewrites edition_id to base BEFORE dedupe, so
  -- any post-redirect (base, serial) collisions collapse here instead of tripping
  -- the INSERT ... ON CONFLICT "cannot affect row a second time" error.
  CREATE TEMP TABLE _input ON COMMIT DROP AS
  WITH redirected AS (
    SELECT
      r.nft_id,
      COALESCE(b.id, r.edition_id) AS edition_id,
      r.serial_number,
      r.owner_address
    FROM _input_raw r
    LEFT JOIN public.editions e ON e.id = r.edition_id
    LEFT JOIN public.editions b
           ON e.external_id ~ '::'
          AND e.circulation_count > 0
          AND r.serial_number > e.circulation_count
          AND b.collection_id = v_collection_id
          AND b.external_id = split_part(e.external_id, '::', 1)
  ),
  by_serial AS (
    SELECT DISTINCT ON (edition_id, serial_number)
      nft_id, edition_id, serial_number, owner_address
    FROM redirected
    ORDER BY edition_id, serial_number, nft_id DESC
  )
  SELECT DISTINCT ON (nft_id)
    nft_id, edition_id, serial_number, owner_address
  FROM by_serial
  ORDER BY nft_id, edition_id, serial_number;

  -- Clear nft_id-conflicting rows first (canonical key surface).
  DELETE FROM public.moments m
   WHERE m.collection_id = v_collection_id
     AND m.nft_id IS NOT NULL
     AND m.nft_id IN (SELECT nft_id FROM _input);

  -- Clear (edition_id, serial_number)-conflicting rows.
  DELETE FROM public.moments m
   WHERE m.collection_id = v_collection_id
     AND (m.edition_id, m.serial_number) IN
         (SELECT edition_id, serial_number FROM _input);

  -- UPSERT with race-window defense on (edition_id, serial_number).
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

COMMENT ON FUNCTION public.replace_topshot_moments_batch(jsonb) IS
'Idempotent batch replace for moments table. Uses temp table + separate DELETE/INSERT statements so the DELETE clears the unique-constraint conflict surface BEFORE the INSERT executes (CTE-only approaches do not work because CTE statements see a pre-statement snapshot of the table). Returns the integer count of rows inserted. Since 2026-09-24 the whole body runs under pg_advisory_xact_lock(hashtext(''public.replace_topshot_moments_batch'')): concurrent writers resolving one nft to different (edition, serial) rows used to fail on moments_nft_id_key, because the INSERT arbiter is (edition_id, serial_number); under the lock the later writer waits and wins.';
