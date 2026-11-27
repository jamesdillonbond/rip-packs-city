-- audit_20261127_sold_container_open_search
--
-- 2026-11-27 (PT, late morning; Claude Code cloud; Trevor: "Keep going and get us to 100%").
-- Builds on 20261127184816_audit_20261127_sold_pack_open_tx_reads.sql (same morning).
--
-- WHY: after the open-tx lane, 53 Top Shot boxes/cases that saved wallets SOLD still read
-- "opened, contents not on record": Dapper's index (pack_nft_identity) says Opened/Revealed, but Top
-- Shot stopped writing a pack_rips row for a container open after ~2026-07-11
-- (docs/reference/packs.md), so there is no tx hash to read. The open is still on chain: the box's
-- open tx emits A.0b2a3299cc857e29.PackNFT.Opened {id: <box>} next to its PackNFT.Deposit events.
--
-- HOW (measured 11-27 on the 53): the opener (index owner) opens the box's inner packs soon after
-- the box, so the box open sits BEFORE the opener's first rip of an inner dist
-- (pack_container_recipes) after the sale. Gap sale -> first inner rip: median 129 blocks, p90
-- 12,154. So each search walks the Flow REST events endpoint
--   GET /v1/events?type=A.0b2a3299cc857e29.PackNFT.Opened&start_height=&end_height=  (<= 250 blocks)
-- BACKWARD from that first inner rip toward the sale block, one window per tick per container, at
-- most 40 windows (10,000 blocks) per container; a container with no inner rip on record walks
-- FORWARD from its sale block instead. When the window holds an Opened event for the box id, the
-- open tx is read through the existing open-tx lane (a sold_pack_open_tx_reads row, collected by
-- collect_sold_pack_open_tx_reads -> pack_box_contents), so the reader picks the packs up.
-- Outcomes: 'found', 'exhausted' (40 windows, nothing -- said, not guessed), 'below_sale' (walked
-- back to the sale block), 'http_<code>'. A backward walk that ends without the open turns FORWARD from
-- its anchor once (the anchor rip was another box's pack; measured 1 of 53 on 11-27).
-- Boxes whose index status is unknown ('unknown' / 'not_found' / no row -- 17 on 11-27) are searched
-- too, with the last buyer as the presumed opener; finding the Opened event settles them.
-- (Re-applied the same day, same name, for the forward fallback and the unknown-status boxes; the
-- body here is what production runs.)
--
-- REVERT: SELECT cron.unschedule('rpc-sold-container-open-search');
--   DROP FUNCTION public.run_sold_container_open_search(); DROP TABLE public.sold_container_open_search;
--   (rows it led to in sold_pack_open_tx_reads / pack_box_contents: see the open-tx lane's REVERT)

CREATE TABLE IF NOT EXISTS public.sold_container_open_search (
  pack_nft_id    text PRIMARY KEY,
  collection_id  uuid NOT NULL,
  opener_address text NOT NULL,
  sale_block     bigint NOT NULL,
  anchor_block   bigint,              -- first inner rip after the sale (NULL = none on record)
  direction      text NOT NULL,       -- 'back' from the anchor, 'forward' from the sale
  next_start     bigint NOT NULL,     -- the window to ask next
  windows        integer NOT NULL DEFAULT 0,
  request_id     bigint,
  req_start      bigint,
  outcome        text,                -- NULL = searching
  open_tx        text,
  open_block     bigint,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.sold_container_open_search ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sold_container_open_search FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.sold_container_open_search IS
  'Per sold Top Shot box/case with an index-confirmed open but no pack_rips row: a block-window search for its PackNFT.Opened event (audit_20261127_sold_container_open_search).';

CREATE OR REPLACE FUNCTION public.run_sold_container_open_search(p_max integer DEFAULT 20)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '60s'
AS $fn$
DECLARE
  v_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_win constant integer := 250;
  v_cap constant integer := 40;
  x record;
  v_hit record;
  v_new integer := 0; v_found integer := 0; v_sent integer := 0; v_err text;
BEGIN
  BEGIN
    -- (1) enrol new containers
    WITH ins AS (
      INSERT INTO public.sold_container_open_search
        (pack_nft_id, collection_id, opener_address, sale_block, anchor_block, direction, next_start)
      SELECT c.pack_nft_id, v_ts, c.opener, c.sale_bh, c.anchor,
             CASE WHEN c.anchor IS NULL THEN 'forward' ELSE 'back' END,
             CASE WHEN c.anchor IS NULL THEN c.sale_bh ELSE GREATEST(c.anchor - v_win + 1, c.sale_bh) END
        FROM (
          SELECT s.pack_nft_id, s.sale_bh, COALESCE(i.owner_address, s.buyer_address) AS opener,
                 (SELECT min(r.block_height)
                    FROM public.pack_rips r
                    JOIN public.pack_container_recipes pc
                      ON pc.collection_id = r.collection_id AND pc.inner_dist_id = r.dist_id
                     AND pc.container_dist_id = s.pack_dist_id
                   WHERE r.collection_id = v_ts AND r.opener_address = COALESCE(i.owner_address, s.buyer_address)
                     AND r.block_height > s.sale_bh) AS anchor
            FROM (SELECT DISTINCT ON (pp.pack_nft_id) pp.pack_nft_id, pp.pack_dist_id, pp.block_height AS sale_bh,
                         pp.buyer_address
                    FROM public.pack_purchases pp
                   WHERE pp.collection_id = v_ts AND pp.pack_nft_id IS NOT NULL
                     AND pp.custom_id IS DISTINCT FROM 'nba'
                     AND pp.seller_address IN (SELECT DISTINCT wallet_addr FROM public.saved_wallets)
                   ORDER BY pp.pack_nft_id, pp.sealed_at DESC) s
            LEFT JOIN public.pack_nft_identity i ON i.collection_id = v_ts AND i.pack_nft_id = s.pack_nft_id
            JOIN public.pack_distributions_v d ON d.collection_id = v_ts AND d.dist_id = s.pack_dist_id
           -- index-confirmed opens, and boxes whose index status is unknown (not 'Sealed'): for those the
           -- last buyer stands in for the opener, and a search that finds nothing ends 'exhausted'
           WHERE i.status IS DISTINCT FROM 'Sealed'
             AND COALESCE(i.owner_address, s.buyer_address) ~ '^0x[0-9a-f]{16}$'
             AND d.metadata->>'pack_type' IN ('box', 'case')
             AND s.sale_bh IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM public.pack_rips r WHERE r.pack_nft_id = s.pack_nft_id)
             AND NOT EXISTS (SELECT 1 FROM public.pack_box_contents b
                              WHERE b.collection_id = v_ts AND b.box_pack_nft_id = s.pack_nft_id)
        ) c
      ON CONFLICT (pack_nft_id) DO NOTHING
      RETURNING 1)
    SELECT count(*) INTO v_new FROM ins;

    -- (2) read answered windows
    FOR x IN
      SELECT q.*, h.status_code, h.content, (h.id IS NULL) AS gone
        FROM public.sold_container_open_search q
        LEFT JOIN net._http_response h ON h.id = q.request_id
       WHERE q.outcome IS NULL AND q.request_id IS NOT NULL
         AND (h.id IS NOT NULL OR q.updated_at < now() - interval '30 minutes')
    LOOP
      IF x.gone THEN
        UPDATE public.sold_container_open_search SET request_id = NULL, updated_at = now() WHERE pack_nft_id = x.pack_nft_id;
        CONTINUE;  -- re-ask the same window
      END IF;
      IF x.status_code IS DISTINCT FROM 200 THEN
        UPDATE public.sold_container_open_search SET outcome = 'http_' || coalesce(x.status_code::text, 'none'), updated_at = now()
         WHERE pack_nft_id = x.pack_nft_id;
        CONTINUE;
      END IF;
      SELECT blk->>'block_height' AS bh, ev->>'transaction_id' AS tx INTO v_hit
        FROM jsonb_array_elements(x.content::jsonb) blk
        CROSS JOIN LATERAL jsonb_array_elements(coalesce(blk->'events', '[]'::jsonb)) ev
       WHERE convert_from(decode(ev->>'payload', 'base64'), 'UTF8')::jsonb->'value'->'fields'->0->'value'->>'value' = x.pack_nft_id
       LIMIT 1;
      IF v_hit.tx IS NOT NULL THEN
        UPDATE public.sold_container_open_search
           SET outcome = 'found', open_tx = v_hit.tx, open_block = v_hit.bh::bigint, request_id = NULL, updated_at = now()
         WHERE pack_nft_id = x.pack_nft_id;
        INSERT INTO public.sold_pack_open_tx_reads (pack_nft_id, collection_id, tx_hash, opener_address, request_id, dispatched_at)
        VALUES (x.pack_nft_id, v_ts, v_hit.tx, x.opener_address,
                net.http_get('https://rest-mainnet.onflow.org/v1/transaction_results/' || v_hit.tx, timeout_milliseconds := 20000),
                now())
        ON CONFLICT (pack_nft_id) DO NOTHING;
        v_found := v_found + 1;
      ELSE
        UPDATE public.sold_container_open_search
           SET request_id = NULL, windows = windows + 1, updated_at = now(),
               next_start = CASE WHEN direction = 'back' THEN next_start - v_win ELSE next_start + v_win END,
               outcome = CASE
                 WHEN windows + 1 >= v_cap THEN 'exhausted'
                 WHEN direction = 'back' AND next_start <= sale_block THEN 'below_sale'
                 END
         WHERE pack_nft_id = x.pack_nft_id;
      END IF;
    END LOOP;

    -- (2b) a backward walk that reached the sale block (or its cap) without the open: the anchor rip
    -- belonged to another box of the same drop, so this box opened AFTER it -- walk forward from the
    -- anchor instead, once (direction 'forward' never turns back)
    UPDATE public.sold_container_open_search
       SET direction = 'forward', next_start = anchor_block + 1, windows = 0, outcome = NULL,
           request_id = NULL, updated_at = now()
     WHERE direction = 'back' AND outcome IN ('below_sale', 'exhausted') AND anchor_block IS NOT NULL;

    -- (3) ask the next window of each open search
    FOR x IN
      SELECT * FROM public.sold_container_open_search
       WHERE outcome IS NULL AND request_id IS NULL
       ORDER BY windows, pack_nft_id
       LIMIT GREATEST(p_max, 0)
    LOOP
      UPDATE public.sold_container_open_search
         SET req_start = GREATEST(x.next_start, x.sale_block),
             request_id = net.http_get(
               'https://rest-mainnet.onflow.org/v1/events?type=A.0b2a3299cc857e29.PackNFT.Opened'
               || '&start_height=' || GREATEST(x.next_start, x.sale_block)
               || '&end_height=' || (GREATEST(x.next_start, x.sale_block) + v_win - 1),
               timeout_milliseconds := 20000),
             updated_at = now()
       WHERE pack_nft_id = x.pack_nft_id;
      v_sent := v_sent + 1;
    END LOOP;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_err := left(SQLERRM, 300);
  END;
  PERFORM public.log_pipeline_run('sold-container-open-search', v_err IS NULL,
    jsonb_build_object('enrolled', v_new, 'found', v_found, 'windows_sent', v_sent, 'error', v_err, 'via', 'pg_cron'));
  RETURN jsonb_build_object('enrolled', v_new, 'found', v_found, 'windows_sent', v_sent, 'error', v_err);
END
$fn$;

REVOKE ALL ON FUNCTION public.run_sold_container_open_search(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_sold_container_open_search(integer) TO service_role;

SELECT cron.schedule('rpc-sold-container-open-search', '3-59/5 * * * *', 'SELECT public.run_sold_container_open_search(20)');

INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, notes, is_active, max_minutes_without_success)
VALUES ('sold-container-open-search', 20, 'info',
 'Added 2026-11-27: run_sold_container_open_search() (pg_cron 3-59/5) finds the open tx of Top Shot boxes/cases a saved wallet SOLD whose open wrote no pack_rips row, by walking PackNFT.Opened event windows; found opens are read by sold-pack-open-tx-reads. If silent, those boxes show "opened, contents not on record".',
 true, 60)
ON CONFLICT (pipeline) DO NOTHING;
