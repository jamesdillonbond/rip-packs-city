-- audit_20261127_sold_pack_outcomes
--
-- 2026-11-27 (PT, morning; Claude Code cloud; Trevor: "I'd like to see if any of the packs I sold had
-- something good" -> "Yes do it all").
--
-- WHAT: get_wallet_sold_pack_outcomes(p_wallet, p_pack_nft_ids) answers, for packs THIS wallet sold
-- sealed, what the next owner pulled: who opened it, when, every pull (player / set / tier / serial /
-- current FMV) and the pull total. The binder's Sold tab reads it for the page it is showing.
--
-- WHY no new lane: the pulls are already recorded for ANY opener, not only saved wallets --
--   * Top Shot: moment_acquisitions.source_pack_rip_id (flowty_ingest, method pack_pull) links each
--     pulled moment to its pack_rips row; measured on every pack a saved wallet sold (8,736 Top Shot):
--     8,446 opened, 27,492 of 27,982 expected pulls linked. pack_open_pulls (the wallet walk) is read
--     too, for a pack the seller re-bought and opened.
--   * All Day: allday_pack_pull (pack_nft_id -> moment, edition) -- 27 of 27 opened sold packs, 110/110
--     pulls named.
-- So this is a READER over existing rows; nothing is written.
--
-- VALUE BASIS: current FMV (latest fmv_snapshots row per edition), the same basis pack_rips.pull_value_usd
-- and the Opened tab use. ALL-OR-NOTHING: pull_value_usd is NULL unless every pull is named and priced and
-- the named count equals pack_rips.moments_pulled -- a partial sum never reads as the pack's value.
-- pulls_named / pulls_priced / moments_pulled say how far it got.
--
-- SCOPE / PRIVACY: a pack is answered only if p_wallet appears as its SELLER in pack_purchases; any other
-- id in the list is dropped. The opener is named by username (wallet_usernames, then RPC profile); with
-- no known username the address is NOT returned (Trevor's rule: users by username, never address) --
-- opener_is_you says when the seller opened it themselves after re-buying.
-- Capped at 100 ids a call (the binder page is 25).
--
-- (Re-applied the same morning with the hex-guarded wallet fold below, same name; the body here is
-- what production runs.)
--
-- REVERT: DROP FUNCTION public.get_wallet_sold_pack_outcomes(text, text[]);

CREATE OR REPLACE FUNCTION public.get_wallet_sold_pack_outcomes(p_wallet text, p_pack_nft_ids text[])
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '15s'
AS $fn$
WITH me AS (
  -- Flow addresses fold to lower case; a base58 (Solana) key is case-sensitive and is kept as given.
  SELECT CASE WHEN p_wallet ~* '^0x' THEN lower(p_wallet) ELSE p_wallet END AS w
),
ids AS (
  SELECT DISTINCT x AS pack_nft_id
  FROM unnest(p_pack_nft_ids[1:100]) AS x
  WHERE x IS NOT NULL AND x <> ''
),
sold AS (
  -- only packs this wallet sold; the latest sale of each is the one that let it go
  SELECT DISTINCT ON (pp.pack_nft_id)
         pp.pack_nft_id, pp.collection_id, pp.buyer_address, pp.sale_price, pp.sealed_at AS sold_at
  FROM ids
  JOIN public.pack_purchases pp ON pp.pack_nft_id = ids.pack_nft_id
  WHERE pp.seller_address = (SELECT w FROM me)
  ORDER BY pp.pack_nft_id, pp.sealed_at DESC
),
rip AS (
  SELECT s.pack_nft_id, s.collection_id, r.id AS rip_id, r.opener_address, r.sealed_at AS opened_at,
         r.moments_pulled
  FROM sold s
  JOIN public.pack_rips r ON r.pack_nft_id = s.pack_nft_id AND r.collection_id = s.collection_id
),
pull_ids AS (
  -- Top Shot (and any collection whose pulls carry source_pack_rip_id)
  SELECT rip.pack_nft_id, rip.collection_id, ma.nft_id, NULL::uuid AS edition_id
  FROM rip
  JOIN public.moment_acquisitions ma
    ON ma.source_pack_rip_id = rip.rip_id AND ma.collection_id = rip.collection_id
  WHERE ma.acquisition_method = 'pack_pull'
  UNION
  -- the wallet walk (a seller who re-bought and opened it, or a saved-wallet opener)
  SELECT rip.pack_nft_id, rip.collection_id, p.nft_id, p.edition_id
  FROM rip
  JOIN public.pack_open_pulls p
    ON p.collection_id = rip.collection_id AND p.pack_nft_id = rip.pack_nft_id
  UNION
  -- All Day
  SELECT rip.pack_nft_id, rip.collection_id, a.moment_nft_id, a.edition_id
  FROM rip
  JOIN public.allday_pack_pull a ON a.pack_nft_id = rip.pack_nft_id
  WHERE rip.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
),
pulls AS (
  -- one row per pulled moment; an edition named by any source wins over NULL
  SELECT pack_nft_id, collection_id, nft_id, (array_agg(edition_id) FILTER (WHERE edition_id IS NOT NULL))[1] AS edition_id
  FROM pull_ids
  GROUP BY pack_nft_id, collection_id, nft_id
),
named AS (
  SELECT p.pack_nft_id, p.nft_id,
         COALESCE(p.edition_id, m.edition_id) AS edition_id,
         m.serial_number
  FROM pulls p
  LEFT JOIN public.moments m ON m.collection_id = p.collection_id AND m.nft_id = p.nft_id
),
priced AS (
  SELECT n.pack_nft_id, n.nft_id, n.edition_id, n.serial_number,
         e.player_name, e.set_name, e.tier::text AS tier, e.circulation_count,
         f.fmv_usd
  FROM named n
  LEFT JOIN public.editions e ON e.id = n.edition_id
  LEFT JOIN LATERAL (
    SELECT s.fmv_usd FROM public.fmv_snapshots s
    WHERE s.edition_id = n.edition_id
    ORDER BY s.computed_at DESC
    LIMIT 1
  ) f ON n.edition_id IS NOT NULL
),
per_pack AS (
  SELECT pack_nft_id,
         count(*) AS pulls_named_ids,
         count(*) FILTER (WHERE edition_id IS NOT NULL) AS pulls_named,
         count(*) FILTER (WHERE fmv_usd IS NOT NULL) AS pulls_priced,
         sum(fmv_usd) AS fmv_sum,
         jsonb_agg(jsonb_build_object(
           'nft_id', nft_id,
           'edition_id', edition_id,
           'player_name', player_name,
           'set_name', set_name,
           'tier', tier,
           'serial_number', serial_number,
           'circulation_count', circulation_count,
           'fmv_usd', round(fmv_usd::numeric, 2)
         ) ORDER BY fmv_usd DESC NULLS LAST, nft_id) AS pulls
  FROM priced
  GROUP BY pack_nft_id
)
SELECT COALESCE(jsonb_agg(jsonb_build_object(
  'pack_nft_id', s.pack_nft_id,
  'sold_at', s.sold_at,
  'sale_price', s.sale_price,
  'opened', rip.rip_id IS NOT NULL,
  'opened_at', rip.opened_at,
  'opener_is_you', rip.opener_address IS NOT NULL AND rip.opener_address = (SELECT w FROM me),
  'opener_username', CASE WHEN rip.opener_address IS NULL OR rip.opener_address = (SELECT w FROM me) THEN NULL
                          ELSE COALESCE(wu.username, up.username) END,
  'moments_pulled', rip.moments_pulled,
  'pulls_named', COALESCE(pp.pulls_named, 0),
  'pulls_priced', COALESCE(pp.pulls_priced, 0),
  -- all-or-nothing: every pull named and priced, and as many as the rip says it yielded
  'pull_value_usd', CASE WHEN rip.moments_pulled IS NOT NULL AND pp.pulls_priced = rip.moments_pulled
                              AND pp.pulls_named_ids = rip.moments_pulled
                         THEN round(pp.fmv_sum::numeric, 2) END,
  'pulls', COALESCE(pp.pulls, '[]'::jsonb)
) ORDER BY s.sold_at DESC), '[]'::jsonb)
FROM sold s
LEFT JOIN rip ON rip.pack_nft_id = s.pack_nft_id
LEFT JOIN per_pack pp ON pp.pack_nft_id = s.pack_nft_id
LEFT JOIN public.wallet_usernames wu ON wu.wallet_addr = rip.opener_address
LEFT JOIN LATERAL (
  SELECT u.username FROM public.user_profiles u WHERE u.wallet_address = rip.opener_address LIMIT 1
) up ON rip.opener_address IS NOT NULL;
$fn$;

COMMENT ON FUNCTION public.get_wallet_sold_pack_outcomes(text, text[]) IS
  'Binder Sold tab (2026-11-27): for packs p_wallet SOLD sealed, who opened them, when, and every pull at current FMV (all-or-nothing total). Reader only. Migration audit_20261127_sold_pack_outcomes.';

REVOKE EXECUTE ON FUNCTION public.get_wallet_sold_pack_outcomes(text, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_wallet_sold_pack_outcomes(text, text[]) TO service_role;

DO $mig$
BEGIN
  IF has_function_privilege('anon', 'public.get_wallet_sold_pack_outcomes(text, text[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon EXECUTE leaked on get_wallet_sold_pack_outcomes';
  END IF;
  IF has_function_privilege('authenticated', 'public.get_wallet_sold_pack_outcomes(text, text[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated EXECUTE leaked on get_wallet_sold_pack_outcomes';
  END IF;
END
$mig$;
