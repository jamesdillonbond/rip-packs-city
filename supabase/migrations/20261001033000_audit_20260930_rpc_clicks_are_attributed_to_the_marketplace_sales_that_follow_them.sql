-- audit_20260930 — every RPC → marketplace click is recorded with enough to match it, and an hourly
-- job matches each click to the marketplace sale that followed it ("presumed purchase").
--
-- Trevor 2026-09-30: "make sure we're tracking clicks and presumed purchases, confirmed by marketplace
-- activity, so we can track purchases made through RPC clicks."
--
-- MEASURED before this migration (~8:30 PM PT): outbound_clicks held 73 rows EVER (sniper 34,
-- pack_dist 15, moment 10, pack-sniper 7, market 3, wallet-page 3, edition 1). Alert "Buy on Top Shot"
-- links went straight to the marketplace and were never recorded at all. No click carried its
-- COLLECTION — and a moment_id is unique only within a collection (#142) — nor the signed-in user, so no
-- click could be tied to a sale or to a buyer.
--
-- WHAT THIS ADDS
--   1. outbound_clicks: collection_slug, source ('site' | 'alert'), link_kind, alert_delivery_id,
--      channel, user_id, user_agent, bot_ua. Written by /api/track-click (site) and /go/a/<delivery>
--      (alerts, a server-side redirect whose destination is derived from the delivery row — never
--      from the URL, so it is not an open redirect).
--   2. click_attributed_purchases: one row per click that a sale followed.
--        match        same_moment  — the exact moment (nft id) sold within 48 h after the click
--                     same_edition — the clicked edition sold within 2 h at <= ask x 1.02 (edition-level
--                                    clicks only; no moment id to match)
--        confidence   confirmed — the BUYER is the clicker's own wallet (the click's wallet, or any
--                                 wallet the signed-in user / alert owner saved)
--                     likely    — same moment, sold within 2 h, at <= ask x 1.05 (or no ask known)
--                     possible  — everything else that matched
--      Sale sources: `sales` (Top Shot, All Day, Golazos, UFC, Candy), `pinnacle_sales`, `panini_sales`.
--   3. attribute_outbound_clicks(): hourly (pg_cron :23), clicks from the last 72 h with no row yet,
--      bot_ua clicks skipped. A click with no sale inside its window is simply never attributed.
--   4. click_purchase_funnel_daily: per PT day x source x surface x collection — clicks (all / human /
--      internal), attributed purchases by confidence, distinct sales and their USD. service_role only.
--
-- ⚠ "PRESUMED" IS THE WORD, ON PURPOSE. A same-moment sale after a click is evidence, not proof, unless
-- the buyer is the clicker's wallet; the confidence column says which. GMV counts each sale ONCE however
-- many clicks preceded it.
-- ⚠ KNOWN COVERAGE GAP: Golazos rows in `sales` stop at 2026-09-12 (not this migration's lane), so a
-- Golazos click cannot be attributed until that ingest resumes.
--
-- anon-exec: attribute_outbound_clicks (REVOKED from PUBLIC/anon/authenticated below; postgres via pg_cron, service_role)
--
-- REVERT:
--   SELECT cron.unschedule('rpc-attribute-outbound-clicks');
--   DROP VIEW public.click_purchase_funnel_daily; DROP FUNCTION public.attribute_outbound_clicks(integer);
--   DROP TABLE public.click_attributed_purchases;
--   ALTER TABLE public.outbound_clicks DROP COLUMN collection_slug, DROP COLUMN source, DROP COLUMN link_kind,
--     DROP COLUMN alert_delivery_id, DROP COLUMN channel, DROP COLUMN user_id, DROP COLUMN user_agent, DROP COLUMN bot_ua;
--   (revert the paired code commit first, or /api/track-click and /go/a write columns that no longer exist)

-- ── 1. the click row carries what attribution needs ─────────────────────────────────────────────
ALTER TABLE public.outbound_clicks
  ADD COLUMN IF NOT EXISTS collection_slug   text,
  ADD COLUMN IF NOT EXISTS source            text NOT NULL DEFAULT 'site',
  ADD COLUMN IF NOT EXISTS link_kind         text,
  ADD COLUMN IF NOT EXISTS alert_delivery_id uuid REFERENCES public.alert_deliveries(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS channel           text,
  ADD COLUMN IF NOT EXISTS user_id           uuid,
  ADD COLUMN IF NOT EXISTS user_agent        text,
  ADD COLUMN IF NOT EXISTS bot_ua            boolean;
ALTER TABLE public.outbound_clicks DROP CONSTRAINT IF EXISTS outbound_clicks_source_check;
ALTER TABLE public.outbound_clicks ADD CONSTRAINT outbound_clicks_source_check CHECK (source IN ('site', 'alert'));
CREATE INDEX IF NOT EXISTS idx_outbound_clicks_created_at ON public.outbound_clicks (created_at DESC);
COMMENT ON COLUMN public.outbound_clicks.collection_slug IS 'Long-form collections.slug (nba_top_shot, …). A moment_id is unique only within a collection. audit_20260930.';
COMMENT ON COLUMN public.outbound_clicks.source IS '''site'' = /api/track-click beacon; ''alert'' = /go/a/<alert_delivery_id> redirect. audit_20260930.';
COMMENT ON COLUMN public.outbound_clicks.bot_ua IS 'What the USER-AGENT claims (lib/bot-ua.ts) — link-preview fetchers (TelegramBot, Discordbot, mail scanners) land here. NULL on rows before 2026-09-30.';

-- ── 2. the attribution table ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.click_attributed_purchases (
  click_id            bigint PRIMARY KEY REFERENCES public.outbound_clicks(id) ON DELETE CASCADE,
  clicked_at          timestamptz NOT NULL,
  collection_slug     text NOT NULL,
  sale_source         text NOT NULL CHECK (sale_source IN ('sales', 'pinnacle_sales', 'panini_sales')),
  sale_ref            text NOT NULL,
  nft_id              text,
  sold_at             timestamptz NOT NULL,
  price_usd           numeric,
  buyer_address       text,
  match               text NOT NULL CHECK (match IN ('same_moment', 'same_edition')),
  confidence          text NOT NULL CHECK (confidence IN ('confirmed', 'likely', 'possible')),
  buyer_is_clicker    boolean NOT NULL,
  minutes_after_click integer NOT NULL,
  attributed_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cap_sale ON public.click_attributed_purchases (sale_source, sale_ref);
ALTER TABLE public.click_attributed_purchases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.click_attributed_purchases FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.click_attributed_purchases TO service_role;
COMMENT ON TABLE public.click_attributed_purchases IS 'Presumed purchases: a marketplace sale that followed an RPC outbound click. confidence = confirmed only when the buyer is the clicker''s own wallet. Written by attribute_outbound_clicks(). audit_20260930.';

-- ── 3. the matcher ──────────────────────────────────────────────────────────────────────────────
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

REVOKE ALL ON FUNCTION public.attribute_outbound_clicks(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attribute_outbound_clicks(integer) TO service_role;

-- ── 4. the read ─────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.click_purchase_funnel_daily WITH (security_invoker = on) AS
WITH c AS (
  SELECT oc.id, (oc.created_at AT TIME ZONE 'America/Los_Angeles')::date AS day_pt, oc.source,
         COALESCE(oc.surface, '(none)') AS surface, COALESCE(a.collection_slug, oc.collection_slug, '(unknown)') AS collection_slug,
         COALESCE(oc.bot_ua, false) AS bot_ua,
         (oc.user_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.internal_accounts ia WHERE ia.user_id = oc.user_id)) AS internal,
         a.confidence, a.sale_source, a.sale_ref, a.price_usd
    FROM public.outbound_clicks oc
    LEFT JOIN public.click_attributed_purchases a ON a.click_id = oc.id
)
SELECT day_pt, source, surface, collection_slug,
       count(*)                                                         AS clicks,
       count(*) FILTER (WHERE NOT bot_ua)                               AS clicks_human,
       count(*) FILTER (WHERE internal)                                 AS clicks_internal,
       count(*) FILTER (WHERE confidence = 'confirmed')                 AS purchases_confirmed,
       count(*) FILTER (WHERE confidence = 'likely')                    AS purchases_likely,
       count(*) FILTER (WHERE confidence = 'possible')                  AS purchases_possible,
       count(DISTINCT sale_source || ':' || sale_ref) FILTER (WHERE confidence IN ('confirmed', 'likely')) AS sales_confirmed_or_likely,
       (SELECT COALESCE(sum(d.price_usd), 0) FROM (
          SELECT DISTINCT ON (c2.sale_source, c2.sale_ref) c2.price_usd FROM c c2
           WHERE c2.day_pt = c.day_pt AND c2.source = c.source AND c2.surface = c.surface
             AND c2.collection_slug = c.collection_slug AND c2.confidence IN ('confirmed', 'likely')) d
       )                                                                AS usd_confirmed_or_likely
  FROM c
 GROUP BY day_pt, source, surface, collection_slug;
REVOKE ALL ON public.click_purchase_funnel_daily FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.click_purchase_funnel_daily TO service_role;

-- ── 5. schedule ─────────────────────────────────────────────────────────────────────────────────
SELECT cron.schedule('rpc-attribute-outbound-clicks', '23 * * * *', 'SELECT public.attribute_outbound_clicks(72);');
