-- audit_20261015_ownership_walk_indexes_new_sets_and_new_collectors
-- anon-exec: NOT intentional for seed_topshot_ownership_walk_candidates / topshot_index_walk_holdings / get_topshot_index_walk_id_floor — ops writers/readers, EXECUTE service_role only. get_stale_ownership_wallets: CREATE OR REPLACE of an existing fn, identical signature and return type; ACL preserved.
--
-- WHY (2026-10-15, Trevor: "Keep going" after the open question "extend the index to new sets?").
-- topshot_ownership covered Series 8 sets through 265 and nothing after: its Dune lane died on
-- 2026-09-10 (free tier ended) and ownership-onchain-walk only re-confirmed rows it already had. So
-- no set minted since July — and none of Series 2026-27 — could ever reach the rookie Top Collectors
-- board, the squeeze "Top 5 hold" or set completers. The walk already reads each holder wallet's
-- FULL moment-id set (Flow REST) on a ~2-day rotation; it simply ignored ids it had no row for.
--
-- WHAT
--   1. topshot_ownership_walk_candidates — wallets to walk that hold no row yet: Top Shot pack
--      openers (pack_rips) and marketplace buyers (sales) of the last 60 days. Seeded now (1,660)
--      and daily by pg_cron `rpc-topshot-ownership-walk-candidates` (17 9 * * *, 2:17 AM PT).
--   2. get_stale_ownership_wallets also returns candidates without a row (never-walked first, then
--      by last_walked_at). A candidate leaves by itself once it owns an indexed row.
--   3. get_topshot_index_walk_id_floor() — the lowest mapped moment id in a set past 265
--      (52,537,846 today); new mints only get higher ids, so the walk sends ids >= it.
--   4. topshot_index_walk_holdings(owners[], nft_ids[], walked[], walk_at) — maps each held id through
--      topshot_moment_id_editions to a Top Shot edition in a set past 265 and writes it as that
--      wallet's holding (source onchain_walk, observed_at = the walk). An id already indexed under
--      another owner moves only on NEWER evidence; a flagged row the wallet does hold is re-owned
--      (the walk_missed_at trigger clears the flag). Stamps last_walked_at on walked candidates.
--   Route change (same commit set): app/api/cron/ownership-onchain-walk sends the pairs and the
--   walked list after its confirmations and flags.
-- Limits, stated: an id with no row in topshot_moment_id_editions (33 % of post-265 mints today —
-- moments never sold, never in a tracked wallet cache and not yet hydrated) is not indexed; the
-- census stays partial for those, which the squeeze board's 98 % gate and the player-page coverage
-- note (20261015221224) show rather than hide.
--
-- REVERT:
--   SELECT cron.unschedule('rpc-topshot-ownership-walk-candidates');
--   re-apply get_stale_ownership_wallets' previous body (owners only: SELECT owner_address,
--   max(observed_at) … GROUP BY owner_address ORDER BY 2 ASC LIMIT …);
--   git revert the route commit; rows the walk wrote carry source 'onchain_walk' and observed_at
--   >= 2026-10-15 3:48 PM PT with edition set_id_onchain > 265 (no earlier row has such an edition).

CREATE TABLE IF NOT EXISTS public.topshot_ownership_walk_candidates (
  owner_address  text PRIMARY KEY CHECK (owner_address ~ '^0x[0-9a-f]{16}$'),
  source         text NOT NULL,
  added_at       timestamptz NOT NULL DEFAULT now(),
  last_walked_at timestamptz
);
ALTER TABLE public.topshot_ownership_walk_candidates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.topshot_ownership_walk_candidates FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.topshot_ownership_walk_candidates TO service_role;
COMMENT ON TABLE public.topshot_ownership_walk_candidates IS
  'Top Shot wallets the ownership walk should read although topshot_ownership holds no row for them yet: recent pack openers and marketplace buyers (seed_topshot_ownership_walk_candidates, daily). A candidate leaves the rotation by itself once the walk indexes a holding for it (it then rotates as an owner). audit_20261015.';

CREATE OR REPLACE FUNCTION public.seed_topshot_ownership_walk_candidates(p_days integer DEFAULT 60)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_started timestamptz := clock_timestamp();
  v_openers int := 0; v_buyers int := 0; v_err text;
BEGIN
  BEGIN
    WITH ins AS (
      INSERT INTO public.topshot_ownership_walk_candidates (owner_address, source)
      SELECT DISTINCT lower(r.opener_address), 'pack_opener'
        FROM public.pack_rips r
       WHERE r.collection_id = v_ts
         AND r.sealed_at > now() - make_interval(days => GREATEST(p_days, 1))
         AND lower(r.opener_address) ~ '^0x[0-9a-f]{16}$'
         AND NOT EXISTS (SELECT 1 FROM public.topshot_ownership o WHERE o.owner_address = lower(r.opener_address))
      ON CONFLICT (owner_address) DO NOTHING
      RETURNING 1)
    SELECT count(*) INTO v_openers FROM ins;

    WITH ins AS (
      INSERT INTO public.topshot_ownership_walk_candidates (owner_address, source)
      SELECT DISTINCT lower(s.buyer_address), 'marketplace_buyer'
        FROM public.sales s
       WHERE s.collection_id = v_ts
         AND s.sold_at > now() - make_interval(days => GREATEST(p_days, 1))
         AND lower(s.buyer_address) ~ '^0x[0-9a-f]{16}$'
         AND NOT EXISTS (SELECT 1 FROM public.topshot_ownership o WHERE o.owner_address = lower(s.buyer_address))
      ON CONFLICT (owner_address) DO NOTHING
      RETURNING 1)
    SELECT count(*) INTO v_buyers FROM ins;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_err := left(SQLERRM, 300);
  END;

  PERFORM public.log_pipeline_run('topshot-ownership-walk-candidates', v_started, NULL, v_openers + v_buyers, 0,
    v_err IS NULL, v_err, 'nba_top_shot', NULL, NULL,
    jsonb_build_object('openers_added', v_openers, 'buyers_added', v_buyers, 'days', p_days, 'via', 'pg_cron',
                       'duration_ms', (extract(epoch FROM clock_timestamp() - v_started) * 1000)::int));
  RETURN jsonb_build_object('openers_added', v_openers, 'buyers_added', v_buyers, 'error', v_err);
END
$function$;
REVOKE ALL ON FUNCTION public.seed_topshot_ownership_walk_candidates(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.seed_topshot_ownership_walk_candidates(integer) TO service_role;

-- (see header 4.)
-- to a Top Shot edition in a set PAST the Dune-era index (set_id_onchain > 265) is written as
-- that owner's holding. A row already held elsewhere moves only on NEWER evidence (the trigger
-- then clears any walk_missed_at flag). Candidates the walk read get last_walked_at stamped.
CREATE OR REPLACE FUNCTION public.topshot_index_walk_holdings(
  p_owners text[], p_nft_ids bigint[], p_walked text[], p_walk_at timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_written int := 0; v_stamped int := 0;
BEGIN
  IF p_walk_at IS NULL OR cardinality(COALESCE(p_owners, '{}')) <> cardinality(COALESCE(p_nft_ids, '{}')) THEN
    RAISE EXCEPTION 'topshot_index_walk_holdings: owners and nft_ids must be equal-length, walk_at required';
  END IF;

  WITH pairs AS (
    SELECT DISTINCT ON (p.nft_id) p.owner_address, p.nft_id
      FROM unnest(COALESCE(p_owners, '{}'), COALESCE(p_nft_ids, '{}')) AS p(owner_address, nft_id)
     WHERE p.owner_address ~ '^0x[0-9a-f]{16}$'
     ORDER BY p.nft_id, p.owner_address
  ), mapped AS (
    SELECT pr.owner_address, pr.nft_id, m.edition_external_id
      FROM pairs pr
      JOIN public.topshot_moment_id_editions m ON m.id = pr.nft_id
      JOIN public.editions e ON e.collection_id = v_ts AND e.external_id = m.edition_external_id
     WHERE e.set_id_onchain > 265
  ), up AS (
    INSERT INTO public.topshot_ownership AS t (nft_id, edition_external_id, owner_address, serial_number, source, observed_at)
    SELECT mp.nft_id::text, mp.edition_external_id, mp.owner_address, mo.serial_number, 'onchain_walk', p_walk_at
      FROM mapped mp
      LEFT JOIN public.moments mo ON mo.nft_id = mp.nft_id::text AND mo.collection_id = v_ts
    ON CONFLICT (nft_id) DO UPDATE SET
      owner_address = EXCLUDED.owner_address,
      observed_at   = EXCLUDED.observed_at,
      serial_number = COALESCE(t.serial_number, EXCLUDED.serial_number),
      source        = 'onchain_walk'
     WHERE t.observed_at < EXCLUDED.observed_at
       AND (t.owner_address <> EXCLUDED.owner_address OR t.walk_missed_at IS NOT NULL)
    RETURNING 1
  )
  SELECT count(*) INTO v_written FROM up;

  UPDATE public.topshot_ownership_walk_candidates c
     SET last_walked_at = p_walk_at
   WHERE c.owner_address = ANY (COALESCE(p_walked, '{}'));
  GET DIAGNOSTICS v_stamped = ROW_COUNT;

  RETURN jsonb_build_object('written', v_written, 'candidates_stamped', v_stamped);
END
$function$;
REVOKE ALL ON FUNCTION public.topshot_index_walk_holdings(text[], bigint[], text[], timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.topshot_index_walk_holdings(text[], bigint[], text[], timestamptz) TO service_role;

-- Lowest moment id worth sending: the smallest mapped id in a set past the Dune-era index.
-- New mints only get higher ids, so the walk sends ids >= this and nothing older.
CREATE OR REPLACE FUNCTION public.get_topshot_index_walk_id_floor()
RETURNS bigint
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT min(m.id)
    FROM public.topshot_moment_id_editions m
    JOIN public.editions e ON e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
                          AND e.external_id = m.edition_external_id
   WHERE e.set_id_onchain > 265;
$function$;
REVOKE ALL ON FUNCTION public.get_topshot_index_walk_id_floor() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_topshot_index_walk_id_floor() TO service_role;

-- The walk's rotation now includes candidates that have no ownership row yet (never walked first).
CREATE OR REPLACE FUNCTION public.get_stale_ownership_wallets(p_limit integer DEFAULT 800)
 RETURNS TABLE(owner_address text, last_seen timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT x.owner_address, x.last_seen
  FROM (
    SELECT owner_address, max(observed_at) AS last_seen
    FROM public.topshot_ownership
    GROUP BY owner_address
    UNION ALL
    SELECT c.owner_address, COALESCE(c.last_walked_at, '-infinity'::timestamptz)
    FROM public.topshot_ownership_walk_candidates c
    WHERE NOT EXISTS (SELECT 1 FROM public.topshot_ownership o WHERE o.owner_address = c.owner_address)
  ) x
  ORDER BY x.last_seen ASC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 800), 1), 5000);
$function$;

SELECT public.seed_topshot_ownership_walk_candidates(60);

SELECT cron.schedule('rpc-topshot-ownership-walk-candidates', '17 9 * * *',
  $$SELECT public.seed_topshot_ownership_walk_candidates(60);$$);
