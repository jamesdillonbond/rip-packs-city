-- audit_20261107_topshot_pull_chain_lane_floor_at_mainnet27
--
-- WHY. Sentinel 11-07 10:04 PM PT WARN "Zero-Yield Lanes: pack-pulls-chain-history". The 11-06
-- read ("0 unresolved pulls in 14 d, nothing to read") no longer holds: ~300 Top Shot packs
-- opened before 2025-10-22 entered pack_open_pulls on 11-07 (all first_seen_at 11-07), the lane
-- enqueued them at 6:34 PM PT, and routed every one at or below block 130,290,658 to
-- access-001.mainnet24/25/26.nodes.onflow.org. Flow retired those nodes (#181: no TCP handshake
-- from 10-09, no DNS record by 10-23; the chain-arrival lane was retired off them in
-- 20261023213517, this lane was not). Measured in net._http_response, 6:34-10:34 PM PT:
-- 1,800 "Couldn't resolve host name" (all this lane), while the same ticks' mainnet27 (13) and
-- rest-mainnet (19) reads returned 200 and named their pulls. All 300 packs went terminal
-- `failed` after 6 attempts; 862 pulls stay unnamed - they are NOT readable by any node, so
-- this is a cost + honesty fix, not a recovery.
--
-- WHAT.
--   * v_floor 65264619 (mainnet24 root) -> 130290659 (mainnet27 root): such packs are no longer
--     enqueued, and the dispatch reads only >= the floor (mainnet27 node or rest-mainnet).
--   * new step (0): a pending request below the floor is closed `failed` with the #181 reason,
--     never dispatched; a failed one still carrying the dead node's DNS error is relabelled with
--     the same reason (the 11-07 300). Any other failure is left alone. Counted as
--     extra.retired_pre_mainnet27.
--   * the pre-Cadence-1.0 script (only mainnet24 executed it) is removed with its node.
--   * rows_found = v_done (reads that returned a result), was v_collected (every landed
--     response, DNS failures included - 1,800 of them would have read as "found" today).
--   * a pipeline_zero_yield_suppressions row with its re-check condition (below).
--
-- PIN: supabase/tests/run_topshot_pull_chain_lane.sql (R1 added; fixture re-based on mainnet27 /
--   rest-mainnet; passes locally, and a planted old floor / disabled step (0) turns it red).
-- anon-exec: unchanged (run_topshot_pull_chain_lane) - CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false, authenticated=false (2026-11-07).
-- Revert: re-run the CREATE OR REPLACE body from 20260929161000_audit_20260929_chain_pull_lane_20_reads_per_node.sql
--   (it re-enqueues nothing already failed: ON CONFLICT DO NOTHING), and
--   DELETE FROM public.pipeline_zero_yield_suppressions WHERE pipeline = 'pack-pulls-chain-history';

CREATE OR REPLACE FUNCTION public.run_topshot_pull_chain_lane()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '110s'
AS $function$
DECLARE
  v_started   timestamptz := clock_timestamp();
  v_ts        constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  -- mainnet27 root. Flow retired the mainnet24-26 access nodes (#181: no TCP
  -- handshake from 10-09, no DNS record from <= 10-23), so an older rip block
  -- has no node to read it at; 2026-11-07 300 such packs burned 1,800 DNS
  -- failures in 4 h and went terminal. They are now closed without a read.
  v_floor     constant bigint := 130290659;
  v_retired_msg constant text := 'rip block before 130290659 (mainnet27 root): Flow retired the mainnet24-26 access nodes, so the open block is not readable (#181)';
  v_per_node  constant int := 20;
  v_max_att   constant int := 6;
  v_src_c1   constant text := 'import TopShot from 0x0b2a3299cc857e29
access(all) fun main(owner: Address, ids: [UInt64]): {UInt64: [UInt32]} {
  let out: {UInt64: [UInt32]} = {}
  let col = getAccount(owner).capabilities.borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection)
  if col == nil { return out }
  for id in ids { if let m = col!.borrowMoment(id: id) { out[id] = [m.data.setID, m.data.playID, m.data.serialNumber, TopShot.getMomentsSubedition(nftID: id) ?? 0] } }
  return out
}';
  r record;
  v_body jsonb; v_n int; v_ins int; v_req bigint; v_ids text[];
  v_collected int := 0; v_done int := 0; v_failed int := 0; v_throttled int := 0; v_expired int := 0;
  v_reads_new int := 0; v_short int := 0;
  v_named_new int := 0; v_named_over_inferred int := 0; v_corrected int := 0; v_edition_missing int := 0;
  v_packs int := 0; v_enqueued int := 0; v_dispatched int := 0; v_retired int := 0;
  v_last_error text := NULL;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('run_topshot_pull_chain_lane')) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'another run holds the lock');
  END IF;

  -- (0) A request below the floor has no node to read it: close it as failed,
  -- saying why, and never dispatch it. A failed one still carrying the dead
  -- node's DNS error is relabelled with the same reason (the 11-07 300).
  WITH ret AS (
    UPDATE public.topshot_pull_chain_requests
       SET status = 'failed', request_id = NULL, last_error = v_retired_msg,
           finished_at = coalesce(finished_at, now())
     WHERE block_height < v_floor
       AND (status = 'pending' OR (status = 'failed' AND last_error = 'Couldn''t resolve host name'))
    RETURNING 1
  )
  SELECT count(*) INTO v_retired FROM ret;

  -- (1) Collect every landed read.
  FOR r IN
    SELECT q.*, h.status_code AS h_status, h.content AS h_content, h.error_msg AS h_error, (h.id IS NOT NULL) AS landed
      FROM public.topshot_pull_chain_requests q
      LEFT JOIN net._http_response h ON h.id = q.request_id
     WHERE q.status = 'in_flight'
     ORDER BY q.dispatched_at
  LOOP
    IF NOT r.landed THEN
      IF r.dispatched_at < now() - interval '30 minutes' THEN
        UPDATE public.topshot_pull_chain_requests
           SET status = CASE WHEN attempts + 1 >= v_max_att THEN 'failed' ELSE 'pending' END,
               attempts = attempts + 1, last_error = 'no_response',
               finished_at = CASE WHEN attempts + 1 >= v_max_att THEN now() END
         WHERE pack_nft_id = r.pack_nft_id;
        v_expired := v_expired + 1;
      END IF;
      CONTINUE;
    END IF;
    v_collected := v_collected + 1;

    -- 200 carries a JSON string: base64 of the JSON-Cadence result
    v_body := NULL;
    IF r.h_status = 200 AND pg_input_is_valid(r.h_content, 'jsonb') THEN
      BEGIN
        v_body := convert_from(decode(r.h_content::jsonb #>> '{}', 'base64'), 'UTF8')::jsonb;
      EXCEPTION WHEN others THEN
        v_body := NULL;
      END;
    END IF;

    IF v_body IS NULL OR v_body->>'type' IS DISTINCT FROM 'Dictionary' THEN
      -- a 429 is the node's throttle, not a wrong read: retried, not a failure
      IF r.h_status = 429 THEN
        UPDATE public.topshot_pull_chain_requests
           SET status = 'pending', request_id = NULL, last_error = 'http 429'
         WHERE pack_nft_id = r.pack_nft_id;
        v_throttled := v_throttled + 1;
        CONTINUE;
      END IF;
      v_last_error := left(coalesce(r.h_error, 'http ' || coalesce(r.h_status::text, 'null') || ': ' || r.h_content), 300);
      UPDATE public.topshot_pull_chain_requests
         SET status = CASE WHEN attempts + 1 >= v_max_att THEN 'failed' ELSE 'pending' END,
             attempts = attempts + 1, request_id = NULL, last_error = v_last_error,
             finished_at = CASE WHEN attempts + 1 >= v_max_att THEN now() END
       WHERE pack_nft_id = r.pack_nft_id;
      v_failed := v_failed + 1;
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
      SELECT nft_id, set_id, play_id, serial_number, subedition_id, r.opener_address, r.block_height
        FROM kv
       WHERE set_id IS NOT NULL AND play_id IS NOT NULL
      ON CONFLICT (nft_id) DO NOTHING
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM ins), (SELECT count(*) FROM kv) INTO v_ins, v_n;
    v_reads_new := v_reads_new + v_ins;
    IF v_n < coalesce(r.n_asked, 0) THEN v_short := v_short + 1; END IF;

    UPDATE public.topshot_pull_chain_requests
       SET status = 'done', finished_at = now(), n_read = v_n, last_error = NULL
     WHERE pack_nft_id = r.pack_nft_id;
    v_done := v_done + 1;
  END LOOP;

  -- (2) Name pulls from the chain. A chain read at the open block is the best
  -- source we have: it replaces an id-neighbour inference and corrects a
  -- record naming another edition (a parallel filed under its base). A read
  -- whose edition we do not carry names nothing. Reads of the last 15 minutes
  -- each tick; every read once an hour (an edition added to the catalogue
  -- later is then picked up).
  WITH m AS MATERIALIZED (
    SELECT o.pack_nft_id, o.nft_id, o.edition_id AS cur, o.resolved_via AS cur_via, e.id AS ed
      FROM public.topshot_chain_moment_reads c
      JOIN public.pack_open_pulls o
        ON o.collection_id = v_ts AND o.nft_id = c.nft_id::text
      LEFT JOIN public.editions e
        ON e.collection_id = v_ts
       AND e.external_id = CASE WHEN c.subedition_id = 0 THEN c.set_id || ':' || c.play_id
                                ELSE c.set_id || ':' || c.play_id || '::' || c.subedition_id END
     WHERE (c.read_at > now() - interval '15 minutes' OR extract(minute FROM now())::int = 7)
       AND (e.id IS NULL OR o.edition_id IS NULL OR o.resolved_via = 'id_neighbours' OR o.edition_id <> e.id)
  ), upd AS (
    UPDATE public.pack_open_pulls o
       SET edition_id = m.ed, resolved_via = 'chain_history', resolved_at = now()
      FROM m
     WHERE m.ed IS NOT NULL
       AND o.collection_id = v_ts AND o.pack_nft_id = m.pack_nft_id AND o.nft_id = m.nft_id
       AND (o.edition_id IS NULL OR o.resolved_via = 'id_neighbours' OR o.edition_id <> m.ed)
    RETURNING o.pack_nft_id, m.cur, m.cur_via
  ), rq AS (
    UPDATE public.pack_open_pull_values v
       SET priced_at = '-infinity'
      FROM (SELECT DISTINCT pack_nft_id FROM upd) u
     WHERE v.collection_id = v_ts AND v.pack_nft_id = u.pack_nft_id
    RETURNING 1
  )
  SELECT count(*) FILTER (WHERE cur IS NULL),
         count(*) FILTER (WHERE cur IS NOT NULL AND cur_via = 'id_neighbours'),
         count(*) FILTER (WHERE cur IS NOT NULL AND cur_via IS DISTINCT FROM 'id_neighbours'),
         (SELECT count(*) FROM rq),
         (SELECT count(*) FROM m WHERE m.ed IS NULL)
    INTO v_named_new, v_named_over_inferred, v_corrected, v_packs, v_edition_missing
    FROM upd;

  -- n_inferred of the packs just requeued (a separate statement: the CTEs
  -- above see the table as it was before upd)
  UPDATE public.pack_open_pull_values v
     SET n_inferred = c.n
    FROM (SELECT v2.pack_nft_id,
                 (SELECT count(*) FROM public.pack_open_pulls x
                   WHERE x.collection_id = v_ts AND x.pack_nft_id = v2.pack_nft_id
                     AND x.resolved_via = 'id_neighbours') AS n
            FROM public.pack_open_pull_values v2
           WHERE v2.collection_id = v_ts AND v2.priced_at = '-infinity' AND v2.n_inferred > 0) c
   WHERE v.collection_id = v_ts AND v.pack_nft_id = c.pack_nft_id AND v.n_inferred IS DISTINCT FROM c.n;

  -- (3) Enqueue packs with an unnamed or inferred pull (every 15 min, or when
  -- nothing is pending). More unnamed pulls first.
  IF extract(minute FROM now())::int % 15 = 0
     OR NOT EXISTS (SELECT 1 FROM public.topshot_pull_chain_requests WHERE status = 'pending') THEN
    WITH ins AS (
      INSERT INTO public.topshot_pull_chain_requests (pack_nft_id, opener_address, block_height, priority)
      SELECT rp.pack_nft_id, rp.opener_address, rp.block_height,
             count(*) FILTER (WHERE o.edition_id IS NULL)
        FROM public.pack_open_pulls o
        JOIN public.pack_rips rp ON rp.collection_id = o.collection_id AND rp.pack_nft_id = o.pack_nft_id
       WHERE o.collection_id = v_ts
         AND (o.edition_id IS NULL OR o.resolved_via = 'id_neighbours')
         AND o.nft_id ~ '^[0-9]{1,15}$'
         AND rp.block_height >= v_floor
         AND rp.opener_address ~ '^0x[0-9a-f]{16}$'
       GROUP BY rp.pack_nft_id, rp.opener_address, rp.block_height
      ON CONFLICT (pack_nft_id) DO NOTHING
      RETURNING 1
    )
    SELECT count(*) INTO v_enqueued FROM ins;
  END IF;

  -- (4) Dispatch: <= v_per_node pending reads per spork node per tick; each
  -- asks for EVERY pull of the pack (the named ones check the read).
  FOR r IN
    WITH p AS (
      SELECT q.*,
             CASE WHEN q.block_height <= 137390145 THEN 'http://access-001.mainnet27.nodes.onflow.org:8070'
                  ELSE 'https://rest-mainnet.onflow.org' END AS node
        FROM public.topshot_pull_chain_requests q
       WHERE q.status = 'pending' AND q.block_height >= v_floor
    ), ranked AS (
      SELECT p.*, row_number() OVER (PARTITION BY p.node ORDER BY p.priority DESC, p.block_height DESC) AS rn
        FROM p
    )
    SELECT * FROM ranked WHERE rn <= v_per_node
  LOOP
    SELECT array_agg(o.nft_id ORDER BY o.nft_id) INTO v_ids
      FROM public.pack_open_pulls o
     WHERE o.collection_id = v_ts AND o.pack_nft_id = r.pack_nft_id AND o.nft_id ~ '^[0-9]{1,15}$';
    IF v_ids IS NULL THEN
      UPDATE public.topshot_pull_chain_requests
         SET status = 'done', finished_at = now(), n_asked = 0, n_read = 0, last_error = 'no moment pulls'
       WHERE pack_nft_id = r.pack_nft_id;
      CONTINUE;
    END IF;
    SELECT net.http_post(
      url := r.node || '/v1/scripts?block_height=' || r.block_height,
      body := jsonb_build_object(
        'script', translate(encode(convert_to(v_src_c1, 'UTF8'), 'base64'), E'\n', ''),
        'arguments', jsonb_build_array(
          translate(encode(convert_to(jsonb_build_object('type', 'Address', 'value', r.opener_address)::text, 'UTF8'), 'base64'), E'\n', ''),
          translate(encode(convert_to(jsonb_build_object('type', 'Array', 'value',
            (SELECT jsonb_agg(jsonb_build_object('type', 'UInt64', 'value', i)) FROM unnest(v_ids) i))::text, 'UTF8'), 'base64'), E'\n', ''))),
      headers := '{"Content-Type": "application/json"}'::jsonb,
      timeout_milliseconds := 30000
    ) INTO v_req;
    UPDATE public.topshot_pull_chain_requests
       SET status = 'in_flight', request_id = v_req, dispatched_at = now(), n_asked = cardinality(v_ids)
     WHERE pack_nft_id = r.pack_nft_id;
    v_dispatched := v_dispatched + 1;
  END LOOP;

  PERFORM public.log_pipeline_run(
    'pack-pulls-chain-history', v_started,
    -- rows_found = reads that RETURNED a result, not every landed response: a
    -- DNS failure is not yield (2026-11-07: 1,800 of them read as "found").
    v_done, v_named_new + v_named_over_inferred + v_corrected, v_edition_missing,
    (v_failed = 0), v_last_error,
    'nba_top_shot', NULL, NULL,
    jsonb_build_object('reads_done', v_done, 'reads_failed', v_failed, 'reads_throttled', v_throttled,
                       'reads_expired', v_expired, 'reads_short', v_short, 'moments_read_new', v_reads_new,
                       'named_new', v_named_new, 'named_over_inferred', v_named_over_inferred,
                       'records_corrected', v_corrected, 'edition_missing', v_edition_missing,
                       'packs_requeued', v_packs, 'enqueued', v_enqueued, 'dispatched', v_dispatched,
                       'retired_pre_mainnet27', v_retired)
  );

  RETURN jsonb_build_object('ok', v_failed = 0, 'collected', v_collected, 'done', v_done, 'failed', v_failed,
                            'throttled', v_throttled, 'expired', v_expired, 'short', v_short,
                            'moments_read_new', v_reads_new, 'named_new', v_named_new,
                            'named_over_inferred', v_named_over_inferred, 'records_corrected', v_corrected,
                            'edition_missing', v_edition_missing, 'packs_requeued', v_packs,
                            'enqueued', v_enqueued, 'dispatched', v_dispatched, 'retired_pre_mainnet27', v_retired,
                            'last_error', v_last_error);
END;
$function$;

-- The lane is idle once those packs are retired: every Top Shot pull it could name is either
-- named, or pre-mainnet27 and unreadable. Without this row the Zero-Yield arm re-warns when the
-- 11-07 bucket ages out of its window.
INSERT INTO public.pipeline_zero_yield_suppressions (pipeline, reason, added_by)
VALUES ('pack-pulls-chain-history',
  'IDLE + UNREADABLE REMAINDER, measured 2026-11-07 ~11:15 PM PT. Every Top Shot pull the lane could enqueue (unnamed or id_neighbours, numeric nft_id, valid opener) is on a pack whose rip block is below 130290659 (mainnet27 root): 862 pulls / 300 packs, all first seen 11-07, all now failed with the #181 reason (Flow retired the mainnet24-26 access nodes; 1,800 DNS failures 6:34-10:34 PM PT). Positive control: the same ticks read 13 mainnet27 + 19 rest-mainnet packs and named them, so the lane reads when a readable pack exists. RE-CHECK CONDITION: remove this row if any eligible Top Shot pull on a pack with rip block >= 130290659 has no topshot_pull_chain_requests row (or a pending one) for more than a day while rows_found stays 0, or if extra.reads_failed > 0 on a mainnet27/rest-mainnet read.',
  'claude-code-cloud session_014vX7Q854dCGWEvcBjJ5zAQ')
ON CONFLICT (pipeline) DO UPDATE SET reason = EXCLUDED.reason, added_by = EXCLUDED.added_by, added_at = now();
