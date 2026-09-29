-- DB invariant: public.run_topshot_pull_chain_lane — a Top Shot pull is named by
-- READING THE CHAIN at its pack's rip block on the historical spork's access
-- node. Added 2026-09-29 (Rigged's 9,064 unnamed / inferred pulls; 269 of 269
-- ids read back, 216 of 216 set:play agreeing with what we knew). Claims:
--
--   E1. Packs with an unnamed or id-neighbour pull, rip block on/after the
--       mainnet24 root, are enqueued (priority = unnamed pulls); a pack whose
--       every pull a record names, or below the floor, is not.
--   D1. mainnet24 packs get the pre-Cadence-1.0 script on the mainnet24 node;
--       later ones the Cadence 1.0 script on their own spork's node; the read
--       asks for EVERY pull of the pack; <= 8 per node per tick.
--   C1. A landed read names an unnamed pull (resolved_via chain_history),
--       replaces an inference, corrects a record naming another edition (a
--       parallel filed under its base), leaves an agreeing record alone, and
--       NEVER folds a parallel we do not carry into its base.
--   C2. Its packs are requeued to reprice and n_inferred is recounted.
--   H1. A 429 is retried without counting as a failure (ok stays true); any
--       other error retries, counts an attempt and says ok=false; a read that
--       never lands expires after 30 minutes.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260929160000_audit_20260929_topshot_pulls_named_by_reading_the_chain_at_the_open_block.sql).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.editions (id uuid PRIMARY KEY, collection_id uuid, external_id text);
CREATE TABLE public.pack_open_pulls (
  collection_id uuid, pack_nft_id text, nft_id text, opener_address text, edition_id uuid,
  resolved_via text, resolved_at timestamptz, local_checked_at timestamptz,
  PRIMARY KEY (collection_id, pack_nft_id, nft_id));
CREATE TABLE public.pack_rips (collection_id uuid, pack_nft_id text, opener_address text, block_height bigint);
CREATE TABLE public.pack_open_pull_values (collection_id uuid, pack_nft_id text, priced_at timestamptz,
  n_inferred int NOT NULL DEFAULT 0, PRIMARY KEY (collection_id, pack_nft_id));
CREATE TABLE public.pipeline_runs_stub (pipeline text, ok boolean, extra jsonb);
CREATE FUNCTION public.log_pipeline_run(p_pipeline text, p_started_at timestamptz, p_rows_found int, p_rows_written int,
  p_rows_skipped int, p_ok boolean, p_error text, p_collection_slug text, p_cursor_before text, p_cursor_after text, p_extra jsonb)
RETURNS bigint LANGUAGE sql AS $$ INSERT INTO public.pipeline_runs_stub VALUES (p_pipeline, p_ok, p_extra) RETURNING 1::bigint $$;

-- pg_net stand-in: http_post records the call and returns an id; responses are
-- planted into net._http_response by the test.
CREATE SCHEMA net;
CREATE TABLE net._http_response (id bigint PRIMARY KEY, status_code int, content text, error_msg text);
CREATE SEQUENCE net.req_seq START 1000;
CREATE TABLE net.calls (id bigint, url text, body jsonb);
CREATE FUNCTION net.http_post(url text, body jsonb DEFAULT '{}'::jsonb, params jsonb DEFAULT '{}'::jsonb,
  headers jsonb DEFAULT '{}'::jsonb, timeout_milliseconds int DEFAULT 5000)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v bigint := nextval('net.req_seq');
BEGIN INSERT INTO net.calls VALUES (v, url, body); RETURN v; END $$;

-- the lane's own tables, as the migration creates them
CREATE TABLE public.topshot_chain_moment_reads (
  nft_id bigint PRIMARY KEY, set_id int NOT NULL, play_id int NOT NULL, serial_number int NOT NULL,
  subedition_id int NOT NULL, owner_address text NOT NULL, block_height bigint NOT NULL,
  read_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.topshot_pull_chain_requests (
  pack_nft_id text PRIMARY KEY, opener_address text NOT NULL, block_height bigint NOT NULL,
  priority int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_flight', 'done', 'failed')),
  request_id bigint, attempts int NOT NULL DEFAULT 0, dispatched_at timestamptz, finished_at timestamptz,
  n_asked int, n_read int, last_error text, created_at timestamptz NOT NULL DEFAULT now());

-- >>> BEGIN verbatim run_topshot_pull_chain_lane (body byte-identical to the migration) >>>
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
-- <<< END verbatim <<<

-- helpers: decode a dispatched call's script / ids; plant a 200 read
CREATE FUNCTION pg_temp.call_script(p_id bigint) RETURNS text LANGUAGE sql AS $$
  SELECT convert_from(decode(body->>'script', 'base64'), 'UTF8') FROM net.calls WHERE id = p_id $$;
CREATE FUNCTION pg_temp.call_ids(p_id bigint) RETURNS text[] LANGUAGE sql AS $$
  SELECT array_agg(x->>'value' ORDER BY x->>'value')
    FROM net.calls c, jsonb_array_elements(convert_from(decode(c.body->'arguments'->>1, 'base64'), 'UTF8')::jsonb->'value') x
   WHERE c.id = p_id $$;
CREATE FUNCTION pg_temp.plant_read(p_pack text, p_moments jsonb) RETURNS void LANGUAGE sql AS $$
  INSERT INTO net._http_response (id, status_code, content)
  SELECT q.request_id, 200,
         to_jsonb(translate(encode(convert_to(jsonb_build_object('type', 'Dictionary', 'value',
           coalesce((SELECT jsonb_agg(jsonb_build_object(
              'key', jsonb_build_object('type', 'UInt64', 'value', m->>0),
              'value', jsonb_build_object('type', 'Array', 'value', jsonb_build_array(
                 jsonb_build_object('type', 'UInt32', 'value', m->>1), jsonb_build_object('type', 'UInt32', 'value', m->>2),
                 jsonb_build_object('type', 'UInt32', 'value', m->>3), jsonb_build_object('type', 'UInt32', 'value', m->>4)))))
             FROM jsonb_array_elements(p_moments) m), '[]'::jsonb))::text, 'UTF8'), 'base64'), E'\n', ''))::text
    FROM public.topshot_pull_chain_requests q WHERE q.pack_nft_id = p_pack $$;

-- ── fixture ────────────────────────────────────────────────────────────────
-- editions: 10:100 base, 10:100::1 parallel, 10:200 base (no ::2 parallel), 11:300
INSERT INTO public.editions VALUES
  ('00000000-0000-0000-0000-00000000a100', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '10:100'),
  ('00000000-0000-0000-0000-00000000a101', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '10:100::1'),
  ('00000000-0000-0000-0000-00000000a200', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '10:200'),
  ('00000000-0000-0000-0000-00000000a300', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '11:300'),
  -- another collection's edition with the same external id: never used
  ('00000000-0000-0000-0000-00000000b300', 'dee28451-5d62-409e-a1ad-a83f763ac070', '11:300');

-- P24: mainnet24 pack (pre-Cadence-1.0), 4 pulls:
--   1001 unnamed -> chain 11:300
--   1002 inferred as 10:200 -> chain 10:100 (replaced)
--   1003 record 10:100 -> chain 10:100::1 (parallel filed under base: corrected)
--   1004 record 11:300 -> chain 11:300 (agrees: untouched)
-- P26: mainnet26 pack: 2001 unnamed -> chain 10:200::2 (not carried: stays unnamed)
--                      2002 unnamed -> never returned by the chain
-- PLOW: below the floor.  PDONE: every pull a record names.
INSERT INTO public.pack_rips VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'P24',   '0x00000000000000aa', 70000000),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'P26',   '0x00000000000000bb', 100000000),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'PLOW',  '0x00000000000000aa', 60000000),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'PDONE', '0x00000000000000aa', 100000001);
INSERT INTO public.pack_open_pulls (collection_id, pack_nft_id, nft_id, opener_address, edition_id, resolved_via) VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'P24', '1001', '0x00000000000000aa', NULL, NULL),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'P24', '1002', '0x00000000000000aa', '00000000-0000-0000-0000-00000000a200', 'id_neighbours'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'P24', '1003', '0x00000000000000aa', '00000000-0000-0000-0000-00000000a100', 'wallet_moments_cache'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'P24', '1004', '0x00000000000000aa', '00000000-0000-0000-0000-00000000a300', 'sales'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'P26', '2001', '0x00000000000000bb', NULL, NULL),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'P26', '2002', '0x00000000000000bb', NULL, NULL),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'PLOW', '3001', '0x00000000000000aa', NULL, NULL),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'PDONE', '4001', '0x00000000000000aa', '00000000-0000-0000-0000-00000000a300', 'sales');
INSERT INTO public.pack_open_pull_values (collection_id, pack_nft_id, priced_at, n_inferred) VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'P24', now(), 1),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'P26', now(), 0),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'PDONE', now(), 0);
-- ten more mainnet26 packs to exercise the per-node cap (P26 has the highest priority)
INSERT INTO public.pack_rips
SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'Q' || g, '0x00000000000000cc', 100000100 + g FROM generate_series(1, 10) g;
INSERT INTO public.pack_open_pulls (collection_id, pack_nft_id, nft_id, opener_address)
SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'Q' || g, (5000 + g)::text, '0x00000000000000cc' FROM generate_series(1, 10) g;

-- ── run 1: enqueue + dispatch ──────────────────────────────────────────────
DO $t$
DECLARE v jsonb; v_c24 bigint; v_c26 bigint;
BEGIN
  v := public.run_topshot_pull_chain_lane();

  -- E1
  IF NOT EXISTS (SELECT 1 FROM public.topshot_pull_chain_requests WHERE pack_nft_id = 'P24' AND priority = 1) THEN
    RAISE EXCEPTION 'E1: P24 not enqueued with priority 1 (one unnamed pull): %', v; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.topshot_pull_chain_requests WHERE pack_nft_id = 'P26' AND priority = 2) THEN
    RAISE EXCEPTION 'E1: P26 not enqueued with priority 2'; END IF;
  IF EXISTS (SELECT 1 FROM public.topshot_pull_chain_requests WHERE pack_nft_id IN ('PLOW', 'PDONE')) THEN
    RAISE EXCEPTION 'E1: a pack below the floor or fully record-named was enqueued'; END IF;
  IF (v->>'enqueued')::int <> 12 THEN RAISE EXCEPTION 'E1: enqueued % (want 12)', v->>'enqueued'; END IF;

  -- D1: the per-node cap
  IF (SELECT count(*) FROM net.calls WHERE url LIKE 'http://access-001.mainnet26.%') <> 8 THEN
    RAISE EXCEPTION 'D1: mainnet26 got % reads in one tick (cap 8)', (SELECT count(*) FROM net.calls WHERE url LIKE '%mainnet26%'); END IF;
  IF (SELECT status FROM public.topshot_pull_chain_requests WHERE pack_nft_id = 'P26') <> 'in_flight' THEN
    RAISE EXCEPTION 'D1: the highest-priority mainnet26 pack was not dispatched'; END IF;

  SELECT request_id INTO v_c24 FROM public.topshot_pull_chain_requests WHERE pack_nft_id = 'P24';
  SELECT request_id INTO v_c26 FROM public.topshot_pull_chain_requests WHERE pack_nft_id = 'P26';
  IF (SELECT url FROM net.calls WHERE id = v_c24) <> 'http://access-001.mainnet24.nodes.onflow.org:8070/v1/scripts?block_height=70000000' THEN
    RAISE EXCEPTION 'D1: P24 read went to %', (SELECT url FROM net.calls WHERE id = v_c24); END IF;
  IF pg_temp.call_script(v_c24) NOT LIKE '%pub fun main%' OR pg_temp.call_script(v_c24) NOT LIKE '%getCapability(%' THEN
    RAISE EXCEPTION 'D1: mainnet24 read is not the pre-Cadence-1.0 script'; END IF;
  IF pg_temp.call_script(v_c26) NOT LIKE '%access(all) fun main%' OR pg_temp.call_script(v_c26) LIKE '%pub fun%' THEN
    RAISE EXCEPTION 'D1: mainnet26 read is not the Cadence 1.0 script'; END IF;
  IF pg_temp.call_ids(v_c24) <> ARRAY['1001', '1002', '1003', '1004'] THEN
    RAISE EXCEPTION 'D1: P24 read asked for % (want every pull)', pg_temp.call_ids(v_c24); END IF;
  IF convert_from(decode((SELECT body->'arguments'->>0 FROM net.calls WHERE id = v_c24), 'base64'), 'UTF8')::jsonb
     <> '{"type": "Address", "value": "0x00000000000000aa"}'::jsonb THEN
    RAISE EXCEPTION 'D1: P24 read not addressed to its opener'; END IF;
END
$t$;

-- ── run 2: reads land ──────────────────────────────────────────────────────
SELECT pg_temp.plant_read('P24', '[["1001",11,300,7,0],["1002",10,100,8,0],["1003",10,100,9,1],["1004",11,300,10,0]]');
SELECT pg_temp.plant_read('P26', '[["2001",10,200,5,2]]');
-- Q1 throttled, Q2 a script error
INSERT INTO net._http_response (id, status_code, content)
SELECT request_id, 429, 'Too Many Requests' FROM public.topshot_pull_chain_requests WHERE pack_nft_id = 'Q10';
INSERT INTO net._http_response (id, status_code, content)
SELECT request_id, 400, '{"code":400,"message":"failed to execute script"}' FROM public.topshot_pull_chain_requests WHERE pack_nft_id = 'Q9';

DO $t$
DECLARE v jsonb;
BEGIN
  v := public.run_topshot_pull_chain_lane();

  -- C1
  IF (SELECT edition_id FROM public.pack_open_pulls WHERE nft_id = '1001') IS DISTINCT FROM '00000000-0000-0000-0000-00000000a300'
     OR (SELECT resolved_via FROM public.pack_open_pulls WHERE nft_id = '1001') <> 'chain_history' THEN
    RAISE EXCEPTION 'C1: unnamed pull not named from the chain (the Top Shot 11:300, not All Day''s): %', v; END IF;
  IF (SELECT edition_id FROM public.pack_open_pulls WHERE nft_id = '1002') IS DISTINCT FROM '00000000-0000-0000-0000-00000000a100'
     OR (SELECT resolved_via FROM public.pack_open_pulls WHERE nft_id = '1002') <> 'chain_history' THEN
    RAISE EXCEPTION 'C1: an inference was not replaced by the chain read'; END IF;
  IF (SELECT edition_id FROM public.pack_open_pulls WHERE nft_id = '1003') IS DISTINCT FROM '00000000-0000-0000-0000-00000000a101' THEN
    RAISE EXCEPTION 'C1: a parallel filed under its base was not corrected'; END IF;
  IF (SELECT resolved_via FROM public.pack_open_pulls WHERE nft_id = '1004') <> 'sales' THEN
    RAISE EXCEPTION 'C1: an agreeing record was rewritten'; END IF;
  IF (SELECT edition_id FROM public.pack_open_pulls WHERE nft_id = '2001') IS NOT NULL THEN
    RAISE EXCEPTION 'C1: a parallel we do not carry (10:200::2) was folded into its base'; END IF;
  IF (SELECT edition_id FROM public.pack_open_pulls WHERE nft_id = '2002') IS NOT NULL THEN
    RAISE EXCEPTION 'C1: a pull the chain did not return was named'; END IF;
  IF (v->>'named_new')::int <> 1 OR (v->>'named_over_inferred')::int <> 1 OR (v->>'records_corrected')::int <> 1
     OR (v->>'edition_missing')::int <> 1 THEN
    RAISE EXCEPTION 'C1: counts wrong: %', v; END IF;
  IF (SELECT serial_number FROM public.topshot_chain_moment_reads WHERE nft_id = 1003) <> 9
     OR (SELECT owner_address FROM public.topshot_chain_moment_reads WHERE nft_id = 1003) <> '0x00000000000000aa'
     OR (SELECT block_height FROM public.topshot_chain_moment_reads WHERE nft_id = 1003) <> 70000000 THEN
    RAISE EXCEPTION 'C1: the read was not recorded with serial, owner and height'; END IF;
  IF (SELECT n_read FROM public.topshot_pull_chain_requests WHERE pack_nft_id = 'P26') <> 1
     OR (SELECT status FROM public.topshot_pull_chain_requests WHERE pack_nft_id = 'P26') <> 'done'
     OR (v->>'short')::int <> 1 THEN
    RAISE EXCEPTION 'C1: a short read (1 of 2) not recorded as such: %', v; END IF;

  -- C2
  IF (SELECT priced_at FROM public.pack_open_pull_values WHERE pack_nft_id = 'P24') <> '-infinity' THEN
    RAISE EXCEPTION 'C2: P24 not requeued to reprice'; END IF;
  IF (SELECT n_inferred FROM public.pack_open_pull_values WHERE pack_nft_id = 'P24') <> 0 THEN
    RAISE EXCEPTION 'C2: P24 n_inferred % after its inference was replaced (want 0)',
      (SELECT n_inferred FROM public.pack_open_pull_values WHERE pack_nft_id = 'P24'); END IF;
  IF (SELECT priced_at FROM public.pack_open_pull_values WHERE pack_nft_id = 'PDONE') = '-infinity' THEN
    RAISE EXCEPTION 'C2: an untouched pack was requeued'; END IF;

  -- H1
  IF (SELECT status FROM public.topshot_pull_chain_requests WHERE pack_nft_id = 'Q10') NOT IN ('pending', 'in_flight')
     OR (SELECT attempts FROM public.topshot_pull_chain_requests WHERE pack_nft_id = 'Q10') <> 0 THEN
    RAISE EXCEPTION 'H1: a 429 counted as an attempt'; END IF;
  IF (SELECT attempts FROM public.topshot_pull_chain_requests WHERE pack_nft_id = 'Q9') <> 1
     OR (SELECT last_error FROM public.topshot_pull_chain_requests WHERE pack_nft_id = 'Q9') NOT LIKE 'http 400%' THEN
    RAISE EXCEPTION 'H1: a script error was not recorded as an attempt'; END IF;
  IF (v->>'ok')::boolean OR (v->>'throttled')::int <> 1 OR (v->>'failed')::int <> 1 THEN
    RAISE EXCEPTION 'H1: ok/throttled/failed wrong: %', v; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.pipeline_runs_stub WHERE pipeline = 'pack-pulls-chain-history' AND NOT ok) THEN
    RAISE EXCEPTION 'H1: the failed run was not logged ok=false'; END IF;
END
$t$;

-- ── run 3: a read that never lands expires ─────────────────────────────────
UPDATE public.topshot_pull_chain_requests SET dispatched_at = now() - interval '31 minutes'
 WHERE status = 'in_flight' AND pack_nft_id = 'Q1';
DO $t$
DECLARE v jsonb;
BEGIN
  v := public.run_topshot_pull_chain_lane();
  IF (SELECT last_error FROM public.topshot_pull_chain_requests WHERE pack_nft_id = 'Q1') IS DISTINCT FROM 'no_response'
     OR (SELECT attempts FROM public.topshot_pull_chain_requests WHERE pack_nft_id = 'Q1') <> 1 THEN
    RAISE EXCEPTION 'H1: an unlanded read did not expire: %', v; END IF;
  -- an already-named pull is not renamed again (idempotent)
  IF (v->>'named_new')::int <> 0 OR (v->>'records_corrected')::int <> 0 OR (v->>'named_over_inferred')::int <> 0 THEN
    RAISE EXCEPTION 'C1: a second run renamed pulls: %', v; END IF;
END
$t$;

ROLLBACK;
