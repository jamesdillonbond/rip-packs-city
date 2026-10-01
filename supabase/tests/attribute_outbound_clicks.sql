-- DB invariant: public.attribute_outbound_clicks — matches an RPC → marketplace click to the sale that
-- followed it (a "presumed purchase"). Pins (audit_20260930):
--   * same_moment: the EXACT moment's first sale within 48 h after the click, scoped by COLLECTION
--     (a moment id is unique only within a collection — #142);
--   * same_edition: edition-level clicks only, the edition's sale within 2 h at <= ask x 1.02;
--   * confidence: confirmed only when the buyer is the clicker's wallet (click wallet or the user's
--     saved wallets; hex case-insensitive); likely = same moment, <= 2 h, <= ask x 1.05; else possible;
--   * a sale BEFORE the click, or after the window, never attributes; a bot click is skipped;
--   * the collection falls back to the destination host when the writer did not say;
--   * pinnacle_sales and panini_sales are read for their collections;
--   * a second run writes nothing (one row per click).
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20261001033000_audit_20260930_rpc_clicks_are_attributed_to_the_marketplace_sales_that_follow_them.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.

BEGIN;

CREATE TABLE public.collections (id uuid PRIMARY KEY, slug text);
INSERT INTO public.collections VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'nba_top_shot'), ('dee28451-5d62-409e-a1ad-a83f763ac070', 'nfl_all_day'),
  ('7dd9dd11-e8b6-45c4-ac99-71331f959714', 'disney_pinnacle'), ('d1a0a7f5-609a-49f4-a1a7-4eaac55b020b', 'panini_blockchain');
CREATE TABLE public.outbound_clicks (
  id bigserial PRIMARY KEY, created_at timestamptz, surface text, destination text, edition_key text, moment_id text,
  ask_price_usd numeric, wallet_address text, buy_url text, collection_slug text, source text DEFAULT 'site',
  user_id uuid, bot_ua boolean);
CREATE TABLE public.editions (id uuid PRIMARY KEY, collection_id uuid, external_id text);
CREATE TABLE public.sales (id uuid, collection_id uuid, edition_id uuid, nft_id varchar, sold_at timestamptz, price_usd numeric, buyer_address varchar);
CREATE TABLE public.pinnacle_sales (id text, nft_id text, render_id text, sold_at timestamptz, sale_price_usd numeric, buyer_address text);
CREATE TABLE public.panini_sales (sku text, edition_external_id text, sold_at timestamptz, amount_usd numeric, buyer text);
CREATE TABLE public.saved_wallets (user_id uuid, wallet_addr text);
CREATE TABLE public.click_attributed_purchases (
  click_id bigint PRIMARY KEY, clicked_at timestamptz NOT NULL, collection_slug text NOT NULL, sale_source text NOT NULL,
  sale_ref text NOT NULL, nft_id text, sold_at timestamptz NOT NULL, price_usd numeric, buyer_address text, match text NOT NULL,
  confidence text NOT NULL, buyer_is_clicker boolean NOT NULL, minutes_after_click integer NOT NULL,
  attributed_at timestamptz NOT NULL DEFAULT now());
CREATE FUNCTION public.log_pipeline_run(text, timestamptz, integer, integer, integer, boolean, text, text, text, text, jsonb)
RETURNS void LANGUAGE sql AS $$ SELECT NULL::void $$;

-- >>> BEGIN verbatim attribute_outbound_clicks (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.attribute_outbound_clicks(p_lookback_hours integer DEFAULT 72)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_scanned int := 0;
  v_written int := 0;
  v_err text;
BEGIN
  BEGIN
    DROP TABLE IF EXISTS _ac_clicks;
    CREATE TEMP TABLE _ac_clicks ON COMMIT DROP AS
    SELECT c.id, c.created_at, c.moment_id, c.edition_key, c.ask_price_usd, c.wallet_address, c.user_id,
           -- the click's collection: what the writer said, else read off the destination's host
           COALESCE(
             CASE replace(lower(c.collection_slug), '-', '_')
               WHEN 'pinnacle' THEN 'disney_pinnacle' WHEN 'topshot' THEN 'nba_top_shot'
               WHEN 'allday' THEN 'nfl_all_day' WHEN 'golazos' THEN 'laliga_golazos'
               WHEN 'panini' THEN 'panini_blockchain' WHEN 'ufc' THEN 'ufc_strike'
               ELSE replace(lower(c.collection_slug), '-', '_') END,
             CASE
               WHEN coalesce(c.buy_url, c.destination) ~* 'nbatopshot\.com|dapper\.market/nba' THEN 'nba_top_shot'
               WHEN coalesce(c.buy_url, c.destination) ~* 'nflallday\.com|dapper\.market/nfl' THEN 'nfl_all_day'
               WHEN coalesce(c.buy_url, c.destination) ~* 'laligagolazos\.com' THEN 'laliga_golazos'
               WHEN coalesce(c.buy_url, c.destination) ~* 'disneypinnacle\.com' THEN 'disney_pinnacle'
               WHEN coalesce(c.buy_url, c.destination) ~* 'ufcstrike\.com' THEN 'ufc_strike'
             END) AS coll
      FROM public.outbound_clicks c
     WHERE c.created_at > now() - make_interval(hours => GREATEST(p_lookback_hours, 1))
       AND NOT COALESCE(c.bot_ua, false)
       AND (c.moment_id IS NOT NULL OR c.edition_key IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM public.click_attributed_purchases a WHERE a.click_id = c.id);
    GET DIAGNOSTICS v_scanned = ROW_COUNT;

    WITH k AS (
      SELECT ck.*, col.id AS coll_id
        FROM _ac_clicks ck
        JOIN public.collections col ON col.slug = ck.coll
    ), m AS (
      -- first sale of the EXACT moment within 48 h, from whichever table carries that collection
      SELECT k.id AS click_id, k.created_at, k.coll, k.ask_price_usd, k.wallet_address, k.user_id,
             'same_moment'::text AS match, s.*
        FROM k
        CROSS JOIN LATERAL (
          SELECT * FROM (
            SELECT 'sales'::text AS sale_source, sa.id::text AS sale_ref, sa.nft_id::text AS nft_id, sa.sold_at,
                   sa.price_usd, sa.buyer_address::text AS buyer_address
              FROM public.sales sa
             WHERE k.coll NOT IN ('disney_pinnacle', 'panini_blockchain')
               AND sa.collection_id = k.coll_id AND sa.nft_id = k.moment_id
               AND sa.sold_at > k.created_at AND sa.sold_at <= k.created_at + interval '48 hours'
            UNION ALL
            SELECT 'pinnacle_sales', ps.id, ps.nft_id, ps.sold_at, ps.sale_price_usd, ps.buyer_address
              FROM public.pinnacle_sales ps
             WHERE k.coll = 'disney_pinnacle' AND ps.nft_id = k.moment_id
               AND ps.sold_at > k.created_at AND ps.sold_at <= k.created_at + interval '48 hours'
            UNION ALL
            SELECT 'panini_sales', pn.sku || '@' || pn.sold_at::text, pn.sku, pn.sold_at, pn.amount_usd, pn.buyer
              FROM public.panini_sales pn
             WHERE k.coll = 'panini_blockchain' AND pn.sku = k.moment_id
               AND pn.sold_at > k.created_at AND pn.sold_at <= k.created_at + interval '48 hours'
          ) u ORDER BY u.sold_at LIMIT 1
        ) s
       WHERE k.moment_id IS NOT NULL
    ), e AS (
      -- edition-level clicks (no moment id): the clicked edition sold within 2 h at <= ask x 1.02
      SELECT k.id AS click_id, k.created_at, k.coll, k.ask_price_usd, k.wallet_address, k.user_id,
             'same_edition'::text AS match, s.*
        FROM k
        CROSS JOIN LATERAL (
          SELECT * FROM (
            SELECT 'sales'::text AS sale_source, sa.id::text AS sale_ref, sa.nft_id::text AS nft_id, sa.sold_at,
                   sa.price_usd, sa.buyer_address::text AS buyer_address
              FROM public.editions ed
              JOIN public.sales sa ON sa.edition_id = ed.id
             WHERE k.coll NOT IN ('disney_pinnacle', 'panini_blockchain')
               AND ed.collection_id = k.coll_id AND ed.external_id = k.edition_key
               AND sa.sold_at > k.created_at AND sa.sold_at <= k.created_at + interval '2 hours'
               AND (k.ask_price_usd IS NULL OR sa.price_usd <= k.ask_price_usd * 1.02)
            UNION ALL
            SELECT 'pinnacle_sales', ps.id, ps.nft_id, ps.sold_at, ps.sale_price_usd, ps.buyer_address
              FROM public.pinnacle_sales ps
             WHERE k.coll = 'disney_pinnacle' AND ps.render_id = k.edition_key
               AND ps.sold_at > k.created_at AND ps.sold_at <= k.created_at + interval '2 hours'
               AND (k.ask_price_usd IS NULL OR ps.sale_price_usd <= k.ask_price_usd * 1.02)
            UNION ALL
            SELECT 'panini_sales', pn.sku || '@' || pn.sold_at::text, pn.sku, pn.sold_at, pn.amount_usd, pn.buyer
              FROM public.panini_sales pn
             WHERE k.coll = 'panini_blockchain' AND pn.edition_external_id = k.edition_key
               AND pn.sold_at > k.created_at AND pn.sold_at <= k.created_at + interval '2 hours'
               AND (k.ask_price_usd IS NULL OR pn.amount_usd <= k.ask_price_usd * 1.02)
          ) u ORDER BY u.sold_at LIMIT 1
        ) s
       WHERE k.moment_id IS NULL AND k.edition_key IS NOT NULL
    ), hits AS (
      SELECT h.*,
             -- the clicker's wallets: the one on the click, plus every wallet the user saved.
             -- Hex (Flow/EVM) compares case-insensitively; anything else (Solana base58) exactly.
             EXISTS (
               SELECT 1 FROM (
                 SELECT h.wallet_address AS w
                 UNION ALL
                 SELECT sw.wallet_addr FROM public.saved_wallets sw WHERE h.user_id IS NOT NULL AND sw.user_id = h.user_id
               ) ws
               WHERE ws.w IS NOT NULL AND h.buyer_address IS NOT NULL
                 AND CASE WHEN h.buyer_address ~* '^0x' THEN lower(ws.w) = lower(h.buyer_address)
                          ELSE ws.w = h.buyer_address END
             ) AS buyer_is_clicker
        FROM (SELECT * FROM m UNION ALL SELECT * FROM e) h
    ), ins AS (
      INSERT INTO public.click_attributed_purchases
        (click_id, clicked_at, collection_slug, sale_source, sale_ref, nft_id, sold_at, price_usd, buyer_address,
         match, confidence, buyer_is_clicker, minutes_after_click)
      SELECT h.click_id, h.created_at, h.coll, h.sale_source, h.sale_ref, h.nft_id, h.sold_at, h.price_usd, h.buyer_address,
             h.match,
             CASE WHEN h.buyer_is_clicker THEN 'confirmed'
                  WHEN h.match = 'same_moment' AND h.sold_at <= h.created_at + interval '2 hours'
                       AND (h.ask_price_usd IS NULL OR h.price_usd IS NULL OR h.price_usd <= h.ask_price_usd * 1.05) THEN 'likely'
                  ELSE 'possible' END,
             h.buyer_is_clicker,
             floor(extract(epoch FROM h.sold_at - h.created_at) / 60)::int
        FROM hits h
      ON CONFLICT (click_id) DO NOTHING
      RETURNING 1
    )
    SELECT count(*) INTO v_written FROM ins;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_err := left(SQLERRM, 300);
  END;
  -- ok is derived from whether the work ran; rows_written counts rows actually inserted.
  PERFORM public.log_pipeline_run('attribute-outbound-clicks', v_started, v_scanned, v_written, 0, v_err IS NULL, v_err,
    NULL, NULL, NULL,
    jsonb_build_object('clicks_scanned', v_scanned, 'attributed', v_written, 'lookback_hours', p_lookback_hours,
                       'via', 'pg_cron', 'duration_ms', (extract(epoch FROM clock_timestamp() - v_started) * 1000)::int));
  RETURN jsonb_build_object('clicks_scanned', v_scanned, 'attributed', v_written, 'error', v_err);
END
$function$;
-- <<< END verbatim attribute_outbound_clicks <<<

-- ── fixtures ─────────────────────────────────────────────────────────────────────────────────────
-- TS = Top Shot, AD = All Day. Click times are relative to now() so the 72 h lookback holds.
INSERT INTO public.editions VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '51:1878'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'dee28451-5d62-409e-a1ad-a83f763ac070', '51:1878');
INSERT INTO public.saved_wallets VALUES ('bbbbbbbb-0000-0000-0000-000000000001', '0xABCDEF0123456789');

INSERT INTO public.outbound_clicks (id, created_at, surface, moment_id, edition_key, ask_price_usd, wallet_address, buy_url, collection_slug, source, user_id, bot_ua) VALUES
  -- 1: TS moment N1, bought 30 min later at the ask by a stranger                      -> likely
  (1, now() - interval '5 hours', 'sniper', 'N1', '51:1878', 0.32, NULL, NULL, 'nba_top_shot', 'site', NULL, false),
  -- 2: TS moment N2, bought 10 min later by the signed-in user's SAVED wallet (case!)  -> confirmed
  (2, now() - interval '5 hours', 'alert', 'N2', NULL, 1.00, NULL, NULL, 'nba-top-shot', 'alert', 'bbbbbbbb-0000-0000-0000-000000000001', false),
  -- 3: TS moment N3, sold 30 h later                                                   -> possible
  (3, now() - interval '40 hours', 'moment', 'N3', NULL, 5.00, NULL, NULL, 'nba_top_shot', 'site', NULL, false),
  -- 4: TS moment N4, sold BEFORE the click, and again 50 h after                       -> nothing
  (4, now() - interval '60 hours', 'moment', 'N4', NULL, 5.00, NULL, NULL, 'nba_top_shot', 'site', NULL, false),
  -- 5: a BOT fetching the same link as click 1                                         -> skipped
  (5, now() - interval '5 hours', 'alert', 'N1', NULL, 0.32, NULL, NULL, 'nba_top_shot', 'alert', NULL, true),
  -- 6: NO collection on the row; the host says All Day. All Day nft 'N1' is a different
  --    moment from Top Shot 'N1' and sold 20 min later                                -> AD sale, not TS
  (6, now() - interval '5 hours', 'market', 'N1', NULL, 2.00, NULL, 'https://nflallday.com/moments/N1', NULL, 'site', NULL, false),
  -- 7: edition-level TS click at $0.40; the edition's FIRST at-or-under-ask sale after it (N1 $0.32, 30 min) -> same_edition possible
  (7, now() - interval '5 hours', 'edition', NULL, '51:1878', 0.40, NULL, NULL, 'nba_top_shot', 'site', NULL, false),
  -- 8: edition-level click, but the only sale is above ask x 1.02                      -> nothing
  (8, now() - interval '20 hours', 'edition', NULL, '51:1878', 0.10, NULL, NULL, 'nba_top_shot', 'site', NULL, false),
  -- 9: Pinnacle moment, pinnacle_sales                                                 -> likely
  (9, now() - interval '5 hours', 'moment', 'P9', NULL, 20.00, NULL, NULL, 'disney_pinnacle', 'site', NULL, false),
  -- 10: Panini card by sku, bought by the click's own wallet                           -> confirmed
  (10, now() - interval '5 hours', 'panini', 'SKU10', NULL, 3.00, '0xpanini', NULL, 'panini_blockchain', 'site', NULL, false),
  -- 11: TS moment bought within 2 h but at 2x the ask clicked                          -> possible (not likely)
  (11, now() - interval '5 hours', 'sniper', 'N11', NULL, 1.00, NULL, NULL, 'nba_top_shot', 'site', NULL, false);

INSERT INTO public.sales (id, collection_id, edition_id, nft_id, sold_at, price_usd, buyer_address) VALUES
  ('cccccccc-0000-0000-0000-000000000001', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'aaaaaaaa-0000-0000-0000-000000000001', 'N1', now() - interval '4 hours 30 minutes', 0.32, '0xstranger'),
  ('cccccccc-0000-0000-0000-000000000002', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'aaaaaaaa-0000-0000-0000-000000000001', 'N2', now() - interval '4 hours 50 minutes', 1.00, '0xabcdef0123456789'),
  ('cccccccc-0000-0000-0000-000000000003', '95f28a17-224a-4025-96ad-adf8a4c63bfd', NULL, 'N3', now() - interval '10 hours', 5.00, '0xother'),
  ('cccccccc-0000-0000-0000-000000000004', '95f28a17-224a-4025-96ad-adf8a4c63bfd', NULL, 'N4', now() - interval '61 hours', 5.00, '0xother'),
  ('cccccccc-0000-0000-0000-000000000005', '95f28a17-224a-4025-96ad-adf8a4c63bfd', NULL, 'N4', now() - interval '9 hours', 5.00, '0xother'),
  ('cccccccc-0000-0000-0000-000000000006', 'dee28451-5d62-409e-a1ad-a83f763ac070', NULL, 'N1', now() - interval '4 hours 40 minutes', 2.00, '0xad'),
  ('cccccccc-0000-0000-0000-000000000007', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'aaaaaaaa-0000-0000-0000-000000000001', 'N70', now() - interval '4 hours 10 minutes', 0.39, '0xed'),
  ('cccccccc-0000-0000-0000-000000000008', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'aaaaaaaa-0000-0000-0000-000000000001', 'N80', now() - interval '19 hours', 0.50, '0xed'),
  ('cccccccc-0000-0000-0000-000000000011', '95f28a17-224a-4025-96ad-adf8a4c63bfd', NULL, 'N11', now() - interval '4 hours', 2.00, '0xother');
INSERT INTO public.pinnacle_sales VALUES ('pin-9', 'P9', 'R9', now() - interval '4 hours', 20.00, '0xpinbuyer');
INSERT INTO public.panini_sales VALUES ('SKU10', 'E10', now() - interval '4 hours 55 minutes', 3.00, '0xPANINI');

-- ── assertions ───────────────────────────────────────────────────────────────────────────────────
SELECT _assert_eq((SELECT (j->>'clicks_scanned') || '/' || (j->>'attributed') FROM (SELECT public.attribute_outbound_clicks(72) j) s), '10/8',
  '10 non-bot clicks scanned (click 4 too: the lookback is 72 h), 8 attributed');
SELECT _assert_eq((SELECT string_agg(click_id || ':' || match || ':' || confidence || ':' || sale_ref, ' ' ORDER BY click_id) FROM public.click_attributed_purchases),
  '1:same_moment:likely:cccccccc-0000-0000-0000-000000000001 '
  || '2:same_moment:confirmed:cccccccc-0000-0000-0000-000000000002 '
  || '3:same_moment:possible:cccccccc-0000-0000-0000-000000000003 '
  || '6:same_moment:likely:cccccccc-0000-0000-0000-000000000006 '
  || '7:same_edition:possible:cccccccc-0000-0000-0000-000000000001 '
  || '9:same_moment:likely:pin-9 '
  || '10:same_moment:confirmed:SKU10@' || (SELECT sold_at::text FROM public.panini_sales) || ' '
  || '11:same_moment:possible:cccccccc-0000-0000-0000-000000000011',
  'each click lands on exactly the sale and confidence the rules say');
SELECT _assert((SELECT NOT EXISTS (SELECT 1 FROM public.click_attributed_purchases WHERE click_id IN (4, 5, 8))),
  'a sale BEFORE the click or past 48 h, a bot click, and an above-ask edition sale never attribute');
SELECT _assert_eq((SELECT collection_slug FROM public.click_attributed_purchases WHERE click_id = 6), 'nfl_all_day',
  'with no collection on the row, the destination host decides -- and the All Day N1, not the Top Shot N1');
SELECT _assert_eq((SELECT collection_slug FROM public.click_attributed_purchases WHERE click_id = 2), 'nba_top_shot',
  'the hyphen registry spelling resolves to the long-form slug');
SELECT _assert_eq((SELECT minutes_after_click::text FROM public.click_attributed_purchases WHERE click_id = 1), '30',
  'minutes_after_click is measured click -> sale');
SELECT _assert_eq((SELECT (j->>'attributed') FROM (SELECT public.attribute_outbound_clicks(72) j) s), '0',
  'a second run writes nothing -- one row per click');

ROLLBACK;
