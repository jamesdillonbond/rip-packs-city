-- audit_20261108_candy_special_serials_board_precomputed
--
-- 2026-11-08 ~7:45 PM PT (Claude Code cloud; Trevor: "Keep going and work through these").
--
-- WHY. v_rpc_trust_health.public_board_slow_count breached on candy_special_serials_board:
-- 20,929 ms at the 4:28 PM PT probe vs its 4,100 ms max_ms. Re-measured 7:40 PM PT, outside the
-- census window: EXPLAIN (ANALYZE, BUFFERS) count(*) = 27.0 s, 231,285 hit + 27,686 read, 26.0 s
-- of it shared-read IO. Cause: POPULATION, not plan — the view probes wallet_moments_cache three
-- times per Candy edition, and today's every-collection catalogue took Candy editions from 347
-- to 19,618 (board rows 717 -> 26,127; 25,410 from `c:` editions). lib/insights/candy-board.ts
-- reads it ordered by fmv_usd LIMIT 800, so every read computes and sorts all 26k rows; the
-- concierge reads it per player / holder.
--
-- WHAT CHANGES. The house pattern (mv_candy_holder_board / mv_candy_scarcity_board): the body is
-- moved VERBATIM into mv_candy_special_serials_board, refreshed CONCURRENTLY hourly at :12 (after
-- the :57 collections census ends ~:09, clear of the :18 Panini squeeze). candy_special_serials_board
-- keeps its name, columns and order as a security_invoker wrapper, so no caller changes. Content is
-- NOT narrowed (the `c:` rows stay — that population is the Candy session's product decision).
-- Freshness: up to ~1 h behind wallet_moments_cache, the same contract as the holder board.
-- UNIQUE (external_id, serial_number, owner) holds by construction: editions is unique on
-- (external_id, collection_id), candy_fmv_current is DISTINCT ON (edition_id), the lateral is a
-- UNION of (serial, wallet), and ls is LIMIT 1 (26,127 rows = 26,127 distinct, measured).
-- Grants: the MV gets service_role SELECT only, like the view (no anon / authenticated read).
-- Base asserted: live pg_get_viewdef md5 89afd56696ef72537f20895bb13b675d = 20261108200226's body.
--
-- Revert: SELECT cron.unschedule('rpc-refresh-candy-special-serials-board');
--   re-apply candy_special_serials_board from 20261108200226 (WITH security_invoker = on);
--   DROP MATERIALIZED VIEW public.mv_candy_special_serials_board;

DO $premise$
BEGIN
  IF md5(pg_get_viewdef('public.candy_special_serials_board'::regclass)) <> '89afd56696ef72537f20895bb13b675d' THEN
    RAISE EXCEPTION 'premise: candy_special_serials_board changed since read; re-read before replacing';
  END IF;
END
$premise$;

CREATE MATERIALIZED VIEW public.mv_candy_special_serials_board AS
 WITH house AS (
         SELECT DISTINCT candy_house_wallets.wallet_address
           FROM candy_house_wallets
        )
 SELECT e.external_id,
    e.player_name,
    e.name AS edition_name,
    (e.tier)::text AS tier,
    candy_is_rainbow(e.badges) AS is_rainbow,
    e.circulation_count,
    w.serial_number,
        CASE
            WHEN (w.serial_number = 1) THEN 'first_mint'::text
            WHEN (w.serial_number = e.circulation_count) THEN 'last_mint'::text
            WHEN (w.serial_number <= 3) THEN 'low_serial'::text
            ELSE 'jersey_match'::text
        END AS kind,
    w.wallet_address AS owner,
    (w.wallet_address IN ( SELECT house.wallet_address
           FROM house)) AS is_treasury,
    fc.fmv_usd,
    (fc.confidence)::text AS confidence,
    ls.last_sale_usd,
    ls.last_sale_at,
    e.set_id
   FROM (((editions e
     CROSS JOIN LATERAL ( SELECT m.serial_number,
            m.wallet_address
           FROM wallet_moments_cache m
          WHERE ((m.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid) AND (m.edition_key = (e.external_id)::text) AND (m.serial_number <= 3))
        UNION
         SELECT m.serial_number,
            m.wallet_address
           FROM wallet_moments_cache m
          WHERE ((m.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid) AND (m.edition_key = (e.external_id)::text) AND (m.serial_number = e.circulation_count))
        UNION
         SELECT m.serial_number,
            m.wallet_address
           FROM wallet_moments_cache m
          WHERE ((m.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid) AND (m.edition_key = (e.external_id)::text) AND (e.jersey_number IS NOT NULL) AND (e.jersey_number > 0) AND (m.serial_number = e.jersey_number))) w)
     LEFT JOIN candy_fmv_current fc ON ((fc.edition_id = e.id)))
     LEFT JOIN LATERAL ( SELECT s.price_usd AS last_sale_usd,
            s.sold_at AS last_sale_at
           FROM sales s
          WHERE ((s.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid) AND (s.edition_id = e.id) AND (s.serial_number = w.serial_number) AND (s.sold_at >= '2026-01-01 00:00:00+00'::timestamp with time zone))
          ORDER BY s.sold_at DESC
         LIMIT 1) ls ON (true))
  WHERE (e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid);

CREATE UNIQUE INDEX mv_candy_special_serials_board_uidx
  ON public.mv_candy_special_serials_board (external_id, serial_number, owner);

REVOKE ALL ON public.mv_candy_special_serials_board FROM PUBLIC;
REVOKE ALL ON public.mv_candy_special_serials_board FROM anon;
REVOKE ALL ON public.mv_candy_special_serials_board FROM authenticated;
GRANT SELECT ON public.mv_candy_special_serials_board TO service_role;

CREATE OR REPLACE VIEW public.candy_special_serials_board WITH (security_invoker = on) AS
 SELECT external_id,
    player_name,
    edition_name,
    tier,
    is_rainbow,
    circulation_count,
    serial_number,
    kind,
    owner,
    is_treasury,
    fmv_usd,
    confidence,
    last_sale_usd,
    last_sale_at,
    set_id
   FROM public.mv_candy_special_serials_board;

ALTER VIEW public.candy_special_serials_board SET (security_invoker = on);

SELECT cron.schedule(
  'rpc-refresh-candy-special-serials-board',
  '12 * * * *',
  $job$SET statement_timeout = '300s'; REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_candy_special_serials_board;$job$
);
