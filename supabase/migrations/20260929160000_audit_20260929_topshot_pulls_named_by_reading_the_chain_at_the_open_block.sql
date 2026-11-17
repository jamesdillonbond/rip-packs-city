-- 2026-09-29 (PT) — a Top Shot pull is named by READING THE CHAIN at the block
-- its pack was opened in, on the historical spork's access node.
--
-- WHY (Trevor: "get creative and see what you can do to find this out on your
-- own"). 9,064 of Rigged's (0xf77bf547fccf6656) Top Shot pulls and ~24,500
-- estate-wide carried no record name (7,216 / ~11,500 of them only an
-- id-neighbour inference). The moments have left every wallet we walk, and
-- every off-chain source is closed (packs.md). But the chain still HAS them:
-- Flow's historical access nodes (access-001.mainnet24..27.nodes.onflow.org,
-- port 8070, reachable from pg_net; mainnet23 and older no longer resolve)
-- execute a script at any height of their spork. At the rip block the opener's
-- collection holds every pulled moment, so one script per pack returns each
-- pull's setID / playID / serial and TopShot.getMomentsSubedition (parallel).
--
-- Measured 2026-09-29, 150 random estate packs (mixed named + unnamed):
--   * 269 of 269 pull ids asked were present at the rip block;
--   * 114 of 116 record names agree; the 2 others and 1 of 99 inferred names
--     are PARALLELS the record files under the base edition (124:5056 vs the
--     chain's 124:5056::1) -- the chain is the finer answer;
--   * 98 of 99 id-neighbour inferences agree at set:play;
--   * 54 of 54 unnamed pulls map to an edition we carry.
--   Syntax: mainnet24 still runs pre-Cadence-1.0 (`pub fun`, getCapability);
--   mainnet25 rejects `pub` (its nodes run Cadence 1.0); 25-28 take the 1.0
--   script. mainnet26 answers 429 to a burst of 105, so dispatch is capped per
--   node per tick.
--
-- WHAT.
--   topshot_chain_moment_reads     nft_id -> set/play/serial/subedition as read
--                                  on chain at the rip block (a RECORD).
--   topshot_pull_chain_requests    one script read per pack: pending ->
--                                  in_flight -> done | failed (6 attempts).
--   run_topshot_pull_chain_lane()  collects landed reads, names pulls
--                                  (resolved_via = 'chain_history'; it
--                                  REPLACES an id-neighbour inference and
--                                  corrects a record naming a different
--                                  edition), requeues their packs to reprice
--                                  and keeps n_inferred, enqueues packs with an
--                                  unnamed or inferred pull (rip block on/after
--                                  the mainnet24 root), dispatches <= 8 per
--                                  node per tick. pg_cron
--                                  rpc-topshot-pull-chain-lane every minute.
--   A read whose edition we do not carry names nothing (a parallel is never
--   folded into its base); it is counted as edition_missing.
-- anon-exec: run_topshot_pull_chain_lane() — new; REVOKE FROM PUBLIC, anon, authenticated below.
--
-- Revert:
--   SELECT cron.unschedule('rpc-topshot-pull-chain-lane');
--   UPDATE public.pack_open_pulls SET edition_id = NULL, resolved_via = NULL, resolved_at = NULL, local_checked_at = NULL
--    WHERE resolved_via = 'chain_history';   -- the other lanes re-name what they can
--   UPDATE public.pack_open_pull_values SET priced_at = '-infinity'
--    WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd';
--   DROP FUNCTION public.run_topshot_pull_chain_lane();
--   DROP TABLE public.topshot_pull_chain_requests, public.topshot_chain_moment_reads;

CREATE TABLE IF NOT EXISTS public.topshot_chain_moment_reads (
  nft_id         bigint PRIMARY KEY,
  set_id         int NOT NULL,
  play_id        int NOT NULL,
  serial_number  int NOT NULL,
  subedition_id  int NOT NULL,
  owner_address  text NOT NULL,
  block_height   bigint NOT NULL,
  read_at        timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.topshot_chain_moment_reads IS
  'Top Shot moments read ON CHAIN (historical spork access node) in their opener''s collection at the block their pack was opened: setID, playID, serial, subedition (0 = standard). A record, not an inference. Written by run_topshot_pull_chain_lane().';
ALTER TABLE public.topshot_chain_moment_reads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.topshot_chain_moment_reads FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.topshot_pull_chain_requests (
  pack_nft_id    text PRIMARY KEY,
  opener_address text NOT NULL,
  block_height   bigint NOT NULL,
  priority       int NOT NULL DEFAULT 0,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_flight', 'done', 'failed')),
  request_id     bigint,
  attempts       int NOT NULL DEFAULT 0,
  dispatched_at  timestamptz,
  finished_at    timestamptz,
  n_asked        int,
  n_read         int,
  last_error     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.topshot_pull_chain_requests IS
  'One historical-chain script read per Top Shot pack (all its pulls at the rip block). Driven by run_topshot_pull_chain_lane().';
CREATE INDEX IF NOT EXISTS idx_topshot_pull_chain_requests_status
  ON public.topshot_pull_chain_requests (status, priority DESC, block_height DESC);
ALTER TABLE public.topshot_pull_chain_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.topshot_pull_chain_requests FROM anon, authenticated;


-- ── run_topshot_pull_chain_lane ─────────────────────────────────────────────
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
  v_floor     constant bigint := 65264619;   -- mainnet24 root: older sporks no longer resolve
  v_per_node  constant int := 8;
  v_max_att   constant int := 6;
  -- mainnet24 still executes pre-Cadence-1.0 scripts
  v_src_pre   constant text := 'import TopShot from 0x0b2a3299cc857e29
pub fun main(owner: Address, ids: [UInt64]): {UInt64: [UInt32]} {
  let out: {UInt64: [UInt32]} = {}
  let col = getAccount(owner).getCapability(/public/MomentCollection).borrow<&{TopShot.MomentCollectionPublic}>()
  if col == nil { return out }
  for id in ids { if let m = col!.borrowMoment(id: id) { out[id] = [m.data.setID, m.data.playID, m.data.serialNumber, TopShot.getMomentsSubedition(nftID: id) ?? 0] } }
  return out
}';
  v_src_c1    constant text := 'import TopShot from 0x0b2a3299cc857e29
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
  v_packs int := 0; v_enqueued int := 0; v_dispatched int := 0;
  v_last_error text := NULL;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('run_topshot_pull_chain_lane')) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'another run holds the lock');
  END IF;

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
             CASE WHEN q.block_height <= 85981134  THEN 'http://access-001.mainnet24.nodes.onflow.org:8070'
                  WHEN q.block_height <= 88226266  THEN 'http://access-001.mainnet25.nodes.onflow.org:8070'
                  WHEN q.block_height <= 130290658 THEN 'http://access-001.mainnet26.nodes.onflow.org:8070'
                  WHEN q.block_height <= 137390145 THEN 'http://access-001.mainnet27.nodes.onflow.org:8070'
                  ELSE 'https://rest-mainnet.onflow.org' END AS node
        FROM public.topshot_pull_chain_requests q
       WHERE q.status = 'pending'
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
        'script', translate(encode(convert_to(CASE WHEN r.block_height <= 85981134 THEN v_src_pre ELSE v_src_c1 END, 'UTF8'), 'base64'), E'\n', ''),
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
    v_collected, v_named_new + v_named_over_inferred + v_corrected, v_edition_missing,
    (v_failed = 0), v_last_error,
    'nba_top_shot', NULL, NULL,
    jsonb_build_object('reads_done', v_done, 'reads_failed', v_failed, 'reads_throttled', v_throttled,
                       'reads_expired', v_expired, 'reads_short', v_short, 'moments_read_new', v_reads_new,
                       'named_new', v_named_new, 'named_over_inferred', v_named_over_inferred,
                       'records_corrected', v_corrected, 'edition_missing', v_edition_missing,
                       'packs_requeued', v_packs, 'enqueued', v_enqueued, 'dispatched', v_dispatched)
  );

  RETURN jsonb_build_object('ok', v_failed = 0, 'collected', v_collected, 'done', v_done, 'failed', v_failed,
                            'throttled', v_throttled, 'expired', v_expired, 'short', v_short,
                            'moments_read_new', v_reads_new, 'named_new', v_named_new,
                            'named_over_inferred', v_named_over_inferred, 'records_corrected', v_corrected,
                            'edition_missing', v_edition_missing, 'packs_requeued', v_packs,
                            'enqueued', v_enqueued, 'dispatched', v_dispatched, 'last_error', v_last_error);
END;
$function$;

REVOKE ALL ON FUNCTION public.run_topshot_pull_chain_lane() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_topshot_pull_chain_lane() TO postgres, service_role;

SELECT cron.schedule('rpc-topshot-pull-chain-lane', '* * * * *', 'SELECT public.run_topshot_pull_chain_lane();');
