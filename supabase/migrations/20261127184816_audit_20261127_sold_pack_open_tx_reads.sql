-- audit_20261127_sold_pack_open_tx_reads
--
-- 2026-11-27 (PT, late morning; Claude Code cloud; Trevor: "Keep going and get us to 100%").
--
-- WHY: get_wallet_sold_pack_outcomes (20261127161747) shows what the buyer of a sold pack pulled. On
-- 11-27, 70 of the 8,449 opened Top Shot packs that saved wallets had sold had NO pull on record at all:
--   * 58 were BOXES/CASES -- a container opens into PACKS, not moments, and pack_box_contents only
--     knows the containers a SAVED wallet opened (the wallet walk); 6 of the 58 were covered.
--   * 12 were ordinary packs (Top Shot This, Trade Ticket, Rookie Debut Premium, team packs ...)
--     whose moments never reached moment_acquisitions.
-- Both answers are in the OPEN TRANSACTION itself (measured on all 64 open txs via
-- GET /v1/transaction_results/{tx}, 64/64 HTTP 200): a container's open tx deposits its packs to the
-- opener (A.0b2a3299cc857e29.PackNFT.Deposit, 420 events over 52 containers, every one `to` = opener,
-- none the container itself), and those 12 packs' open txs deposit their moments
-- (A.0b2a3299cc857e29.TopShot.Deposit, 30 events, every one to the opener).
--
-- WHAT: a small lane, two steps, pg_cron every 10 minutes (same tick, collect first):
--   dispatch_sold_pack_open_tx_reads(p_max) -- Top Shot pack_rips that a saved wallet SOLD (or that
--     sit inside a container one sold, any depth this lane has already uncovered) with no pull on
--     record anywhere (no linked moment_acquisitions, no pack_open_pulls, no pack_box_contents) and
--     not yet read: one pg_net GET of the open tx each.
--   collect_sold_pack_open_tx_reads() -- parses each answered read: PackNFT.Deposit to the opener ->
--     pack_box_contents (the inner packs; a case's boxes are then picked up by the next dispatch);
--     TopShot.Deposit to the opener -> pack_open_pulls (resolved_via 'chain_open_tx', edition from
--     a moments row when one exists). Unnamed pulls are then named by the existing chain lane
--     (run_topshot_pull_chain_lane enqueues every pack_open_pulls pack with an unnamed pull and
--     reads it at the rip's block height); pack_open_pull_values follows from that lane.
--   Each read ends in an outcome: 'contents' (n packs), 'pulls' (n moments), 'nothing_to_opener'
--   (an open tx that deposited nothing to the opener -- said, not guessed), 'http_<code>' or
--   'no_response' (net._http_response row gone after 6 h retention -- re-read next pass).
--
-- SCOPE: Top Shot only (the class was measured there; All Day sold packs had 110/110 pulls named).
-- Containers whose open wrote no pack_rips row (Top Shot stopped writing container rips after
-- ~2026-07-11, docs/reference/packs.md) have no tx to read; the reader says "opened, contents not on
-- record" for those from pack_nft_identity (20261127185407).
--
-- WRITES are additive (ON CONFLICT DO NOTHING) into two tables whose other writer is the wallet walk;
-- the rows are true chain facts, so a saved wallet's history reading them later is correct.
-- (Re-applied the same day, same name: the dispatch loop record was renamed off the `r` alias it
-- clashed with, and pack_rips is probed per id through LATERAL -- the first plan hashed every Top Shot
-- rip and hit the 60 s budget. The bodies here are what production runs.)
--
-- REVERT:
--   SELECT cron.unschedule('rpc-sold-pack-open-tx-reads');
--   DELETE FROM public.pack_open_pulls o USING public.sold_pack_open_tx_reads r
--    WHERE o.pack_nft_id = r.pack_nft_id AND o.resolved_via = 'chain_open_tx';
--   DELETE FROM public.pack_box_contents b USING public.sold_pack_open_tx_reads r
--    WHERE b.box_pack_nft_id = r.pack_nft_id AND r.outcome = 'contents' AND b.first_seen_at >= r.collected_at - interval '1 minute';
--   DROP FUNCTION public.collect_sold_pack_open_tx_reads(); DROP FUNCTION public.dispatch_sold_pack_open_tx_reads(integer);
--   DROP FUNCTION public.run_sold_pack_open_tx_reads(); DROP TABLE public.sold_pack_open_tx_reads;

CREATE TABLE IF NOT EXISTS public.sold_pack_open_tx_reads (
  pack_nft_id   text PRIMARY KEY,
  collection_id uuid NOT NULL,
  tx_hash       text NOT NULL,
  opener_address text NOT NULL,
  request_id    bigint,
  dispatched_at timestamptz NOT NULL DEFAULT now(),
  collected_at  timestamptz,
  outcome       text,
  n_written     integer
);
ALTER TABLE public.sold_pack_open_tx_reads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sold_pack_open_tx_reads FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.sold_pack_open_tx_reads IS
  'One Flow transaction_results read per opened Top Shot pack/box/case that a saved wallet sold and that had no pull on record (audit_20261127_sold_pack_open_tx_reads). outcome NULL = in flight.';

CREATE OR REPLACE FUNCTION public.dispatch_sold_pack_open_tx_reads(p_max integer DEFAULT 30)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  x record;
  v_n integer := 0;
BEGIN
  FOR x IN
    WITH RECURSIVE sold AS (
      SELECT DISTINCT pp.pack_nft_id
        FROM public.pack_purchases pp
       WHERE pp.collection_id = v_ts
         AND pp.pack_nft_id IS NOT NULL
         AND pp.custom_id IS DISTINCT FROM 'nba'
         AND pp.seller_address IN (SELECT DISTINCT wallet_addr FROM public.saved_wallets)
    ), scope(pack_nft_id, depth) AS (
      SELECT pack_nft_id, 0 FROM sold
      UNION
      SELECT b.pack_nft_id, s.depth + 1
        FROM scope s
        JOIN public.pack_box_contents b ON b.collection_id = v_ts AND b.box_pack_nft_id = s.pack_nft_id
       WHERE s.depth < 2
    )
    SELECT DISTINCT r.pack_nft_id, r.tx_hash, r.opener_address
      FROM (SELECT DISTINCT pack_nft_id FROM scope) s
      -- LATERAL keeps this a per-id probe of pack_rips' unique pack_nft_id index; a plain join
      -- planned a hash over every Top Shot rip and ran past the 60 s budget (measured 11-27)
      CROSS JOIN LATERAL (SELECT r0.* FROM public.pack_rips r0
                           WHERE r0.pack_nft_id = s.pack_nft_id AND r0.collection_id = v_ts
                           LIMIT 1) r
     WHERE r.tx_hash ~ '^[0-9a-f]{64}$'
       AND r.opener_address ~ '^0x[0-9a-f]{16}$'
       AND NOT EXISTS (SELECT 1 FROM public.moment_acquisitions ma
                        WHERE ma.source_pack_rip_id = r.id AND ma.collection_id = v_ts)
       AND NOT EXISTS (SELECT 1 FROM public.pack_open_pulls o
                        WHERE o.collection_id = v_ts AND o.pack_nft_id = r.pack_nft_id)
       AND NOT EXISTS (SELECT 1 FROM public.pack_box_contents b
                        WHERE b.collection_id = v_ts AND b.box_pack_nft_id = r.pack_nft_id)
       AND NOT EXISTS (SELECT 1 FROM public.sold_pack_open_tx_reads q
                        WHERE q.pack_nft_id = r.pack_nft_id
                          AND (q.outcome IS NULL OR q.outcome NOT IN ('no_response') ))
     LIMIT GREATEST(p_max, 0)
  LOOP
    INSERT INTO public.sold_pack_open_tx_reads (pack_nft_id, collection_id, tx_hash, opener_address, request_id, dispatched_at)
    VALUES (x.pack_nft_id, v_ts, x.tx_hash, x.opener_address,
            net.http_get('https://rest-mainnet.onflow.org/v1/transaction_results/' || x.tx_hash,
                         timeout_milliseconds := 20000),
            now())
    ON CONFLICT (pack_nft_id) DO UPDATE
      SET request_id = EXCLUDED.request_id, dispatched_at = now(), collected_at = NULL, outcome = NULL, n_written = NULL;
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END
$fn$;

CREATE OR REPLACE FUNCTION public.collect_sold_pack_open_tx_reads()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  q record;
  v_body jsonb;
  v_status integer;
  v_packs integer;
  v_pulls integer;
  v_done integer := 0;
  v_written integer := 0;
BEGIN
  FOR q IN
    SELECT s.*, h.status_code, h.content, (h.id IS NULL) AS gone
      FROM public.sold_pack_open_tx_reads s
      LEFT JOIN net._http_response h ON h.id = s.request_id
     WHERE s.outcome IS NULL
       AND (h.id IS NOT NULL OR s.dispatched_at < now() - interval '30 minutes')
  LOOP
    IF q.gone THEN
      UPDATE public.sold_pack_open_tx_reads SET outcome = 'no_response', collected_at = now()
       WHERE pack_nft_id = q.pack_nft_id;
      CONTINUE;
    END IF;
    IF q.status_code IS DISTINCT FROM 200 THEN
      UPDATE public.sold_pack_open_tx_reads SET outcome = 'http_' || coalesce(q.status_code::text, 'none'), collected_at = now()
       WHERE pack_nft_id = q.pack_nft_id;
      CONTINUE;
    END IF;
    BEGIN
      v_body := q.content::jsonb;
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.sold_pack_open_tx_reads SET outcome = 'bad_json', collected_at = now()
       WHERE pack_nft_id = q.pack_nft_id;
      CONTINUE;
    END;

    -- decoded deposits to the opener, by kind
    WITH ev AS (
      SELECT e->>'type' AS t,
             convert_from(decode(e->>'payload', 'base64'), 'UTF8')::jsonb->'value'->'fields' AS f
        FROM jsonb_array_elements(coalesce(v_body->'events', '[]'::jsonb)) e
       WHERE e->>'type' IN ('A.0b2a3299cc857e29.PackNFT.Deposit', 'A.0b2a3299cc857e29.TopShot.Deposit')
    ), dep AS (
      SELECT t, f->0->'value'->>'value' AS id, f->1->'value'->'value'->>'value' AS to_addr FROM ev
    ), kids AS (
      INSERT INTO public.pack_box_contents (collection_id, box_pack_nft_id, pack_nft_id, opener_address)
      SELECT v_ts, q.pack_nft_id, d.id, q.opener_address
        FROM dep d
       WHERE d.t = 'A.0b2a3299cc857e29.PackNFT.Deposit' AND d.to_addr = q.opener_address
         AND d.id ~ '^[0-9]+$' AND d.id <> q.pack_nft_id
      ON CONFLICT DO NOTHING
      RETURNING 1
    ), pulls AS (
      INSERT INTO public.pack_open_pulls (collection_id, pack_nft_id, nft_id, opener_address, edition_id, resolved_via, resolved_at)
      SELECT v_ts, q.pack_nft_id, d.id, q.opener_address, m.edition_id,
             'chain_open_tx', CASE WHEN m.edition_id IS NOT NULL THEN now() END
        FROM dep d
        LEFT JOIN public.moments m ON m.collection_id = v_ts AND m.nft_id = d.id
       WHERE d.t = 'A.0b2a3299cc857e29.TopShot.Deposit' AND d.to_addr = q.opener_address
         AND d.id ~ '^[0-9]+$'
      ON CONFLICT DO NOTHING
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM kids), (SELECT count(*) FROM pulls) INTO v_packs, v_pulls;

    UPDATE public.sold_pack_open_tx_reads
       SET collected_at = now(),
           outcome = CASE WHEN v_packs > 0 THEN 'contents' WHEN v_pulls > 0 THEN 'pulls' ELSE 'nothing_to_opener' END,
           n_written = v_packs + v_pulls
     WHERE pack_nft_id = q.pack_nft_id;
    v_done := v_done + 1;
    v_written := v_written + v_packs + v_pulls;
  END LOOP;
  RETURN jsonb_build_object('collected', v_done, 'rows_written', v_written);
END
$fn$;

CREATE OR REPLACE FUNCTION public.run_sold_pack_open_tx_reads()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '60s'
AS $fn$
DECLARE
  v_collect jsonb; v_dispatched integer; v_err text;
BEGIN
  BEGIN
    v_collect := public.collect_sold_pack_open_tx_reads();
    v_dispatched := public.dispatch_sold_pack_open_tx_reads(30);
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_err := left(SQLERRM, 300);
  END;
  PERFORM public.log_pipeline_run('sold-pack-open-tx-reads', v_err IS NULL,
    jsonb_build_object('collect', v_collect, 'dispatched', v_dispatched, 'error', v_err, 'via', 'pg_cron'));
  RETURN jsonb_build_object('collect', v_collect, 'dispatched', v_dispatched, 'error', v_err);
END
$fn$;

REVOKE ALL ON FUNCTION public.dispatch_sold_pack_open_tx_reads(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.collect_sold_pack_open_tx_reads() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.run_sold_pack_open_tx_reads() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_sold_pack_open_tx_reads(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.collect_sold_pack_open_tx_reads() TO service_role;
GRANT EXECUTE ON FUNCTION public.run_sold_pack_open_tx_reads() TO service_role;

SELECT cron.schedule('rpc-sold-pack-open-tx-reads', '6-56/10 * * * *', 'SELECT public.run_sold_pack_open_tx_reads()');

INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, notes, is_active, max_minutes_without_success)
VALUES ('sold-pack-open-tx-reads', 40, 'info',
 'Added 2026-11-27: run_sold_pack_open_tx_reads() (pg_cron 6-56/10) reads the open tx of Top Shot packs/boxes/cases a saved wallet SOLD that have no pull on record, so the binder Sold tab can say what the buyer pulled. If silent, those rows show "x of y priced"; nothing else depends on it.',
 true, 120)
ON CONFLICT (pipeline) DO NOTHING;
