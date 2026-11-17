-- audit_20261016_ownership_walk_hydrates_ids_it_cannot_place
-- anon-exec: NOT intentional for topshot_index_unmapped_dispatch — an ops writer, EXECUTE service_role only. topshot_index_walk_holdings: CREATE OR REPLACE of 20261015224833's fn, identical signature and return type; ACL preserved (service_role).
--
-- Follow-up to 20261015224833 (the walk indexes holdings past the Dune era). That version could only
-- place an id through topshot_moment_id_editions (refreshed daily) and dropped the rest silently;
-- 33 % of post-265 mints had no mapping. Now:
--   1. topshot_index_walk_holdings maps through the id map OR `moments` (the hydrator's own output),
--      and QUEUES every id it cannot place, with the wallet holding it, in topshot_index_unmapped_ids;
--      it returns unmapped_queued (the route logs it).
--   2. topshot_index_unmapped_dispatch(p_max) sends queued ids to Flow REST through the EXISTING chain
--      hydrator (same Cadence script as topshot_moment_hydrate_dispatch_head, same request table, same
--      re-ask rules); topshot_moment_hydrate_tick's drain writes the `moments` row; the wallet's next
--      walk indexes it. pg_cron `rpc-topshot-index-unmapped-hydrate`, 2-58/4, 40 per tick (≤600/h —
--      the hydrator dispatched 10–60/h this morning against ~1,350/h of room, and the tick minutes
--      differ from the head/walk legs, which stay under Flow's burst limit together).
-- Measured on apply (9:10 AM PT): empty calls return zeros; backlog 0 until the next walk.
--
-- REVERT: SELECT cron.unschedule('rpc-topshot-index-unmapped-hydrate'); and re-apply the
-- topshot_index_walk_holdings body of 20261015224833 (later superseded by 20261016161353).

CREATE TABLE IF NOT EXISTS public.topshot_index_unmapped_ids (
  nft_id        bigint PRIMARY KEY,
  wallet        text NOT NULL CHECK (wallet ~ '^0x[0-9a-f]{16}$'),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.topshot_index_unmapped_ids ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.topshot_index_unmapped_ids FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.topshot_index_unmapped_ids TO service_role;
CREATE INDEX IF NOT EXISTS ix_topshot_index_unmapped_ids_last_seen ON public.topshot_index_unmapped_ids (last_seen_at DESC, nft_id DESC);
COMMENT ON TABLE public.topshot_index_unmapped_ids IS
  'Moment ids the ownership walk saw held (at or above the post-Dune id floor) that map to no edition yet, with the wallet that held them. topshot_index_unmapped_dispatch hydrates them through the existing chain hydrator (topshot_moment_hydrate_requests -> topshot_moment_hydrate_drain -> moments); the next walk of that wallet then indexes them. audit_20261016.';

CREATE OR REPLACE FUNCTION public.topshot_index_walk_holdings(
  p_owners text[], p_nft_ids bigint[], p_walked text[], p_walk_at timestamptz)
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
     WHERE e.set_id_onchain > 265
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

  RETURN jsonb_build_object('written', v_written, 'candidates_stamped', v_stamped, 'unmapped_queued', v_queued);
END
$function$;

-- Hydrate queued ids through the existing chain hydrator: same Cadence script, same request table,
-- same drain (topshot_moment_hydrate_tick drains every request). Same re-ask rules as
-- topshot_moment_hydrate_dispatch_head (no_nft/no_collection 30 d, in flight 10 min, else 1 day).
CREATE OR REPLACE FUNCTION public.topshot_index_unmapped_dispatch(p_max integer DEFAULT 40)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  r record; v_req bigint; v_n int := 0; v_backlog int; v_err text;
  v_script text := encode(convert_to($cdc$import TopShot from 0x0b2a3299cc857e29
access(all) fun main(address: Address, id: UInt64): {String: String} {
  let acct = getAccount(address)
  let col = acct.capabilities.borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection) ?? panic("no collection")
  let nft = col.borrowMoment(id: id) ?? panic("no nft")
  let sub = TopShot.getMomentsSubedition(nftID: id)
  return {"setID": nft.data.setID.toString(), "playID": nft.data.playID.toString(), "serial": nft.data.serialNumber.toString(), "sub": sub == nil ? "" : sub!.toString()}
}$cdc$, 'UTF8'), 'base64');
BEGIN
  BEGIN
    FOR r IN
      SELECT u.nft_id::text AS nft_id, u.wallet
        FROM public.topshot_index_unmapped_ids u
       WHERE NOT EXISTS (SELECT 1 FROM public.moments m
                          WHERE m.nft_id = u.nft_id::text AND m.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd')
         AND NOT EXISTS (SELECT 1 FROM public.topshot_moment_id_editions t WHERE t.id = u.nft_id)
         AND NOT EXISTS (SELECT 1 FROM public.topshot_moment_hydrate_requests q
                          WHERE q.nft_id = u.nft_id::text
                            AND q.dispatched_at > now() - CASE
                                  WHEN q.outcome IN ('no_nft', 'no_collection') THEN interval '30 days'
                                  WHEN q.outcome IS NULL THEN interval '10 minutes'
                                  ELSE interval '1 day' END)
       ORDER BY u.last_seen_at DESC, u.nft_id DESC
       LIMIT GREATEST(p_max, 0)
    LOOP
      v_req := net.http_post(
        url := 'https://rest-mainnet.onflow.org/v1/scripts?block_height=sealed',
        body := jsonb_build_object(
          'script', v_script,
          'arguments', jsonb_build_array(
            encode(convert_to('{"type":"Address","value":"' || r.wallet || '"}', 'UTF8'), 'base64'),
            encode(convert_to('{"type":"UInt64","value":"' || r.nft_id || '"}', 'UTF8'), 'base64'))),
        headers := '{"Content-Type":"application/json"}'::jsonb,
        timeout_milliseconds := 20000);
      INSERT INTO public.topshot_moment_hydrate_requests (request_id, nft_id, wallet) VALUES (v_req, r.nft_id, r.wallet);
      v_n := v_n + 1;
    END LOOP;

    SELECT count(*) INTO v_backlog
      FROM public.topshot_index_unmapped_ids u
     WHERE NOT EXISTS (SELECT 1 FROM public.moments m
                        WHERE m.nft_id = u.nft_id::text AND m.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd')
       AND NOT EXISTS (SELECT 1 FROM public.topshot_moment_id_editions t WHERE t.id = u.nft_id);
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_err := left(SQLERRM, 300);
  END;

  PERFORM public.log_pipeline_run('topshot-index-unmapped-hydrate', v_started, v_backlog, v_n, 0,
    v_err IS NULL, v_err, 'nba_top_shot', NULL, NULL,
    jsonb_build_object('dispatched', v_n, 'backlog', v_backlog, 'via', 'pg_cron',
                       'duration_ms', (extract(epoch FROM clock_timestamp() - v_started) * 1000)::int));
  RETURN jsonb_build_object('dispatched', v_n, 'backlog', v_backlog, 'error', v_err);
END
$function$;
REVOKE ALL ON FUNCTION public.topshot_index_unmapped_dispatch(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.topshot_index_unmapped_dispatch(integer) TO service_role;

SELECT cron.schedule('rpc-topshot-index-unmapped-hydrate', '2-58/4 * * * *',
  $$SELECT public.topshot_index_unmapped_dispatch(40);$$);
