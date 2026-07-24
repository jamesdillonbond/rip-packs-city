-- Items C + D — Candy scarcity/sealed-vs-circulating + holder-concentration boards.
-- Gated pre-launch (read by /insights/candy-mlb via service_role). Treasury wallet
-- computed DYNAMICALLY (max holder) — never hardcoded. anon/authenticated REVOKED.
-- Applied live via MCP; this file is for repo/rebuild parity (re-applying is harmless).
-- Revert: DROP VIEW public.candy_holder_board, public.candy_scarcity_board, public.candy_treasury_wallet;

CREATE OR REPLACE VIEW public.candy_treasury_wallet
WITH (security_invoker = true) AS
SELECT wallet_address
FROM public.wallet_moments_cache
WHERE collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
GROUP BY wallet_address
ORDER BY count(*) DESC
LIMIT 1;
REVOKE ALL ON public.candy_treasury_wallet FROM anon, authenticated;
GRANT SELECT ON public.candy_treasury_wallet TO service_role;

CREATE OR REPLACE VIEW public.candy_scarcity_board
WITH (security_invoker = true) AS
WITH treas AS (SELECT wallet_address FROM public.candy_treasury_wallet),
h AS (
  SELECT w.edition_key,
    count(*) FILTER (WHERE w.wallet_address = (SELECT wallet_address FROM treas))  AS sealed,
    count(*) FILTER (WHERE w.wallet_address <> (SELECT wallet_address FROM treas))  AS circulating,
    count(DISTINCT w.wallet_address) FILTER (WHERE w.wallet_address <> (SELECT wallet_address FROM treas)) AS holders
  FROM public.wallet_moments_cache w
  WHERE w.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
  GROUP BY w.edition_key
)
SELECT
  e.external_id,
  e.player_name,
  e.name                                   AS edition_name,
  e.tier::text                             AS tier,
  (e.tier = 'LEGENDARY')                   AS is_rainbow,
  e.circulation_count,
  COALESCE(h.sealed, 0)                    AS sealed,
  COALESCE(h.circulating, 0)               AS circulating,
  round(100.0 * COALESCE(h.circulating, 0) / NULLIF(e.circulation_count, 0), 1) AS circulating_pct,
  COALESCE(h.holders, 0)                   AS holders,
  fc.fmv_usd,
  fc.confidence::text                      AS confidence
FROM public.editions e
LEFT JOIN h            ON h.edition_key = e.external_id
LEFT JOIN public.fmv_current fc ON fc.edition_id = e.id
WHERE e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid;
REVOKE ALL ON public.candy_scarcity_board FROM anon, authenticated;
GRANT SELECT ON public.candy_scarcity_board TO service_role;

CREATE OR REPLACE VIEW public.candy_holder_board
WITH (security_invoker = true) AS
WITH treas AS (SELECT wallet_address FROM public.candy_treasury_wallet),
held AS (
  SELECT w.wallet_address, w.edition_key, e.id AS edition_id
  FROM public.wallet_moments_cache w
  JOIN public.editions e
    ON e.external_id = w.edition_key
   AND e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
  WHERE w.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
    AND w.wallet_address <> (SELECT wallet_address FROM treas)
)
SELECT
  h.wallet_address,
  count(*)                              AS serials,
  count(DISTINCT h.edition_key)         AS editions,
  round(sum(fc.fmv_usd), 2)             AS est_fmv_usd,
  count(*) FILTER (WHERE fc.fmv_usd IS NOT NULL) AS priced_serials
FROM held h
LEFT JOIN public.fmv_current fc ON fc.edition_id = h.edition_id
GROUP BY h.wallet_address;
REVOKE ALL ON public.candy_holder_board FROM anon, authenticated;
GRANT SELECT ON public.candy_holder_board TO service_role;
