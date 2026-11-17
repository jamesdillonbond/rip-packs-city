-- 2026-09-29 (PT) — Disney Pinnacle pack pulls named by reading the pin itself on Flow's historical sporks.
--
-- WHY. After 20260930004000, 55,437 Pinnacle opens were still unpriced and 55,283 of them hold a pull NO
-- source we keep can name: no mint event (pinnacle_mint_events starts at the 2025-12-29 spork), and the pin
-- is in no walked wallet, no recorded sale, no live listing. 51,161 of those opens have an opener (read from
-- the open tx by run_pinnacle_opener_lane) and an open block at or after the mainnet24 root, and at the open
-- block the opener's collection HOLDS every pulled pin. So one script read there names it: the pin's own
-- editionID, which pinnacle_catalog.edition_id maps 1:1 to a render (unique index; the mapping agrees with
-- the mint events on 483,406 / 483,406 pins).
-- Probe before shipping (2026-09-29 ~6:00 PM PT, 3 known packs per spork): mainnet24 answers only the
-- pre-Cadence-1.0 script, mainnet25..28 only the Cadence 1.0 one; 15 / 15 returned the known edition.
--
-- WHAT.
--   pinnacle_pull_chain_reads: one row per pin read on chain (nft_id -> edition_id, owner, height).
--   pinnacle_pull_chain_pins: one row per pin to read. Stage 1 reads an opener's pins in ~1-day groups
--     (open_block / 100000, <= 200 ids) at the group's LAST open block — 8,222 calls on mainnet24 instead
--     of 19,250; a pin the opener no longer held there (sold in between) goes to stage 2, read at its own
--     open block, where the opener held it by construction. Not held there either -> 'missing'.
--   run_pinnacle_pull_chain_lane(): collect (reads land; the pins' unpriced opens get priced_at = NULL so
--     the pricer retries them next run), enqueue (every 10 min or when idle), dispatch (<= 10 calls per
--     node per tick, saved/seeded wallets' openers first; 429 = free retry; 6 other failures -> 'failed').
--     pg_cron rpc-pinnacle-pull-chain-lane every minute.
--   price_pinnacle_pack_opens: a chain read names the pin after the mint event and before the secondary
--     sources (it is a record of the NFT itself, as the mint event is).
-- anon-exec: run_pinnacle_pull_chain_lane() — new; REVOKE FROM PUBLIC, anon, authenticated below.
-- anon-exec: price_pinnacle_pack_opens(integer) — CREATE OR REPLACE of an existing fn; ACL re-stated below.
--
-- Revert:
--   SELECT cron.unschedule('rpc-pinnacle-pull-chain-lane');
--   re-run the price_pinnacle_pack_opens block of
--     supabase/migrations/20260930004000_audit_20260929_pinnacle_pack_opens_priced_via_sales_and_listings.sql
--   DROP FUNCTION public.run_pinnacle_pull_chain_lane();
--   DROP TABLE public.pinnacle_pull_chain_pins, public.pinnacle_pull_chain_reads;
--   (packs priced from a chain read keep their value; to clear them:
--    UPDATE public.pinnacle_pack_opens o SET pull_value_usd = NULL WHERE o.pull_value_usd IS NOT NULL
--      AND EXISTS (SELECT 1 FROM unnest(o.nft_ids) u(id) WHERE NOT EXISTS
--        (SELECT 1 FROM public.pinnacle_mint_events m WHERE m.nft_id = u.id)); then re-run the pricer.)

CREATE TABLE IF NOT EXISTS public.pinnacle_pull_chain_reads (
  nft_id         text PRIMARY KEY,
  edition_id     int NOT NULL,
  owner_address  text NOT NULL,
  block_height   bigint NOT NULL,
  read_at        timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.pinnacle_pull_chain_reads IS
  'Disney Pinnacle pins read on chain at a pack''s open block (the opener held them there): the pin''s own editionID. Written by run_pinnacle_pull_chain_lane(); read by price_pinnacle_pack_opens(). 2026-09-29.';
ALTER TABLE public.pinnacle_pull_chain_reads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pinnacle_pull_chain_reads FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.pinnacle_pull_chain_pins (
  nft_id          text PRIMARY KEY,
  opener_address  text NOT NULL,
  open_block      bigint NOT NULL,
  spork           int NOT NULL,   -- node index 1..5 = mainnet24..28 (as pinnacle_opener_windows.spork)
  stage           smallint NOT NULL DEFAULT 1 CHECK (stage IN (1, 2)),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_flight', 'read', 'missing', 'failed')),
  request_id      bigint,
  req_block       bigint,
  attempts        int NOT NULL DEFAULT 0,
  dispatched_at   timestamptz,
  finished_at     timestamptz,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.pinnacle_pull_chain_pins IS
  'Work queue of run_pinnacle_pull_chain_lane(): one row per unnamed Pinnacle pack pull. Stage 1 = read in an opener group at its last open block; stage 2 = read at the pin''s own open block. 2026-09-29.';
CREATE INDEX IF NOT EXISTS idx_pinnacle_pull_chain_pins_pending
  ON public.pinnacle_pull_chain_pins (spork, stage, opener_address, open_block) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_pinnacle_pull_chain_pins_in_flight
  ON public.pinnacle_pull_chain_pins (request_id) WHERE status = 'in_flight';
ALTER TABLE public.pinnacle_pull_chain_pins ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pinnacle_pull_chain_pins FROM anon, authenticated;


-- ── run_pinnacle_pull_chain_lane ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.run_pinnacle_pull_chain_lane()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '110s'
AS $function$
DECLARE
  v_started  timestamptz := clock_timestamp();
  v_per_node constant int := 10;
  v_max_att  constant int := 6;
  v_max_ids  constant int := 200;
  -- mainnet24..27 roots/ends; 28 = current spork
  v_roots    constant bigint[] := ARRAY[65264619, 85981135, 88226267, 130290659, 137390146]::bigint[];
  v_ends     constant bigint[] := ARRAY[85981134, 88226266, 130290658, 137390145, 9223372036854775807]::bigint[];
  v_nodes    constant text[] := ARRAY['http://access-001.mainnet24.nodes.onflow.org:8070',
                                      'http://access-001.mainnet25.nodes.onflow.org:8070',
                                      'http://access-001.mainnet26.nodes.onflow.org:8070',
                                      'http://access-001.mainnet27.nodes.onflow.org:8070',
                                      'https://rest-mainnet.onflow.org'];
  -- mainnet24 executes only pre-Cadence-1.0 scripts; 25..28 only Cadence 1.0 (probed 2026-09-29)
  v_src_pre  constant text := 'import Pinnacle from 0xedf9df96c92f4595
pub fun main(owner: Address, ids: [UInt64]): {UInt64: Int} {
  let out: {UInt64: Int} = {}
  let col = getAccount(owner).getCapability(Pinnacle.CollectionPublicPath).borrow<&{Pinnacle.PinNFTCollectionPublic}>()
  if col == nil { return out }
  for id in ids { if let n = col!.borrowPinNFT(id: id) { out[id] = n.editionID } }
  return out
}';
  v_src_c1   constant text := 'import NonFungibleToken from 0x1d7e57aa55817448
import Pinnacle from 0xedf9df96c92f4595
access(all) fun main(owner: Address, ids: [UInt64]): {UInt64: Int} {
  let out: {UInt64: Int} = {}
  let col = getAccount(owner).capabilities.borrow<&{NonFungibleToken.CollectionPublic}>(Pinnacle.CollectionPublicPath)
  if col == nil { return out }
  for id in ids { if let n = col!.borrowNFT(id) { if let p = n as? &Pinnacle.NFT { out[id] = p.editionID } } }
  return out
}';
  r record;
  v_body jsonb; v_req bigint; v_read text[]; v_all_read text[] := '{}'; v_n int;
  v_collected int := 0; v_reads_new int := 0; v_to_stage2 int := 0; v_missing int := 0;
  v_failed int := 0; v_throttled int := 0; v_expired int := 0; v_requeued_opens int := 0;
  v_enqueued int := 0; v_dispatched int := 0;
  v_last_error text := NULL;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('run_pinnacle_pull_chain_lane')) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'another run holds the lock');
  END IF;

  -- (1) Collect every landed read (one pg_net request per group of pins).
  FOR r IN
    SELECT q.request_id, min(q.opener_address) AS opener_address, min(q.req_block) AS req_block,
           min(q.stage) AS stage, min(q.dispatched_at) AS dispatched_at, array_agg(q.nft_id) AS ids,
           min(h.status_code) AS h_status, min(h.content) AS h_content, min(h.error_msg) AS h_error,
           bool_or(h.id IS NOT NULL) AS landed
      FROM public.pinnacle_pull_chain_pins q
      LEFT JOIN net._http_response h ON h.id = q.request_id
     WHERE q.status = 'in_flight'
     GROUP BY q.request_id
  LOOP
    IF NOT r.landed THEN
      IF r.dispatched_at < now() - interval '30 minutes' THEN
        UPDATE public.pinnacle_pull_chain_pins
           SET status = CASE WHEN attempts + 1 >= v_max_att THEN 'failed' ELSE 'pending' END,
               attempts = attempts + 1, request_id = NULL, last_error = 'no_response',
               finished_at = CASE WHEN attempts + 1 >= v_max_att THEN now() END
         WHERE request_id = r.request_id AND status = 'in_flight';
        v_expired := v_expired + 1;
      END IF;
      CONTINUE;
    END IF;
    v_collected := v_collected + 1;

    -- a 200 carries a JSON string: base64 of the JSON-Cadence result
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
        -- the node's throttle, not a wrong read: retried without counting an attempt
        UPDATE public.pinnacle_pull_chain_pins SET status = 'pending', request_id = NULL, last_error = 'http 429'
         WHERE request_id = r.request_id AND status = 'in_flight';
        v_throttled := v_throttled + 1;
      ELSE
        v_last_error := left(coalesce(r.h_error, 'http ' || coalesce(r.h_status::text, 'null') || ': ' || r.h_content), 300);
        UPDATE public.pinnacle_pull_chain_pins
           SET status = CASE WHEN attempts + 1 >= v_max_att THEN 'failed' ELSE 'pending' END,
               attempts = attempts + 1, request_id = NULL, last_error = v_last_error,
               finished_at = CASE WHEN attempts + 1 >= v_max_att THEN now() END
         WHERE request_id = r.request_id AND status = 'in_flight';
        v_failed := v_failed + 1;
      END IF;
      CONTINUE;
    END IF;

    WITH kv AS (
      SELECT e->'key'->>'value' AS nft_id, (e->'value'->>'value')::int AS edition_id
        FROM jsonb_array_elements(coalesce(v_body->'value', '[]'::jsonb)) e
    ), ins AS (
      INSERT INTO public.pinnacle_pull_chain_reads (nft_id, edition_id, owner_address, block_height)
      SELECT kv.nft_id, kv.edition_id, r.opener_address, r.req_block
        FROM kv
       WHERE kv.nft_id = ANY (r.ids) AND kv.edition_id IS NOT NULL
      ON CONFLICT (nft_id) DO NOTHING
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM ins),
           (SELECT array_agg(kv.nft_id) FROM kv WHERE kv.nft_id = ANY (r.ids) AND kv.edition_id IS NOT NULL)
      INTO v_n, v_read;
    v_reads_new := v_reads_new + v_n;
    v_read := coalesce(v_read, '{}'::text[]);

    UPDATE public.pinnacle_pull_chain_pins
       SET status = 'read', finished_at = now(), request_id = NULL, last_error = NULL
     WHERE request_id = r.request_id AND status = 'in_flight' AND nft_id = ANY (v_read);
    -- not held at the group's block: sold in between -> read it at its own open block
    WITH s2 AS (
      UPDATE public.pinnacle_pull_chain_pins
         SET stage = 2, status = 'pending', request_id = NULL, last_error = NULL
       WHERE request_id = r.request_id AND status = 'in_flight' AND stage = 1
      RETURNING 1
    )
    SELECT count(*) INTO v_n FROM s2;
    v_to_stage2 := v_to_stage2 + v_n;
    -- not held even at its own open block: nothing more this lane can read
    WITH ms AS (
      UPDATE public.pinnacle_pull_chain_pins
         SET status = 'missing', finished_at = now(), request_id = NULL
       WHERE request_id = r.request_id AND status = 'in_flight' AND stage = 2
      RETURNING 1
    )
    SELECT count(*) INTO v_n FROM ms;
    v_missing := v_missing + v_n;

    v_all_read := v_all_read || v_read;
  END LOOP;

  -- the pricer re-tries the opens holding a pin read this tick on its next run (one scan, not one per read)
  IF cardinality(v_all_read) > 0 THEN
    WITH rq AS (
      UPDATE public.pinnacle_pack_opens o SET priced_at = NULL
       WHERE o.pull_value_usd IS NULL AND o.priced_at IS NOT NULL AND o.nft_ids && v_all_read
      RETURNING 1
    )
    SELECT count(*) INTO v_requeued_opens FROM rq;
  END IF;

  -- (2) Enqueue (every 10 minutes, or when nothing is pending): every pull of an unpriced open that has an
  -- opener and an open block on a reachable spork, with no mint event, no chain read and no queue row.
  IF extract(minute FROM now())::int % 10 = 0
     OR NOT EXISTS (SELECT 1 FROM public.pinnacle_pull_chain_pins WHERE status = 'pending') THEN
    WITH c AS (
      SELECT DISTINCT ON (u.nft_id) u.nft_id, o.opener_address, o.open_block,
             (SELECT min(i) FROM generate_subscripts(v_ends, 1) i WHERE v_ends[i] >= o.open_block) AS sp
        FROM public.pinnacle_pack_opens o
        CROSS JOIN LATERAL unnest(o.nft_ids) AS u(nft_id)
       WHERE o.pull_value_usd IS NULL AND o.moments_pulled > 0
         AND o.opener_address IS NOT NULL AND o.open_block >= v_roots[1]
         AND NOT EXISTS (SELECT 1 FROM public.pinnacle_mint_events m WHERE m.nft_id = u.nft_id)
         AND NOT EXISTS (SELECT 1 FROM public.pinnacle_pull_chain_reads cr WHERE cr.nft_id = u.nft_id)
         AND NOT EXISTS (SELECT 1 FROM public.pinnacle_pull_chain_pins q WHERE q.nft_id = u.nft_id)
       ORDER BY u.nft_id, o.open_block
    ), ins AS (
      INSERT INTO public.pinnacle_pull_chain_pins (nft_id, opener_address, open_block, spork)
      SELECT c.nft_id, c.opener_address, c.open_block, c.sp FROM c WHERE c.sp IS NOT NULL
      ON CONFLICT (nft_id) DO NOTHING
      RETURNING 1
    )
    SELECT count(*) INTO v_enqueued FROM ins;
  END IF;

  -- (3) Dispatch: pending pins grouped per call — stage 1 by (opener, ~1 day of blocks), stage 2 by
  -- (opener, open block) — read at the group's LAST open block, <= v_max_ids ids a call, <= v_per_node
  -- calls per spork node, saved/seeded wallets' openers first.
  FOR r IN
    SELECT * FROM (
      SELECT g.*, row_number() OVER (PARTITION BY g.spork ORDER BY g.prio DESC, g.blk DESC) AS rn
        FROM (
          SELECT q.spork, q.stage, q.opener_address,
                 CASE WHEN q.stage = 1 THEN q.open_block / 100000 ELSE q.open_block END AS grp,
                 (q.rn - 1) / v_max_ids AS chunk,
                 max(q.open_block) AS blk, array_agg(q.nft_id ORDER BY q.nft_id) AS ids,
                 bool_or(EXISTS (SELECT 1 FROM public.seeded_wallets s
                                  WHERE s.is_active AND lower(s.wallet_address) = q.opener_address)
                      OR EXISTS (SELECT 1 FROM public.saved_wallets w
                                  WHERE lower(w.wallet_addr) = q.opener_address)) AS prio
            FROM (
              SELECT p.*, row_number() OVER (
                       PARTITION BY p.spork, p.stage, p.opener_address,
                                    CASE WHEN p.stage = 1 THEN p.open_block / 100000 ELSE p.open_block END
                       ORDER BY p.nft_id) AS rn
                FROM public.pinnacle_pull_chain_pins p
               WHERE p.status = 'pending'
            ) q
           GROUP BY 1, 2, 3, 4, 5
        ) g
    ) z WHERE z.rn <= v_per_node
  LOOP
    SELECT net.http_post(
      url := v_nodes[r.spork] || '/v1/scripts?block_height=' || r.blk,
      body := jsonb_build_object(
        'script', translate(encode(convert_to(CASE WHEN r.spork = 1 THEN v_src_pre ELSE v_src_c1 END, 'UTF8'), 'base64'), E'\n', ''),
        'arguments', jsonb_build_array(
          translate(encode(convert_to(jsonb_build_object('type', 'Address', 'value', r.opener_address)::text, 'UTF8'), 'base64'), E'\n', ''),
          translate(encode(convert_to(jsonb_build_object('type', 'Array', 'value',
            (SELECT jsonb_agg(jsonb_build_object('type', 'UInt64', 'value', i)) FROM unnest(r.ids) i))::text, 'UTF8'), 'base64'), E'\n', ''))),
      params := '{}'::jsonb,
      headers := '{"Content-Type": "application/json"}'::jsonb,
      timeout_milliseconds := 30000
    ) INTO v_req;
    UPDATE public.pinnacle_pull_chain_pins
       SET status = 'in_flight', request_id = v_req, req_block = r.blk, dispatched_at = now()
     WHERE nft_id = ANY (r.ids) AND status = 'pending';
    v_dispatched := v_dispatched + 1;
  END LOOP;

  PERFORM public.log_pipeline_run(
    'pinnacle-pull-chain', v_started, v_collected, v_reads_new, 0, (v_failed = 0), v_last_error,
    'disney_pinnacle', NULL, NULL,
    jsonb_build_object('reads_new', v_reads_new, 'to_stage2', v_to_stage2, 'missing', v_missing,
                       'failed', v_failed, 'throttled', v_throttled, 'expired', v_expired,
                       'requeued_opens', v_requeued_opens, 'enqueued', v_enqueued, 'dispatched', v_dispatched));
  RETURN jsonb_build_object('ok', v_failed = 0, 'collected', v_collected, 'reads_new', v_reads_new,
                            'to_stage2', v_to_stage2, 'missing', v_missing, 'failed', v_failed,
                            'throttled', v_throttled, 'expired', v_expired, 'requeued_opens', v_requeued_opens,
                            'enqueued', v_enqueued, 'dispatched', v_dispatched, 'last_error', v_last_error);
END;
$function$;

REVOKE ALL ON FUNCTION public.run_pinnacle_pull_chain_lane() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_pinnacle_pull_chain_lane() TO postgres, service_role;


-- ── price_pinnacle_pack_opens: a chain read names the pin after the mint event ──
CREATE OR REPLACE FUNCTION public.price_pinnacle_pack_opens(p_limit integer DEFAULT 3000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE v_cand int := 0; v_priced int := 0; v_left int := 0;
BEGIN
  DROP TABLE IF EXISTS _pppo;
  CREATE TEMP TABLE _pppo ON COMMIT DROP AS
  SELECT o.pack_nft_id, o.moments_pulled, o.nft_ids
    FROM public.pinnacle_pack_opens o
   WHERE o.pull_value_usd IS NULL AND o.moments_pulled > 0
     AND (o.priced_at IS NULL OR o.priced_at < now() - interval '6 hours')
   -- least-recently-tried first: an order on a column this job writes, so no row is starved
   ORDER BY o.priced_at NULLS FIRST, o.opened_at DESC NULLS LAST
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 3000), 1), 10000);
  GET DIAGNOSTICS v_cand = ROW_COUNT;

  WITH pulls AS (
    SELECT c.pack_nft_id, c.moments_pulled, u.nft_id
      FROM _pppo c CROSS JOIN LATERAL unnest(c.nft_ids) AS u(nft_id)
  ), named AS (
    -- the pin: its mint event; else its editionID read off the NFT on chain (run_pinnacle_pull_chain_lane);
    -- else what every other record of that nft_id names — a wallet walk, a recorded sale, a live
    -- listing — only when they all name ONE render
    SELECT p.pack_nft_id, p.moments_pulled, COALESCE(m.render_id, ch.render_id, w.render_id) AS render_id
      FROM pulls p
      LEFT JOIN public.pinnacle_mint_events m ON m.nft_id = p.nft_id
      LEFT JOIN LATERAL (
        SELECT pc.render_id
          FROM public.pinnacle_pull_chain_reads cr
          JOIN public.pinnacle_catalog pc ON pc.edition_id = cr.edition_id::text
         WHERE m.render_id IS NULL AND cr.nft_id = p.nft_id
      ) ch ON true
      LEFT JOIN LATERAL (
        SELECT min(x.render_id) AS render_id
          FROM (
            SELECT wm.render_id FROM public.wallet_moments_cache wm
             WHERE wm.collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid
               AND wm.moment_id = p.nft_id AND wm.render_id IS NOT NULL
            UNION ALL
            SELECT s.render_id FROM public.pinnacle_sales s
             WHERE s.nft_id = p.nft_id AND s.render_id IS NOT NULL
            UNION ALL
            SELECT l.render_id FROM public.pinnacle_live_listings l
             WHERE l.nft_id = p.nft_id AND l.render_id IS NOT NULL
          ) x
         WHERE m.render_id IS NULL AND ch.render_id IS NULL
        HAVING count(DISTINCT x.render_id) = 1
      ) w ON true
  ), pv AS (
    SELECT n.pack_nft_id, SUM(pc.fmv_usd)::numeric(14,2) AS v
      FROM named n
      LEFT JOIN public.pinnacle_catalog pc ON pc.render_id = n.render_id
     GROUP BY n.pack_nft_id, n.moments_pulled
    HAVING count(*) = count(pc.fmv_usd) AND count(*) = n.moments_pulled
  ), upd AS (
    UPDATE public.pinnacle_pack_opens o SET pull_value_usd = pv.v, priced_at = now()
      FROM pv WHERE o.pack_nft_id = pv.pack_nft_id AND o.pull_value_usd IS NULL AND pv.v > 0
    RETURNING 1
  )
  SELECT count(*) INTO v_priced FROM upd;

  UPDATE public.pinnacle_pack_opens o SET priced_at = now()
    FROM _pppo c WHERE o.pack_nft_id = c.pack_nft_id AND o.pull_value_usd IS NULL;

  SELECT count(*) INTO v_left FROM public.pinnacle_pack_opens WHERE pull_value_usd IS NULL;
  RETURN jsonb_build_object('candidates', v_cand, 'priced', v_priced, 'still_null', v_left);
END
$fn$;

REVOKE ALL ON FUNCTION public.price_pinnacle_pack_opens(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.price_pinnacle_pack_opens(integer) TO service_role, postgres;

SELECT cron.schedule('rpc-pinnacle-pull-chain-lane', '* * * * *', 'SELECT public.run_pinnacle_pull_chain_lane();');
