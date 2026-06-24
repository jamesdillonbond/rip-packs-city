
-- AllDay "scarce + below-FMV" board: the AllDay analog of the TS underpriced-serials
-- surface. Intersects allday_scarcity_board's (set,tier)-family scarcity with a live
-- floor below a SALES-derived FMV (HIGH/MEDIUM/LOW only — ASK_ONLY is floor-derived,
-- so it can't be "below" its own floor). Surfaces scarce editions listed under value.
-- Read-only, additive, security_invoker.
CREATE OR REPLACE VIEW public.allday_scarce_deals_board
WITH (security_invoker = on) AS
WITH family_avg AS (
  SELECT set_name, tier, avg(circulation_count) AS family_avg_mint, count(*) AS family_size
  FROM public.editions
  WHERE collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
    AND circulation_count IS NOT NULL AND circulation_count > 0 AND set_name IS NOT NULL
  GROUP BY set_name, tier
)
SELECT
  e.external_id,
  e.player_name,
  e.set_name,
  e.tier::text AS tier,
  e.team_name,
  e.series,
  e.circulation_count AS mint_count,
  round(fa.family_avg_mint, 0) AS family_avg_mint,
  fa.family_size,
  round(100.0 * (1::numeric - e.circulation_count::numeric / NULLIF(fa.family_avg_mint, 0::numeric)), 1) AS scarcity_vs_family_pct,
  latest.fmv_usd,
  latest.confidence::text AS fmv_confidence,
  fl.floor_ask,
  fl.floor_flow_id,
  round(100.0 * (1::numeric - fl.floor_ask / NULLIF(latest.fmv_usd, 0::numeric)), 1) AS discount_pct,
  e.thumbnail_url
FROM public.editions e
JOIN family_avg fa ON fa.set_name = e.set_name AND fa.tier IS NOT DISTINCT FROM e.tier
JOIN LATERAL (
  SELECT fmv_usd, confidence FROM public.fmv_snapshots fs
  WHERE fs.edition_id = e.id ORDER BY computed_at DESC LIMIT 1
) latest ON true
JOIN public.allday_edition_floor_ask fl ON fl.edition_id = e.id
WHERE e.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
  AND e.circulation_count IS NOT NULL AND e.circulation_count > 0 AND e.set_name IS NOT NULL
  AND fa.family_size >= 3
  AND e.circulation_count::numeric < fa.family_avg_mint
  AND latest.confidence IN ('HIGH','MEDIUM','LOW')
  AND fl.floor_ask > 0 AND fl.floor_ask < latest.fmv_usd;

GRANT SELECT ON public.allday_scarce_deals_board TO anon, authenticated, service_role;
