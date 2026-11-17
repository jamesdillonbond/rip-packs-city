-- topshot_sellback_edition_reads_name_staged_sellbacks_from_the_chain
-- anon-exec: revoked (run_topshot_sellback_edition_reads) — NEW SECDEF fn; REVOKE FROM PUBLIC, anon, authenticated in one statement below; pg_cron runs it as postgres.
--
-- 2026-10-03 (known-issues #167, follow-on to 20261003204900). The sell-back walk stages every
-- 2025 Top Shot sell-back, but promotes into `sales` only when the edition resolves from
-- `moments` / another sale — 97 % did not (787 of 811 in its first chain-hour). The chain still
-- knows: right after the sell-back the moment sits in the buy-back wallet's collection, so a
-- script at a historical height (the pack-pull chain lane's script, 20260929161000) returns its
-- setID / playID / serial / subedition.
--
-- Measured 2026-10-03 ~2:10 PM PT, mainnet26, before writing this:
--   * ONE script at block 118,101,999 with all 402 unresolved sell-backs of blocks
--     118,100,000–118,101,999 returned 402 of 402; 402 of 402 map to an edition we carry
--     (101 editions, 0 parallels); the 1 already in topshot_chain_moment_reads agrees.
--   * CONTROL: the 106 sell-backs the walk had already promoted (edition from moments / sales),
--     read in ONE script at 118,126,496 — up to 26k blocks (~8 h) after the sale — 106 of 106
--     returned, edition 106/106 and serial 106/106 agree with what the walk wrote.
--   So the buy-back wallet holds a moment for hours, and one script per 2,000-block window
--   covers the window. A moment that has already left by the window's read height is retried
--   ALONE at its own sale block (kind 'block'); one still missing there is counted as
--   chain_not_held and stays staged.
--
-- WHAT.
--   topshot_sellback_edition_requests  one script read: window (≤ 500 ids at the window's max
--                                      sale height) or block fallback; pending -> in_flight ->
--                                      done | failed (6 attempts; a 429 is a retry, not one).
--   topshot_sellback_walk_purchases.edition_read_requested_at — set when a row is enqueued.
--   run_topshot_sellback_edition_reads(p_max_inflight) collects landed reads into
--     topshot_chain_moment_reads (owner = the buy-back wallet), enqueues, dispatches, then
--     PROMOTES staged 'unresolved_edition' sell-backs whose read maps to an edition we carry
--     (source 'onchain_sellback_backfill_2025', serial from the chain) -> 'inserted_chain_read';
--     a read whose edition we do not carry -> 'edition_missing' (a parallel is never folded
--     into its base). Self-unschedules when the walk's job is gone and nothing is left.
--
-- REVERT:
--   SELECT cron.unschedule('rpc-topshot-sellback-edition-reads');
--   DELETE FROM public.sales s USING public.topshot_sellback_walk_purchases p
--    WHERE s.source = 'onchain_sellback_backfill_2025' AND p.promote_outcome = 'inserted_chain_read'
--      AND s.transaction_hash = p.tx AND s.nft_id = p.nft_id;
--   UPDATE public.topshot_sellback_walk_purchases SET promote_outcome = 'unresolved_edition'
--    WHERE promote_outcome IN ('inserted_chain_read', 'edition_missing', 'chain_not_held');
--   DELETE FROM public.topshot_chain_moment_reads WHERE owner_address = '0xe1f2a091f7bb5245';
--   DROP FUNCTION public.run_topshot_sellback_edition_reads(integer);
--   DROP TABLE public.topshot_sellback_edition_requests;
--   ALTER TABLE public.topshot_sellback_walk_purchases DROP COLUMN edition_read_requested_at;

ALTER TABLE public.topshot_sellback_walk_purchases ADD COLUMN IF NOT EXISTS edition_read_requested_at timestamptz;
-- Partial indexes keep every per-tick scan proportional to the WORK, not to the ~2M staged rows:
--   * not yet asked for (this lane's enqueue);
--   * asked for, not yet named (this lane's promote);
--   * not yet promoted (the walk's own promote + done check, which filter `promoted_at IS NULL`
--     and until now scanned the whole table every minute).
CREATE INDEX IF NOT EXISTS topshot_sellback_walk_purchases_unrequested_idx
  ON public.topshot_sellback_walk_purchases (block_height)
  WHERE promote_outcome = 'unresolved_edition' AND edition_read_requested_at IS NULL;
CREATE INDEX IF NOT EXISTS topshot_sellback_walk_purchases_awaiting_read_idx
  ON public.topshot_sellback_walk_purchases (nft_id)
  WHERE promote_outcome = 'unresolved_edition' AND edition_read_requested_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS topshot_sellback_walk_purchases_unpromoted_idx
  ON public.topshot_sellback_walk_purchases (tx, nft_id) WHERE promoted_at IS NULL;

CREATE TABLE IF NOT EXISTS public.topshot_sellback_edition_requests (
  id            bigserial PRIMARY KEY,
  kind          text   NOT NULL CHECK (kind IN ('window', 'block')),
  read_height   bigint NOT NULL,
  ids           bigint[] NOT NULL,
  status        text   NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_flight', 'done', 'failed')),
  request_id    bigint,
  attempts      int    NOT NULL DEFAULT 0,
  last_error    text,
  dispatched_at timestamptz,
  finished_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS topshot_sellback_edition_requests_open_idx
  ON public.topshot_sellback_edition_requests (status, id) WHERE status IN ('pending', 'in_flight');
ALTER TABLE public.topshot_sellback_edition_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.topshot_sellback_edition_requests FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.run_topshot_sellback_edition_reads(p_max_inflight integer DEFAULT 4)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  c_buyback  CONSTANT text := '0xe1f2a091f7bb5245';
  c_ts       CONSTANT uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  c_m26_end  CONSTANT bigint := 130290658;
  c_base     CONSTANT bigint := 118100000;
  c_window   CONSTANT int := 2000;
  c_chunk    CONSTANT int := 500;
  c_max_att  CONSTANT int := 6;
  c_src      CONSTANT text := 'import TopShot from 0x0b2a3299cc857e29
access(all) fun main(owner: Address, ids: [UInt64]): {UInt64: [UInt32]} {
  let out: {UInt64: [UInt32]} = {}
  let col = getAccount(owner).capabilities.borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection)
  if col == nil { return out }
  for id in ids { if let m = col!.borrowMoment(id: id) { out[id] = [m.data.setID, m.data.playID, m.data.serialNumber, TopShot.getMomentsSubedition(nftID: id) ?? 0] } }
  return out
}';
  v_started    timestamptz := clock_timestamp();
  r            record;
  v_body       jsonb;
  v_got        bigint[];
  v_collected  int := 0;
  v_reads_new  int := 0;
  v_throttled  int := 0;
  v_failed     int := 0;
  v_fallback   int := 0;
  v_not_held   int := 0;
  v_enqueued   int := 0;
  v_dispatched int := 0;
  v_inflight   int := 0;
  v_promoted   int := 0;
  v_missing    int := 0;
  v_n          int;
  v_err        text;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('run_topshot_sellback_edition_reads')) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'another run holds the lock');
  END IF;

  BEGIN
    -- 1. COLLECT every landed read. A 200 is a Dictionary of the ids still held at read_height.
    FOR r IN
      SELECT q.id, q.kind, q.read_height, q.ids, q.attempts, q.dispatched_at,
             h.status_code AS h_status, h.content AS h_content, h.error_msg AS h_error, (h.id IS NOT NULL) AS landed
        FROM public.topshot_sellback_edition_requests q
        LEFT JOIN net._http_response h ON h.id = q.request_id
       WHERE q.status = 'in_flight'
       ORDER BY q.id
    LOOP
      IF NOT r.landed THEN
        IF r.dispatched_at < now() - interval '30 minutes' THEN
          UPDATE public.topshot_sellback_edition_requests
             SET status = CASE WHEN attempts + 1 >= c_max_att THEN 'failed' ELSE 'pending' END,
                 attempts = attempts + 1, request_id = NULL, last_error = 'no_response',
                 finished_at = CASE WHEN attempts + 1 >= c_max_att THEN now() END
           WHERE id = r.id;
        END IF;
        CONTINUE;
      END IF;
      v_collected := v_collected + 1;

      v_body := NULL;
      IF r.h_status = 200 AND pg_input_is_valid(r.h_content, 'jsonb') THEN
        BEGIN
          v_body := convert_from(decode(r.h_content::jsonb #>> '{}', 'base64'), 'UTF8')::jsonb;
        EXCEPTION WHEN others THEN
          v_body := NULL;
        END;
      END IF;

      IF v_body IS NULL OR v_body->>'type' IS DISTINCT FROM 'Dictionary' THEN
        IF r.h_status = 429 THEN
          -- the node's throttle, not a wrong read: retried without spending an attempt
          UPDATE public.topshot_sellback_edition_requests
             SET status = 'pending', request_id = NULL, last_error = 'http 429'
           WHERE id = r.id;
          v_throttled := v_throttled + 1;
        ELSE
          UPDATE public.topshot_sellback_edition_requests
             SET status = CASE WHEN attempts + 1 >= c_max_att THEN 'failed' ELSE 'pending' END,
                 attempts = attempts + 1, request_id = NULL,
                 last_error = left(coalesce(r.h_error, 'http ' || coalesce(r.h_status::text, 'null') || ': ' || r.h_content), 300),
                 finished_at = CASE WHEN attempts + 1 >= c_max_att THEN now() END
           WHERE id = r.id;
          v_failed := v_failed + 1;
        END IF;
        CONTINUE;
      END IF;

      WITH kv AS (
        SELECT (e->'key'->>'value')::bigint AS nft_id,
               (e->'value'->'value'->0->>'value')::int AS set_id,
               (e->'value'->'value'->1->>'value')::int AS play_id,
               (e->'value'->'value'->2->>'value')::int AS serial_number,
               coalesce((e->'value'->'value'->3->>'value')::int, 0) AS subedition_id
          FROM jsonb_array_elements(coalesce(v_body->'value', '[]'::jsonb)) e
      ), ins AS (
        INSERT INTO public.topshot_chain_moment_reads
               (nft_id, set_id, play_id, serial_number, subedition_id, owner_address, block_height)
        SELECT nft_id, set_id, play_id, serial_number, subedition_id, c_buyback, r.read_height
          FROM kv
         WHERE set_id IS NOT NULL AND play_id IS NOT NULL AND serial_number IS NOT NULL
        ON CONFLICT (nft_id) DO NOTHING
        RETURNING 1
      )
      SELECT (SELECT count(*) FROM ins), (SELECT array_agg(nft_id) FROM kv) INTO v_n, v_got;
      v_reads_new := v_reads_new + v_n;

      -- Ids the read did not return. A WINDOW miss is retried alone at its own sale block (it may
      -- have left the wallet before the window's read height); a BLOCK miss is final.
      IF r.kind = 'window' THEN
        INSERT INTO public.topshot_sellback_edition_requests (kind, read_height, ids)
        SELECT 'block', p.block_height, array_agg(DISTINCT p.nft_id::bigint)
          FROM public.topshot_sellback_walk_purchases p
         WHERE p.nft_id::bigint = ANY (r.ids)
           AND NOT (p.nft_id::bigint = ANY (coalesce(v_got, '{}'::bigint[])))
           AND p.promote_outcome = 'unresolved_edition'
         GROUP BY p.block_height;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_fallback := v_fallback + v_n;
      ELSE
        UPDATE public.topshot_sellback_walk_purchases p
           SET promote_outcome = 'chain_not_held'
         WHERE p.nft_id::bigint = ANY (r.ids)
           AND NOT (p.nft_id::bigint = ANY (coalesce(v_got, '{}'::bigint[])))
           AND p.promote_outcome = 'unresolved_edition'
           AND NOT EXISTS (SELECT 1 FROM public.topshot_chain_moment_reads c WHERE c.nft_id = p.nft_id::bigint);
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_not_held := v_not_held + v_n;
      END IF;

      UPDATE public.topshot_sellback_edition_requests
         SET status = 'done', finished_at = now(), last_error = NULL
       WHERE id = r.id;
    END LOOP;

    -- 2. ENQUEUE staged, unresolved sell-backs not yet asked for: one request per 2,000-block
    --    window (never straddling the mainnet26/27 boundary), ≤ 500 ids each, read at the
    --    window's highest sale block. Bounded per tick.
    WITH todo AS (
      SELECT p.tx, p.nft_id, p.block_height,
             (p.block_height <= c_m26_end) AS m26,
             (p.block_height - c_base) / c_window AS w
        FROM public.topshot_sellback_walk_purchases p
       WHERE p.promote_outcome = 'unresolved_edition'
         AND p.edition_read_requested_at IS NULL
         AND p.block_height IS NOT NULL
         AND p.nft_id ~ '^[0-9]{1,18}$'
       ORDER BY p.block_height
       LIMIT 4000
    ), chunked AS (
      SELECT t.*, (row_number() OVER (PARTITION BY m26, w ORDER BY block_height, nft_id) - 1) / c_chunk AS c
        FROM todo t
    ), groups AS (
      SELECT max(block_height) AS h, array_agg(DISTINCT nft_id::bigint) AS ids
        FROM chunked GROUP BY m26, w, c
    ), ins AS (
      INSERT INTO public.topshot_sellback_edition_requests (kind, read_height, ids)
      SELECT 'window', h, ids FROM groups
      RETURNING 1
    ), mark AS (
      UPDATE public.topshot_sellback_walk_purchases p
         SET edition_read_requested_at = now()
        FROM todo t
       WHERE p.tx = t.tx AND p.nft_id = t.nft_id
      RETURNING 1
    )
    -- (`mark` runs regardless: a data-modifying CTE executes whether or not it is read)
    SELECT count(*) INTO v_enqueued FROM ins;

    -- 3. DISPATCH: never more than p_max_inflight reads outstanding, oldest first.
    SELECT count(*) INTO v_inflight FROM public.topshot_sellback_edition_requests WHERE status = 'in_flight';
    WITH nxt AS (
      SELECT id FROM public.topshot_sellback_edition_requests
       WHERE status = 'pending'
       ORDER BY id
       LIMIT GREATEST(p_max_inflight - v_inflight, 0)
    ), sent AS (
      UPDATE public.topshot_sellback_edition_requests q
         SET request_id = net.http_post(
               url := CASE WHEN q.read_height <= c_m26_end THEN 'http://access-001.mainnet26.nodes.onflow.org:8070'
                           ELSE 'http://access-001.mainnet27.nodes.onflow.org:8070' END
                      || '/v1/scripts?block_height=' || q.read_height,
               body := jsonb_build_object(
                 'script', translate(encode(convert_to(c_src, 'UTF8'), 'base64'), E'\n', ''),
                 'arguments', jsonb_build_array(
                   translate(encode(convert_to(jsonb_build_object('type', 'Address', 'value', c_buyback)::text, 'UTF8'), 'base64'), E'\n', ''),
                   translate(encode(convert_to(jsonb_build_object('type', 'Array', 'value',
                     (SELECT jsonb_agg(jsonb_build_object('type', 'UInt64', 'value', i::text)) FROM unnest(q.ids) i))::text, 'UTF8'), 'base64'), E'\n', ''))),
               headers := '{"Content-Type":"application/json"}'::jsonb,
               timeout_milliseconds := 60000),
             status = 'in_flight', dispatched_at = now()
        FROM nxt
       WHERE q.id = nxt.id
      RETURNING 1
    )
    SELECT count(*) INTO v_dispatched FROM sent;

    -- 4. PROMOTE staged sell-backs the chain has now named. The edition must be one we carry
    --    (exact external_id, parallels included); otherwise 'edition_missing', never a guess.
    WITH cand AS (
      SELECT p.tx, p.nft_id, p.price_usd, p.seller, p.block_height, p.sold_at,
             c.serial_number, ed.id AS edition_id
        FROM public.topshot_sellback_walk_purchases p
        JOIN public.topshot_chain_moment_reads c ON c.nft_id = p.nft_id::bigint
        LEFT JOIN public.editions ed
          ON ed.collection_id = c_ts
         AND ed.external_id = CASE WHEN c.subedition_id = 0 THEN c.set_id || ':' || c.play_id
                                   ELSE c.set_id || ':' || c.play_id || '::' || c.subedition_id END
       WHERE p.promote_outcome = 'unresolved_edition'
         AND p.edition_read_requested_at IS NOT NULL
         AND p.price_usd IS NOT NULL
         AND p.nft_id ~ '^[0-9]{1,18}$'
       LIMIT 2000
    ), ins AS (
      INSERT INTO public.sales (edition_id, collection_id, collection, serial_number, price_usd, currency,
                                seller_address, buyer_address, marketplace, transaction_hash, block_height,
                                sold_at, nft_id, source)
      SELECT c.edition_id, c_ts, 'nba_top_shot', c.serial_number, c.price_usd, 'USD',
             c.seller, c_buyback, 'top_shot', c.tx, c.block_height, c.sold_at, c.nft_id,
             'onchain_sellback_backfill_2025'
        FROM cand c
       WHERE c.edition_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM public.sales s
                          WHERE s.collection_id = c_ts AND s.nft_id = c.nft_id
                            AND s.sold_at BETWEEN c.sold_at - interval '1 hour' AND c.sold_at + interval '1 hour'
                            AND (s.transaction_hash = c.tx OR s.transaction_hash IS NULL))
      ON CONFLICT DO NOTHING
      RETURNING nft_id, transaction_hash
    ), marked AS (
      UPDATE public.topshot_sellback_walk_purchases p
         SET promote_outcome = CASE WHEN EXISTS (SELECT 1 FROM ins WHERE ins.nft_id = p.nft_id AND ins.transaction_hash = p.tx)
                                    THEN 'inserted_chain_read'
                                    WHEN c.edition_id IS NULL THEN 'edition_missing'
                                    ELSE 'already_in_sales' END,
             promoted_at = now()
        FROM cand c
       WHERE p.tx = c.tx AND p.nft_id = c.nft_id
      RETURNING p.promote_outcome
    )
    SELECT (SELECT count(*) FROM ins), (SELECT count(*) FROM marked WHERE promote_outcome = 'edition_missing')
      INTO v_promoted, v_missing;

    -- 5. DONE: the walk is finished (its job gone), nothing unresolved is waiting for a read,
    --    and no read is open -> this lane unschedules itself.
    IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rpc-topshot-sellback-walk')
       AND NOT EXISTS (SELECT 1 FROM public.topshot_sellback_walk_purchases
                        WHERE promote_outcome = 'unresolved_edition' AND edition_read_requested_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM public.topshot_sellback_edition_requests WHERE status IN ('pending', 'in_flight'))
       AND EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rpc-topshot-sellback-edition-reads') THEN
      PERFORM cron.unschedule('rpc-topshot-sellback-edition-reads');
    END IF;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_err := left(SQLERRM, 300);
  END;

  PERFORM public.log_pipeline_run('topshot-sellback-edition-reads', v_started, v_collected, v_promoted, v_failed,
    v_err IS NULL, v_err, 'nba_top_shot', NULL, NULL,
    jsonb_build_object('collected', v_collected, 'reads_new', v_reads_new, 'throttled', v_throttled,
                       'failed', v_failed, 'fallback_enqueued', v_fallback, 'chain_not_held', v_not_held,
                       'enqueued', v_enqueued, 'dispatched', v_dispatched, 'inflight_before', v_inflight,
                       'promoted', v_promoted, 'edition_missing', v_missing, 'via', 'pg_cron',
                       'duration_ms', (extract(epoch FROM clock_timestamp() - v_started) * 1000)::int));
  RETURN jsonb_build_object('collected', v_collected, 'reads_new', v_reads_new, 'throttled', v_throttled,
                            'failed', v_failed, 'fallback_enqueued', v_fallback, 'chain_not_held', v_not_held,
                            'enqueued', v_enqueued, 'dispatched', v_dispatched, 'promoted', v_promoted,
                            'edition_missing', v_missing, 'error', v_err);
END
$function$;

REVOKE EXECUTE ON FUNCTION public.run_topshot_sellback_edition_reads(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_topshot_sellback_edition_reads(integer) TO postgres, service_role;

DO $$
BEGIN
  IF has_function_privilege('anon', 'public.run_topshot_sellback_edition_reads(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'run_topshot_sellback_edition_reads must not be executable by anon';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rpc-topshot-sellback-edition-reads') THEN
    PERFORM cron.schedule('rpc-topshot-sellback-edition-reads', '* * * * *',
                          'SELECT public.run_topshot_sellback_edition_reads(4) FROM pg_sleep(20);');
  END IF;
END
$$;
