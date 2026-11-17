-- audit_20261017_unmapped_hydrate_skips_ids_predicted_into_uncovered_sets
-- anon-exec: NOT intentional for topshot_index_unmapped_predict — an ops writer, EXECUTE service_role only. topshot_index_unmapped_dispatch: CREATE OR REPLACE of 20261016161027's fn, identical signature and return type; ACL preserved (service_role).
--
-- WHY (2026-10-17 ~9:15 AM PT). The unplaced-id hydration queue (20261016161027) grew to 173,669 after the
-- Dune-gap walk, and drained at 40/tick (~12 days). Of the 13,101 ids hydrated so far, 9,384 (72 %)
-- landed in set 218 (Series 8 Base Set), which the index deliberately does not cover (20261016161353),
-- so 72 % of the hydrator's Flow REST calls bought nothing for the boards.
--
-- WHAT. Ids mint in contiguous per-edition batches, so an id whose nearest MAPPED neighbours below and
-- above are in the same set is in that set. Measured on 3,000 already-hydrated ids: "both neighbours
-- in 218" predicted set 218 with 0 false positives (0 of 840 non-218) and 99 % recall (2,137 of 2,160).
--   1. topshot_index_unmapped_ids.predicted_set / predicted_at; topshot_index_unmapped_predict(p_max)
--      fills it (both neighbours' set when they agree, else NULL), pg_cron
--      `rpc-topshot-index-unmapped-predict` 1-56/5, 5,000 per call (272 ms measured).
--   2. topshot_index_unmapped_dispatch skips ids predicted into a set the index does not cover
--      (< 219 or a Dune set), sends predicted-indexable ids first, still sends unpredicted ones,
--      and reports backlog / skipped_predicted_uncovered / unpredicted. Rows are kept, not removed.
-- Measured on apply (after 185,000 predictions run by hand): actionable backlog 23,409 (~39 h at
-- 40/tick); skipped 150,220; unpredicted 555.
--
-- REVERT: SELECT cron.unschedule('rpc-topshot-index-unmapped-predict'); and re-apply the
-- topshot_index_unmapped_dispatch body of 20261016161027.

ALTER TABLE public.topshot_index_unmapped_ids
  ADD COLUMN IF NOT EXISTS predicted_set integer,
  ADD COLUMN IF NOT EXISTS predicted_at timestamptz;
CREATE INDEX IF NOT EXISTS ix_topshot_index_unmapped_ids_unpredicted ON public.topshot_index_unmapped_ids (nft_id) WHERE predicted_at IS NULL;
COMMENT ON COLUMN public.topshot_index_unmapped_ids.predicted_set IS
  'Set predicted from the id''s mint neighbours: when the nearest mapped ids below and above it are in the SAME set, that set (else NULL). Ids mint in contiguous per-edition batches; measured 2026-10-17 on 3,000 hydrated ids: both-neighbours-in-218 predicted set 218 with 0 false positives and 99 % recall. The dispatcher skips ids predicted into a set the index does not cover. audit_20261017.';

-- Batch predictor: fills predicted_set for up to p_max unpredicted queue rows per call.
CREATE OR REPLACE FUNCTION public.topshot_index_unmapped_predict(p_max integer DEFAULT 5000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_started timestamptz := clock_timestamp();
  v_n int := 0; v_err text;
BEGIN
  BEGIN
    WITH batch AS (
      SELECT u.nft_id
        FROM public.topshot_index_unmapped_ids u
       WHERE u.predicted_at IS NULL
       ORDER BY u.nft_id
       LIMIT GREATEST(p_max, 0)
    ), pred AS (
      SELECT b.nft_id,
             (SELECT e.set_id_onchain FROM public.topshot_moment_id_editions t
                JOIN public.editions e ON e.collection_id = v_ts AND e.external_id = t.edition_external_id
               WHERE t.id < b.nft_id ORDER BY t.id DESC LIMIT 1) AS prev_set,
             (SELECT e.set_id_onchain FROM public.topshot_moment_id_editions t
                JOIN public.editions e ON e.collection_id = v_ts AND e.external_id = t.edition_external_id
               WHERE t.id > b.nft_id ORDER BY t.id ASC LIMIT 1) AS next_set
        FROM batch b
    ), upd AS (
      UPDATE public.topshot_index_unmapped_ids u
         SET predicted_set = CASE WHEN p.prev_set = p.next_set THEN p.prev_set END,
             predicted_at  = now()
        FROM pred p
       WHERE u.nft_id = p.nft_id
      RETURNING 1
    )
    SELECT count(*) INTO v_n FROM upd;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_err := left(SQLERRM, 300);
  END;
  PERFORM public.log_pipeline_run('topshot-index-unmapped-predict', v_started, NULL, v_n, 0,
    v_err IS NULL, v_err, 'nba_top_shot', NULL, NULL,
    jsonb_build_object('predicted', v_n, 'via', 'pg_cron',
                       'duration_ms', (extract(epoch FROM clock_timestamp() - v_started) * 1000)::int));
  RETURN jsonb_build_object('predicted', v_n, 'error', v_err);
END
$function$;
REVOKE ALL ON FUNCTION public.topshot_index_unmapped_predict(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.topshot_index_unmapped_predict(integer) TO service_role;

-- A predicted set is "skippable" when the index does not cover it: below 219 (incl. 218 Series 8
-- Base Set) or a Dune-era set. Unpredicted (NULL) ids are still hydrated.
CREATE OR REPLACE FUNCTION public.topshot_index_unmapped_dispatch(p_max integer DEFAULT 40)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  r record; v_req bigint; v_n int := 0; v_backlog int; v_skipped int; v_unpredicted int; v_err text;
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
       WHERE NOT (u.predicted_set IS NOT NULL
                  AND (u.predicted_set < 219
                       OR EXISTS (SELECT 1 FROM public.topshot_index_dune_sets d WHERE d.set_id_onchain = u.predicted_set)))
         AND NOT EXISTS (SELECT 1 FROM public.moments m
                          WHERE m.nft_id = u.nft_id::text AND m.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd')
         AND NOT EXISTS (SELECT 1 FROM public.topshot_moment_id_editions t WHERE t.id = u.nft_id)
         AND NOT EXISTS (SELECT 1 FROM public.topshot_moment_hydrate_requests q
                          WHERE q.nft_id = u.nft_id::text
                            AND q.dispatched_at > now() - CASE
                                  WHEN q.outcome IN ('no_nft', 'no_collection') THEN interval '30 days'
                                  WHEN q.outcome IS NULL THEN interval '10 minutes'
                                  ELSE interval '1 day' END)
       -- predicted-indexable first, then unpredicted; newest sightings first
       ORDER BY (u.predicted_set IS NOT NULL) DESC, u.last_seen_at DESC, u.nft_id DESC
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

    SELECT count(*) FILTER (WHERE NOT skippable),
           count(*) FILTER (WHERE skippable),
           count(*) FILTER (WHERE predicted_at IS NULL)
      INTO v_backlog, v_skipped, v_unpredicted
      FROM (
        SELECT u.predicted_at,
               (u.predicted_set IS NOT NULL
                AND (u.predicted_set < 219
                     OR EXISTS (SELECT 1 FROM public.topshot_index_dune_sets d WHERE d.set_id_onchain = u.predicted_set))) AS skippable
          FROM public.topshot_index_unmapped_ids u
         WHERE NOT EXISTS (SELECT 1 FROM public.moments m
                            WHERE m.nft_id = u.nft_id::text AND m.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd')
           AND NOT EXISTS (SELECT 1 FROM public.topshot_moment_id_editions t WHERE t.id = u.nft_id)
      ) x;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_err := left(SQLERRM, 300);
  END;

  PERFORM public.log_pipeline_run('topshot-index-unmapped-hydrate', v_started, v_backlog, v_n, v_skipped,
    v_err IS NULL, v_err, 'nba_top_shot', NULL, NULL,
    jsonb_build_object('dispatched', v_n, 'backlog', v_backlog, 'skipped_predicted_uncovered', v_skipped,
                       'unpredicted', v_unpredicted, 'via', 'pg_cron',
                       'duration_ms', (extract(epoch FROM clock_timestamp() - v_started) * 1000)::int));
  RETURN jsonb_build_object('dispatched', v_n, 'backlog', v_backlog, 'skipped_predicted_uncovered', v_skipped,
                            'unpredicted', v_unpredicted, 'error', v_err);
END
$function$;

SELECT cron.schedule('rpc-topshot-index-unmapped-predict', '1-56/5 * * * *',
  $$SELECT public.topshot_index_unmapped_predict(5000);$$);
