-- 2026-09-27 — recover the real SELLER of ~10,200 historical collector pack
-- resales that still name Dapper's escrow, from the chain (known-issues #123).
--
-- ── WHY ────────────────────────────────────────────────────────────────────────
-- `pack_purchases.seller_address` was the transaction PAYER until the worker's
-- Withdraw.from fix (Top Shot deployed 2026-09-27 7:30 AM PT, All Day 10:03 AM PT).
-- On Dapper the payer is the escrow 0x18eb4ee6b3c026d2. The 09-18 backfill
-- re-attributed 68,889 rows from the marketplace tables; measured today, 10,236
-- collector resales (custom_id <> 'nba') still read the escrow — 9,751 Top Shot and
-- 485 All Day, 2026-04-10 → 2026-09-27 — and the marketplace tables can name the
-- seller for only 1,041 of them. A seller's own sale is invisible in their pack
-- history for every one of the rest.
--
-- ── HOW ────────────────────────────────────────────────────────────────────────
-- The sale tx itself names the seller: `A.<contract>.PackNFT.Withdraw{id, from}`
-- for the sold pack (verified 2026-09-27 on three txs against the marketplace
-- index and the fixed worker). The DB reads each tx from Flow REST through pg_net
-- (the circulation sampler's pattern), 20 requests a minute — a 50-request burst
-- drew 10 × 429 on 09-26 — so the ~10.4k requests take ~9 h.
--   audit_20260927_pack_seller_onchain   one row per purchase; status + seller
--   pack_seller_onchain_tick(p_n)         collect finished responses, dispatch p_n
--   apply_pack_seller_onchain()           writes the chain seller into pack_purchases
-- The TICK only records. APPLY is run by hand once the 200 CONTROL rows (resales
-- whose seller is already non-escrow) agree with the chain; it touches only rows
-- still reading the escrow, and stamps applied_at.
--
-- ── REVERT ─────────────────────────────────────────────────────────────────────
--   SELECT cron.unschedule('rpc-pack-seller-onchain');
--   UPDATE public.pack_purchases p SET seller_address = a.old_seller
--     FROM public.audit_20260927_pack_seller_onchain a
--    WHERE a.purchase_id = p.id AND a.applied_at IS NOT NULL;
--   DROP FUNCTION public.apply_pack_seller_onchain();
--   DROP FUNCTION public.pack_seller_onchain_tick(int);
--   (keep the audit table until the revert is confirmed, then DROP it.)

-- anon-exec: revoked (pack_seller_onchain_tick) — REVOKE FROM PUBLIC, anon, authenticated below; only postgres (pg_cron) calls it.
-- anon-exec: revoked (apply_pack_seller_onchain) — REVOKE FROM PUBLIC, anon, authenticated below; run by hand as postgres.

CREATE TABLE public.audit_20260927_pack_seller_onchain (
  purchase_id    uuid PRIMARY KEY,
  collection_id  uuid NOT NULL,
  pack_nft_id    text NOT NULL,
  tx_hash        text NOT NULL,
  old_seller     text,
  is_control     boolean NOT NULL DEFAULT false,
  request_id     bigint,
  dispatched_at  timestamptz,
  attempts       int NOT NULL DEFAULT 0,
  status         text,
  onchain_seller text,
  checked_at     timestamptz,
  applied_at     timestamptz
);
ALTER TABLE public.audit_20260927_pack_seller_onchain ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260927_pack_seller_onchain FROM PUBLIC, anon, authenticated;
CREATE INDEX audit_20260927_pack_seller_onchain_todo
  ON public.audit_20260927_pack_seller_onchain (checked_at NULLS FIRST)
  WHERE request_id IS NULL;

-- The population: every collector resale still naming the escrow …
INSERT INTO public.audit_20260927_pack_seller_onchain
  (purchase_id, collection_id, pack_nft_id, tx_hash, old_seller, is_control)
SELECT p.id, p.collection_id, p.pack_nft_id, p.tx_hash, p.seller_address, false
  FROM public.pack_purchases p
 WHERE p.event_kind = 'secondary_sale'
   AND p.custom_id IS DISTINCT FROM 'nba'
   AND p.seller_address = '0x18eb4ee6b3c026d2'
   AND p.tx_hash IS NOT NULL;

-- … plus 200 CONTROLS whose seller is already a wallet (worker-written after the
-- fix, or attributed by the 09-18 marketplace backfill). They are never applied;
-- they measure whether the chain read agrees with a seller we already trust.
INSERT INTO public.audit_20260927_pack_seller_onchain
  (purchase_id, collection_id, pack_nft_id, tx_hash, old_seller, is_control)
SELECT p.id, p.collection_id, p.pack_nft_id, p.tx_hash, p.seller_address, true
  FROM public.pack_purchases p
 WHERE p.event_kind = 'secondary_sale'
   AND p.custom_id IS DISTINCT FROM 'nba'
   AND p.seller_address IS NOT NULL
   AND p.seller_address <> '0x18eb4ee6b3c026d2'
   AND p.tx_hash IS NOT NULL
 ORDER BY random()
 LIMIT 200;

CREATE OR REPLACE FUNCTION public.pack_seller_onchain_tick(p_n int DEFAULT 20)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_collected int := 0;
  v_sent      int := 0;
BEGIN
  -- 1. Collect every finished (or abandoned) request.
  WITH done AS (
    SELECT a.purchase_id, a.collection_id, a.pack_nft_id, r.status_code, r.content
      FROM public.audit_20260927_pack_seller_onchain a
      LEFT JOIN net._http_response r ON r.id = a.request_id
     WHERE a.request_id IS NOT NULL
       AND (r.id IS NOT NULL OR a.dispatched_at < now() - interval '1 hour')
  ), parsed AS (
    SELECT d.purchase_id, d.status_code,
           CASE WHEN d.status_code = 200 AND d.content IS JSON OBJECT THEN (
             SELECT lower(coalesce(f->'value'->'value'->>'value', f->'value'->>'value'))
               FROM jsonb_array_elements(d.content::jsonb->'events') ev
               CROSS JOIN LATERAL (
                 SELECT convert_from(decode(ev->>'payload', 'base64'), 'UTF8') AS txt) pl
               CROSS JOIN LATERAL jsonb_array_elements(
                 CASE WHEN pl.txt IS JSON OBJECT THEN pl.txt::jsonb->'value'->'fields' ELSE '[]'::jsonb END) f
              WHERE ev->>'type' = CASE d.collection_id
                      WHEN '95f28a17-224a-4025-96ad-adf8a4c63bfd' THEN 'A.0b2a3299cc857e29.PackNFT.Withdraw'
                      WHEN 'dee28451-5d62-409e-a1ad-a83f763ac070' THEN 'A.e4cf4bdc1751c65d.PackNFT.Withdraw'
                    END
                AND f->>'name' = 'from'
                AND EXISTS (
                  SELECT 1 FROM jsonb_array_elements(
                    CASE WHEN pl.txt IS JSON OBJECT THEN pl.txt::jsonb->'value'->'fields' ELSE '[]'::jsonb END) g
                   WHERE g->>'name' = 'id' AND g->'value'->>'value' = d.pack_nft_id)
              LIMIT 1)
           END AS seller,
           (d.status_code = 200 AND d.content IS JSON OBJECT) AS readable
      FROM done d
  ), upd AS (
    UPDATE public.audit_20260927_pack_seller_onchain a SET
      request_id     = NULL,
      checked_at     = clock_timestamp(),
      onchain_seller = CASE WHEN x.seller ~ '^0x[0-9a-f]{16}$'
                             AND x.seller NOT IN ('0x0b2a3299cc857e29', '0xe4cf4bdc1751c65d')
                            THEN x.seller END,
      status = CASE
                 WHEN x.status_code IS NULL                THEN 'no_response'
                 WHEN x.status_code <> 200                 THEN 'http_' || x.status_code
                 WHEN NOT x.readable                       THEN 'undecodable'
                 WHEN x.seller IS NULL                     THEN 'no_withdraw'
                 WHEN x.seller IN ('0x0b2a3299cc857e29', '0xe4cf4bdc1751c65d') THEN 'contract_from'
                 WHEN x.seller !~ '^0x[0-9a-f]{16}$'       THEN 'bad_address'
                 ELSE 'ok' END
      FROM parsed x
     WHERE a.purchase_id = x.purchase_id
    RETURNING 1
  )
  SELECT count(*) INTO v_collected FROM upd;

  -- 2. Dispatch the next p_n: never-read rows first, then transient failures
  --    (429 / 5xx / no response), at most 5 attempts per row.
  WITH nxt AS (
    SELECT a.purchase_id, a.tx_hash
      FROM public.audit_20260927_pack_seller_onchain a
     WHERE a.request_id IS NULL
       AND a.attempts < 5
       AND (a.status IS NULL OR a.status IN ('no_response', 'http_429')
            OR a.status LIKE 'http_5%')
     ORDER BY a.is_control DESC, a.checked_at NULLS FIRST, a.purchase_id
     LIMIT greatest(1, least(p_n, 60))
  ), sent AS (
    UPDATE public.audit_20260927_pack_seller_onchain a SET
      request_id = net.http_get(
        url := 'https://rest-mainnet.onflow.org/v1/transaction_results/' || n.tx_hash,
        timeout_milliseconds := 15000),
      dispatched_at = clock_timestamp(),
      attempts = a.attempts + 1
      FROM nxt n
     WHERE a.purchase_id = n.purchase_id
    RETURNING 1
  )
  SELECT count(*) INTO v_sent FROM sent;

  RETURN jsonb_build_object('ok', true, 'collected', v_collected, 'dispatched', v_sent);
END;
$function$;

CREATE OR REPLACE FUNCTION public.apply_pack_seller_onchain()
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_applied int := 0;
BEGIN
  WITH upd AS (
    UPDATE public.pack_purchases p SET seller_address = a.onchain_seller
      FROM public.audit_20260927_pack_seller_onchain a
     WHERE a.purchase_id = p.id
       AND NOT a.is_control
       AND a.status = 'ok'
       AND a.onchain_seller IS NOT NULL
       AND a.applied_at IS NULL
       AND p.seller_address = '0x18eb4ee6b3c026d2'
    RETURNING p.id
  ), stamp AS (
    UPDATE public.audit_20260927_pack_seller_onchain a SET applied_at = clock_timestamp()
      FROM upd WHERE a.purchase_id = upd.id
    RETURNING 1
  )
  SELECT count(*) INTO v_applied FROM stamp;
  RETURN jsonb_build_object('ok', true, 'applied', v_applied);
END;
$function$;

REVOKE ALL ON FUNCTION public.pack_seller_onchain_tick(int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_pack_seller_onchain() FROM PUBLIC, anon, authenticated;

SELECT cron.schedule('rpc-pack-seller-onchain', '* * * * *',
                     $$SELECT public.pack_seller_onchain_tick(20);$$);
