-- audit_20261025: Panini joins the public Below FMV board (/insights/deals, cross_collection_deals_board)
-- (Cowork cloud, 2026-10-25 ~10:30 PM PT; Top Shot parity pass, Trevor: "Keep going and do it all").
--
-- The board UNIONs Top Shot, All Day, Pinnacle and Candy MLB legs from mv_cross_collection_deals; Panini had none
-- (its deals lived only on the Panini Sniper tab). A new leg in that MV needs a recreate (gated), so Panini gets its
-- own hourly MV and the plain view gains a second UNION arm (CREATE OR REPLACE VIEW keeps the columns, the grants
-- and — restated here — security_invoker=on).
--
-- The leg (mv_panini_public_deals): per edition, the cheapest REGULAR serial (no #1 / jersey / perfect copy) whose
-- confirmed ask is >= 15 % under FMV AND under the median of recent sales (panini_deal_board_all deal_basis
-- 'fmv_and_recent_sales'), on an edition whose FMV is HIGH/MEDIUM (the other legs' gate), ask >= $1. FMV from
-- edition_fmv_current — equal to the deal board's edition FMV on all 10 rows at apply. No owner column.
-- Measured at apply: 10 editions (Mahomes, Mbappe, Haaland ×2, Yamal, Caitlin Clark…), refresh ~1.3 s.
-- low_confidence_fmv is false, as on the All Day / Pinnacle legs (the client no longer renders it).
--
-- ⚠ Order: the view below reads an UNPOPULATED MV until refresh_panini_public_deals() (or a plain REFRESH) runs;
-- prod was populated by a plain REFRESH seconds after this applied. On a fresh database, refresh before reading.
--
-- Revert: SELECT cron.unschedule('panini-public-deals'); re-apply cross_collection_deals_board without the Panini
--         arm (the first SELECT below, security_invoker=on); git revert the code commit; then drop the MV and function.

-- anon-exec: revoked (refresh_panini_public_deals) — new SECURITY DEFINER writer; REVOKE FROM PUBLIC, anon, authenticated below.

CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_panini_public_deals AS
SELECT DISTINCT ON (d.edition_external_id)
       d.edition_external_id::varchar                              AS external_id,
       (coalesce(d.player_name, '') || CASE WHEN d.parallel IS NOT NULL THEN ' — ' || d.parallel ELSE '' END)::varchar AS name,
       d.player_name,
       d.parallel                                                  AS set_name,
       d.tier::text                                                AS tier,
       d.mint_cap                                                  AS circulation_count,
       f.fmv_usd,
       f.confidence::text                                          AS confidence,
       d.ask_usd                                                   AS low_ask,
       round((f.fmv_usd - d.ask_usd) / f.fmv_usd * 100, 1)          AS discount_pct,
       round(f.fmv_usd - d.ask_usd, 2)                             AS discount_usd,
       d.ask_confirmed_at                                          AS ask_updated_at,
       d.product_name,
       d.recent_sales_median_usd,
       d.recent_sales_n,
       d.serial_number                                             AS low_ask_serial,
       e.thumbnail_url,
       now()                                                       AS computed_at
  FROM public.panini_deal_board_all d
  JOIN public.editions e ON e.external_id = d.edition_external_id AND e.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid
  JOIN public.edition_fmv_current f ON f.edition_id = e.id
 WHERE d.deal_basis = 'fmv_and_recent_sales'      -- the ask is also under the median of recent sales
   AND d.special_flag IS NULL                     -- a #1 / jersey / perfect copy is not the edition's floor
   AND f.confidence::text IN ('HIGH', 'MEDIUM')   -- the same FMV gate as the Top Shot / All Day / Candy legs
   AND d.ask_usd >= 1
   AND d.ask_usd < f.fmv_usd
 ORDER BY d.edition_external_id, d.ask_usd, d.sku
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS mv_panini_public_deals_pk ON public.mv_panini_public_deals (external_id);
REVOKE ALL ON public.mv_panini_public_deals FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.mv_panini_public_deals TO service_role;

COMMENT ON MATERIALIZED VIEW public.mv_panini_public_deals IS
  'Panini leg of the public Below FMV board (cross_collection_deals_board, audit_20261025): per edition, the cheapest REGULAR serial whose confirmed ask (7 days) is at least 15 % under FMV AND under the median of recent sales (panini_deal_board_all deal_basis fmv_and_recent_sales), on an edition whose FMV is HIGH/MEDIUM. No owner column. Refreshed hourly at :44 by refresh_panini_public_deals().';

CREATE OR REPLACE FUNCTION public.refresh_panini_public_deals()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_rows    integer := 0;
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_panini_public_deals;
  SELECT count(*) INTO v_rows FROM public.mv_panini_public_deals;
  PERFORM public.log_pipeline_run('panini-public-deals', v_started, v_rows, v_rows, 0, true, NULL,
    'panini_blockchain', NULL, NULL, jsonb_build_object('source', 'audit_20261025'));
  RETURN v_rows;
EXCEPTION WHEN query_canceled OR OTHERS THEN
  PERFORM public.log_pipeline_run('panini-public-deals', v_started, 0, 0, 0, false, SQLERRM,
    'panini_blockchain', NULL, NULL, jsonb_build_object('source', 'audit_20261025', 'sqlstate', SQLSTATE));
  RETURN -1;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.refresh_panini_public_deals() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_panini_public_deals() TO postgres, service_role;

SELECT cron.schedule('panini-public-deals', '44 * * * *', $$SELECT public.refresh_panini_public_deals()$$);

CREATE OR REPLACE VIEW public.cross_collection_deals_board WITH (security_invoker = on) AS
 SELECT external_id,
    name,
    player_name,
    set_name,
    tier,
    circulation_count,
    fmv_usd,
    confidence,
    low_ask,
    discount_pct,
    discount_usd,
    ask_updated_at,
    collection_slug,
    collection_name,
    render_id,
    detail_url,
    thumbnail_url,
    low_ask_serial,
    low_ask_nft_id,
    low_confidence_fmv
   FROM mv_cross_collection_deals m
  WHERE (collection_slug IN ( SELECT c.slug
           FROM collections c
          WHERE (c.is_active IS TRUE)))
UNION ALL
 -- 2026-10-25: the Panini leg (mv_panini_public_deals, its own hourly MV — mv_cross_collection_deals
 -- cannot gain an arm in place).
 SELECT p.external_id,
    p.name,
    p.player_name,
    p.set_name,
    p.tier,
    p.circulation_count,
    p.fmv_usd,
    p.confidence,
    p.low_ask,
    p.discount_pct,
    p.discount_usd,
    p.ask_updated_at,
    'panini_blockchain'::text AS collection_slug,
    'Panini Blockchain'::text AS collection_name,
    NULL::text AS render_id,
    ('/panini-blockchain/edition/'::text || (p.external_id)::text) AS detail_url,
    p.thumbnail_url,
    p.low_ask_serial,
    NULL::text AS low_ask_nft_id,
    false AS low_confidence_fmv
   FROM mv_panini_public_deals p
  WHERE ('panini_blockchain'::text IN ( SELECT c.slug
           FROM collections c
          WHERE (c.is_active IS TRUE)));
