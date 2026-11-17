-- Item E — Candy parallel-premium (Core vs Rainbow) + player rollup.
-- Trevor green-lit staging parallel-premium now despite thin Rainbow FMV (2026-07-24).
-- Applied live via MCP; repo/rebuild parity.
-- Revert: DROP VIEW public.candy_player_board, public.candy_parallel_premium;
CREATE OR REPLACE VIEW public.candy_parallel_premium
WITH (security_invoker = true) AS
SELECT
  CASE WHEN e.tier = 'LEGENDARY' THEN 'Rainbow' ELSE 'Core (ICON)' END AS parallel_group,
  (e.tier = 'LEGENDARY')                   AS is_rainbow,
  count(*)                                 AS editions,
  count(fc.fmv_usd)                        AS priced,
  round(avg(fc.fmv_usd), 2)                AS avg_fmv,
  round(min(fc.fmv_usd), 2)                AS min_fmv,
  round(max(fc.fmv_usd), 2)                AS max_fmv,
  sum(e.circulation_count)                 AS total_supply
FROM public.editions e
LEFT JOIN public.fmv_current fc ON fc.edition_id = e.id
WHERE e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
GROUP BY (e.tier = 'LEGENDARY');
REVOKE ALL ON public.candy_parallel_premium FROM anon, authenticated;
GRANT SELECT ON public.candy_parallel_premium TO service_role;

CREATE OR REPLACE VIEW public.candy_player_board
WITH (security_invoker = true) AS
WITH sale_ct AS (
  SELECT edition_id, count(*) AS sales_all
  FROM public.sales
  WHERE collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid AND edition_id IS NOT NULL
  GROUP BY edition_id
)
SELECT
  e.player_name,
  max(e.team_name)                                       AS team_name,
  count(*)                                               AS editions,
  count(*) FILTER (WHERE e.tier = 'LEGENDARY')           AS rainbow_editions,
  sum(e.circulation_count)                               AS total_supply,
  count(fc.fmv_usd)                                      AS priced,
  round(avg(fc.fmv_usd), 2)                              AS avg_fmv,
  round(max(fc.fmv_usd), 2)                              AS top_fmv,
  COALESCE(sum(sc.sales_all), 0)                         AS sales_all
FROM public.editions e
LEFT JOIN public.fmv_current fc ON fc.edition_id = e.id
LEFT JOIN sale_ct sc            ON sc.edition_id = e.id
WHERE e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
  AND e.player_name IS NOT NULL
GROUP BY e.player_name;
REVOKE ALL ON public.candy_player_board FROM anon, authenticated;
GRANT SELECT ON public.candy_player_board TO service_role;
