-- AllDay scarcity board: the squeeze/scarcity analog for NFL All Day. AllDay has
-- no lock/burn mechanic (TS) and no per-render variants (Pinnacle), so scarcity is
-- measured the Pinnacle way — how far below an edition's comparable family's
-- average mint it sits. Family = (set_name, tier), the characteristic mint cohort
-- in AllDay. Mirrors public.pinnacle_scarcity_board. Read-only, additive.
--
-- Applied live 2026-06-23 via Supabase MCP; this file is the repo-parity copy.
CREATE OR REPLACE VIEW public.allday_scarcity_board
WITH (security_invoker = on) AS
WITH family_avg AS (
  SELECT set_name, tier,
         avg(circulation_count) AS family_avg_mint,
         count(*) AS family_size
  FROM public.editions
  WHERE collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
    AND circulation_count IS NOT NULL AND circulation_count > 0
    AND set_name IS NOT NULL
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
  e.thumbnail_url,
  e.video_url
FROM public.editions e
JOIN family_avg fa ON fa.set_name = e.set_name AND fa.tier IS NOT DISTINCT FROM e.tier
LEFT JOIN LATERAL (
  SELECT fmv_usd, confidence FROM public.fmv_snapshots fs
  WHERE fs.edition_id = e.id ORDER BY computed_at DESC LIMIT 1
) latest ON true
WHERE e.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
  AND e.circulation_count IS NOT NULL AND e.circulation_count > 0
  AND e.set_name IS NOT NULL;

GRANT SELECT ON public.allday_scarcity_board TO anon, authenticated, service_role;
