-- P8 root fix (repo-sync of MCP migration audit_20260702_replace_topshot_moments_batch_parallel_guard).
--
-- The topshot-moments-hydrator resolves editions by (set_id_onchain, play_id_onchain), which the
-- 2026-06-20 subedition catalog made NON-UNIQUE: base + every ::parallel were cloned with the same
-- on-chain id pair. The hydrator's `${set}:${play}` -> edition map is therefore overwritten by
-- whichever row PostgREST returns last, so a small-circ ::parallel can win and a Standard moment
-- lands on it (serial > parallel circ = impossible). This RPC is the write chokepoint for every
-- moments writer, so the guard lives here (mirrors the sales-indexer Step-4e + offer_fill
-- base-redirect guards): BEFORE dedupe, redirect any incoming moment on a ::parallel whose serial
-- exceeds that parallel's circulation to the BASE setID:playID edition. Genuine subedition moments
-- (serial <= parallel circ) pass through untouched; the submap-driven
-- remap_topshot_base_keyed_parallel_sales() splits genuine parallels later. When in doubt, base.
--
-- Verified live: end-to-end RPC probe (Standard serial 11 keyed onto 222:7443::20 circ 10) landed on
-- base 222:7443; negative replay 0/500 genuine parallels redirected; check_public_security_invariants() [].
-- Revert: restore the prior body from 20260517131500_replace_topshot_moments_batch_on_conflict_do_update.sql.
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
