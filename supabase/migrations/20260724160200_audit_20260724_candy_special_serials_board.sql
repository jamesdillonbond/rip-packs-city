-- Item B — Candy special-serials board (#1 / last-mint / low-serial owners).
-- Candy's honest analog of special_serial_owners_board: NO jersey_number on Candy
-- players (jersey-match is N/A), so this is framed on #1 + serial-position rarity.
-- Applied live via MCP; repo/rebuild parity. Revert: DROP VIEW public.candy_special_serials_board;
CREATE OR REPLACE VIEW public.candy_special_serials_board
WITH (security_invoker = true) AS
WITH treas AS (SELECT wallet_address FROM public.candy_treasury_wallet)
SELECT
  e.external_id,
  e.player_name,
  e.name                                   AS edition_name,
  e.tier::text                             AS tier,
  (e.tier = 'LEGENDARY')                   AS is_rainbow,
  e.circulation_count,
  w.serial_number,
  CASE
    WHEN w.serial_number = 1                     THEN 'first_mint'
    WHEN w.serial_number = e.circulation_count   THEN 'last_mint'
    ELSE 'low_serial'
  END                                      AS kind,
  w.wallet_address                         AS owner,
  (w.wallet_address = (SELECT wallet_address FROM treas)) AS is_treasury,
  fc.fmv_usd,
  fc.confidence::text                      AS confidence,
  ls.last_sale_usd,
  ls.last_sale_at
FROM public.wallet_moments_cache w
JOIN public.editions e
  ON e.external_id = w.edition_key
 AND e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
LEFT JOIN public.fmv_current fc ON fc.edition_id = e.id
LEFT JOIN LATERAL (
  SELECT s.price_usd AS last_sale_usd, s.sold_at AS last_sale_at
  FROM public.sales s
  WHERE s.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
    AND s.edition_id = e.id
    AND s.serial_number = w.serial_number
  ORDER BY s.sold_at DESC
  LIMIT 1
) ls ON true
WHERE w.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
  AND w.serial_number IS NOT NULL
  AND (w.serial_number = 1 OR w.serial_number = e.circulation_count OR w.serial_number <= 3);
REVOKE ALL ON public.candy_special_serials_board FROM anon, authenticated;
GRANT SELECT ON public.candy_special_serials_board TO service_role;
