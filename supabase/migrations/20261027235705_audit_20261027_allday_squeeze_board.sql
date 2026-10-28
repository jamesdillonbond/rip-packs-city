-- audit_20261027: NFL All Day leg for /insights/squeeze (All Day ↔ Top Shot parity, pass 6).
--
-- The Lock-Rate Squeeze Board reads topshot_squeeze_board only. All Day's badge_editions carries locked / burned from
-- the same Atlas ingest family (allday-badge-ingest, daily ~5:37 AM PT): re-read 10-27 ~5:10 PM PT, 5,607 editions,
-- 0 NULL counts, 1,027 at ≥ 50 % squeeze. Same column contract as topshot_squeeze_board, so the board's lib, route and
-- client read either. Differences, on purpose:
--   * an edition with a NULL count is left out (unknown, never 0 %) — none today, but the view must not invent one;
--   * low_ask is the verified floor (allday_edition_floor_ask), not badge_editions.low_ask; low_ask_disconnected uses
--     Top Shot's rule (ask > 10 × FMV) and low_ask is NOT nulled when FMV is NULL (the floor is a fact on its own);
--   * top5_share_pct / holders are NULL: there is no All Day owner census (the wallet cache covers ~315 wallets).
-- security_invoker, service-role only (the route and page read it with the admin client).
--
-- Revert: DROP VIEW public.allday_squeeze_board;

CREATE VIEW public.allday_squeeze_board WITH (security_invoker = on) AS
SELECT e.id AS edition_id,
       e.external_id,
       COALESCE(e.player_name, be.player_name) AS player_name,
       COALESCE(e.set_name, be.set_name) AS set_name,
       COALESCE(e.tier::text, replace(be.tier, 'MOMENT_TIER_', '')) AS tier,
       c.circ AS circulation,
       be.locked,
       be.burned,
       round(100.0 * be.locked / c.circ, 1) AS lock_pct,
       round(100.0 * be.burned / c.circ, 1) AS burn_pct,
       round(100.0 * (be.locked + be.burned) / c.circ, 1) AS squeeze_pct,
       GREATEST(c.circ - be.locked - be.burned, 0) AS effectively_buyable,
       fa.floor_ask AS low_ask,
       efc.fmv_usd::numeric(12,4) AS fmv_usd,
       efc.confidence::text AS confidence,
       e.game_date,
       e.thumbnail_url,
       (efc.fmv_usd IS NOT NULL AND efc.fmv_usd > 0 AND fa.floor_ask IS NOT NULL AND fa.floor_ask > 10 * efc.fmv_usd) AS low_ask_disconnected,
       e.set_id,
       e.team_name,
       NULL::numeric AS top5_share_pct,
       NULL::integer AS holders
FROM public.badge_editions be
JOIN public.editions e ON e.external_id::text = be.external_id AND e.collection_id = be.collection_id
CROSS JOIN LATERAL (SELECT COALESCE(e.circulation_count, be.circulation_count) AS circ) c
LEFT JOIN public.allday_edition_floor_ask fa ON fa.edition_id = e.id
LEFT JOIN public.edition_fmv_current efc ON efc.edition_id = e.id
WHERE be.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
  AND e.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
  AND be.locked IS NOT NULL
  AND be.burned IS NOT NULL
  AND c.circ IS NOT NULL
  AND c.circ > 0;

REVOKE ALL ON public.allday_squeeze_board FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.allday_squeeze_board TO service_role;
