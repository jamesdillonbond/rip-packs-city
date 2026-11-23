-- audit_20261122_ownership_walk_stamps_every_walked_owner — 2026-11-22 ~4:15 PM PT (Claude Code cloud, autonomous pass).
--
-- WHY. get_stale_ownership_wallets() hands ownership-onchain-walk the 800 owners with the OLDEST max(observed_at).
-- An owner whose walk confirms a holding gets a fresh observed_at (the route re-writes its confirmed rows). An owner
-- whose EVERY row the walk did not find gets none: mark_topshot_ownership_walk_missed() sets walk_missed_at only
-- WHERE walk_missed_at IS NULL, and nothing else advances. Measured 11-22 ~3:55 PM PT: 77 of the 790 head owners
-- have every row flagged (oldest last seen 07-06); they are walked on EVERY run (~5/day), ~10 % of the slots, while
-- everyone else waits ~3 days. CLAUDE.md: "a leg's ORDER BY decides whether it progresses".
--
-- WHAT.
--  1. public.topshot_ownership_owner_walks (owner_address PK, last_walked_at): when the walk last CLEANLY walked
--     an owner. RLS on, service_role only.
--  2. topshot_index_walk_holdings() also upserts p_walked (the route's walkedOk: owners whose chain read AND
--     ownership read both succeeded) into it. Body otherwise = live (md5 asserted).
--  3. get_stale_ownership_wallets() ranks an owner with rows by GREATEST(max(observed_at), last_walked_at).
--     The candidate branch (owners with no rows) is unchanged. Body otherwise = live (md5 asserted).
-- A failed walk (wallet_errors) is not stamped, so it stays at the head as before; it is now named in
-- extra.wallet_error_samples (b3644c70a). The table starts empty, so the order changes only as runs stamp owners.
-- Measured cost of the selector before: 1.2 s / 46k buffers per call; the join adds one probe per owner.
--
-- anon-exec: unchanged (topshot_index_walk_holdings, get_stale_ownership_wallets) — CREATE OR REPLACE, same
-- signatures; ACLs preserved and re-asserted below.
-- REVERT: re-apply both bodies from 20261017184739 / the live text this file guards on, then
--         DROP TABLE public.topshot_ownership_owner_walks;

DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.get_stale_ownership_wallets(integer)'::regprocedure)
     IS DISTINCT FROM '1ce304f1e4a7e5a7a2752ef952a80f97' THEN
    RAISE EXCEPTION 'get_stale_ownership_wallets drifted; re-read and re-base';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.topshot_index_walk_holdings(text[],bigint[],text[],timestamp with time zone)'::regprocedure)
     IS DISTINCT FROM '6598d2e4709fec2837ce1cb25e7631a8' THEN
    RAISE EXCEPTION 'topshot_index_walk_holdings drifted; re-read and re-base';
  END IF;
END
$guard$;

CREATE TABLE IF NOT EXISTS public.topshot_ownership_owner_walks (
  owner_address  text PRIMARY KEY,
  last_walked_at timestamptz NOT NULL
);
ALTER TABLE public.topshot_ownership_owner_walks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.topshot_ownership_owner_walks FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.topshot_ownership_owner_walks TO postgres, service_role;
COMMENT ON TABLE public.topshot_ownership_owner_walks IS
  'When ownership-onchain-walk last cleanly walked each owner (20261122). Ranks get_stale_ownership_wallets so an owner whose rows are all walk_missed cannot hold the head of the rotation.';

CREATE OR REPLACE FUNCTION public.topshot_index_walk_holdings(p_owners text[], p_nft_ids bigint[], p_walked text[], p_walk_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_written int := 0; v_stamped int := 0; v_queued int := 0;
BEGIN
  IF p_walk_at IS NULL OR cardinality(COALESCE(p_owners, '{}')) <> cardinality(COALESCE(p_nft_ids, '{}')) THEN
    RAISE EXCEPTION 'topshot_index_walk_holdings: owners and nft_ids must be equal-length, walk_at required';
  END IF;

  -- 2026-10-16: an id maps through the daily id map OR straight through `moments` (the hydrator's
  -- own output), so a moment hydrated today is indexed on the next walk, not after the 3:23 AM map
  -- refresh. Ids no source can place are queued (with the wallet holding them) for the hydrator.
  WITH pairs AS (
    SELECT DISTINCT ON (p.nft_id) p.owner_address, p.nft_id
      FROM unnest(COALESCE(p_owners, '{}'), COALESCE(p_nft_ids, '{}')) AS p(owner_address, nft_id)
     WHERE p.owner_address ~ '^0x[0-9a-f]{16}$'
     ORDER BY p.nft_id, p.owner_address
  ), mapped AS (
    SELECT pr.owner_address, pr.nft_id,
           COALESCE(m.edition_external_id, eo.external_id::text) AS edition_external_id,
           mo.serial_number
      FROM pairs pr
      LEFT JOIN public.topshot_moment_id_editions m ON m.id = pr.nft_id
      LEFT JOIN public.moments mo ON mo.nft_id = pr.nft_id::text AND mo.collection_id = v_ts
      LEFT JOIN public.editions eo ON eo.id = mo.edition_id AND eo.collection_id = v_ts
  ), up AS (
    INSERT INTO public.topshot_ownership AS t (nft_id, edition_external_id, owner_address, serial_number, source, observed_at)
    SELECT mp.nft_id::text, mp.edition_external_id, mp.owner_address, mp.serial_number, 'onchain_walk', p_walk_at
      FROM mapped mp
      JOIN public.editions e ON e.collection_id = v_ts AND e.external_id = mp.edition_external_id
     WHERE e.set_id_onchain >= 219
       AND NOT EXISTS (SELECT 1 FROM public.topshot_index_dune_sets d WHERE d.set_id_onchain = e.set_id_onchain)
    ON CONFLICT (nft_id) DO UPDATE SET
      owner_address = EXCLUDED.owner_address,
      observed_at   = EXCLUDED.observed_at,
      serial_number = COALESCE(t.serial_number, EXCLUDED.serial_number),
      source        = 'onchain_walk'
     WHERE t.observed_at < EXCLUDED.observed_at
       AND (t.owner_address <> EXCLUDED.owner_address OR t.walk_missed_at IS NOT NULL)
    RETURNING 1
  ), q AS (
    INSERT INTO public.topshot_index_unmapped_ids AS u (nft_id, wallet, first_seen_at, last_seen_at)
    SELECT mp.nft_id, mp.owner_address, p_walk_at, p_walk_at
      FROM mapped mp
     WHERE mp.edition_external_id IS NULL
    ON CONFLICT (nft_id) DO UPDATE SET wallet = EXCLUDED.wallet, last_seen_at = EXCLUDED.last_seen_at
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM up), (SELECT count(*) FROM q) INTO v_written, v_queued;

  UPDATE public.topshot_ownership_walk_candidates c
     SET last_walked_at = p_walk_at
   WHERE c.owner_address = ANY (COALESCE(p_walked, '{}'));
  GET DIAGNOSTICS v_stamped = ROW_COUNT;

  -- 2026-11-22: every cleanly walked owner, so the scheduler can rank an owner whose rows are all
  -- walk-missed (no observed_at ever advances for it) by when it was last walked.
  INSERT INTO public.topshot_ownership_owner_walks AS w (owner_address, last_walked_at)
  SELECT DISTINCT o, p_walk_at FROM unnest(COALESCE(p_walked, '{}')) AS o
  ON CONFLICT (owner_address) DO UPDATE SET last_walked_at = GREATEST(w.last_walked_at, EXCLUDED.last_walked_at);

  RETURN jsonb_build_object('written', v_written, 'candidates_stamped', v_stamped, 'unmapped_queued', v_queued);
END
$function$;

CREATE OR REPLACE FUNCTION public.get_stale_ownership_wallets(p_limit integer DEFAULT 800)
 RETURNS TABLE(owner_address text, last_seen timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT x.owner_address, x.last_seen
  FROM (
    -- 2026-11-22: an owner with rows ranks by the LATER of its newest observation and its last clean
    -- walk (topshot_ownership_owner_walks), so one whose rows are all walk-missed rotates like the rest.
    SELECT o.owner_address, GREATEST(o.last_seen, w.last_walked_at) AS last_seen
    FROM (
      SELECT owner_address, max(observed_at) AS last_seen
      FROM public.topshot_ownership
      GROUP BY owner_address
    ) o
    LEFT JOIN public.topshot_ownership_owner_walks w ON w.owner_address = o.owner_address
    UNION ALL
    SELECT c.owner_address, COALESCE(c.last_walked_at, '-infinity'::timestamptz)
    FROM public.topshot_ownership_walk_candidates c
    WHERE NOT EXISTS (SELECT 1 FROM public.topshot_ownership o WHERE o.owner_address = c.owner_address)
  ) x
  ORDER BY x.last_seen ASC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 800), 1), 5000);
$function$;

REVOKE EXECUTE ON FUNCTION public.topshot_index_walk_holdings(text[], bigint[], text[], timestamp with time zone) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.topshot_index_walk_holdings(text[], bigint[], text[], timestamp with time zone) TO service_role;
REVOKE EXECUTE ON FUNCTION public.get_stale_ownership_wallets(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_stale_ownership_wallets(integer) TO service_role;
