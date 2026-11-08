-- audit_20261108_candy_held_by_candy_counts_every_candy_wallet
--
-- "Sealed" on the Candy Base Series scarcity board, and SEALED on the special-serials
-- board, mean "still held by Candy, not by a collector". Both counted ONE wallet: the
-- sealed-pack custodian. Before Candy's October wallet migration that wallet also held
-- Candy's unpulled ICONs. After it, Candy keeps them apart (traced on chain 2026-11-08):
--   sealed packs     jiY25VMs…hua  2,339 packs, 0 ICONs
--   ICON inventory   6uKecEED…aW   1,644 ICONs, minted to Candy, never collector-owned
--   ICON buyback     Bh43uNnQ…AC3  1,067 ICONs sold back 10-09/10
-- so the board read sealed 0 and "% Out" 100 % on all 125 editions, and every Candy-held
-- #1 / low / jersey serial showed a collector owner.
--
-- Fix: candy_holder_board_exclusions gains holder_kind (what the excluded wallet IS:
-- marketplace_escrow — collectors' listed cards, still circulating — or a Candy wallet),
-- and one view, candy_house_wallets, names every Candy-owned wallet (the treasury label
-- plus the Candy-kind exclusions). The scarcity matview and the special-serials view read
-- it. The escrow stays circulating: those cards belong to the sellers. A Candy wallet stays
-- Candy-held even if Candy relists from it (unlike the holder-board exclusion, which lifts
-- when the wallet trades — a trading wallet is ranked, but its stock is still Candy's).
--
-- Columns of every object unchanged (the matview is dropped and recreated with its unique
-- index and ACL; candy_scarcity_board recreated; security_invoker restated).
--
-- Rollback: re-apply the mv_candy_scarcity_board / candy_scarcity_board block of
--   20261108190334 and the candy_special_serials_board body of 20261108191456; then
--   DROP VIEW candy_house_wallets; ALTER TABLE candy_holder_board_exclusions DROP COLUMN holder_kind;

ALTER TABLE public.candy_holder_board_exclusions
  ADD COLUMN holder_kind text
  CHECK (holder_kind IN ('marketplace_escrow', 'candy_inventory', 'candy_buyback'));

UPDATE public.candy_holder_board_exclusions SET holder_kind = 'marketplace_escrow'
 WHERE wallet_address = '1BWutmTvYPwDtmw9abTkS4Ssr8no61spGAvW1X6NDix';
UPDATE public.candy_holder_board_exclusions SET holder_kind = 'candy_inventory'
 WHERE wallet_address = '6uKecEEDfWyWY6HLkPJ2kpKUgq8HekLRjtuTatoPqCaW';
UPDATE public.candy_holder_board_exclusions SET holder_kind = 'candy_buyback'
 WHERE wallet_address = 'Bh43uNnQgFC11gS5bQ6sE8sJVBNBSQi95PjN1U2fUAC3';

ALTER TABLE public.candy_holder_board_exclusions ALTER COLUMN holder_kind SET NOT NULL;

CREATE VIEW public.candy_house_wallets WITH (security_invoker = on) AS
 SELECT t.wallet_address, 'treasury'::text AS holder_kind
   FROM candy_treasury_wallet t
  WHERE t.wallet_address IS NOT NULL
UNION
 SELECT x.wallet_address, x.holder_kind
   FROM candy_holder_board_exclusions x
  WHERE x.holder_kind IN ('candy_inventory', 'candy_buyback');
REVOKE ALL ON public.candy_house_wallets FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.candy_house_wallets TO service_role;
COMMENT ON VIEW public.candy_house_wallets IS
  'Every wallet Candy itself owns (sealed-pack treasury, ICON inventory, ICON buyback). Cards here are "held by Candy" on the scarcity and special-serials boards. Not the Magic Eden escrow: listed cards belong to their sellers.';

DROP MATERIALIZED VIEW public.mv_candy_scarcity_board CASCADE;
CREATE MATERIALIZED VIEW public.mv_candy_scarcity_board AS
 WITH wmc AS MATERIALIZED (
         SELECT wallet_moments_cache.edition_key,
            wallet_moments_cache.wallet_address
           FROM wallet_moments_cache
          WHERE (wallet_moments_cache.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid)
        ), house AS MATERIALIZED (
         SELECT DISTINCT candy_house_wallets.wallet_address
           FROM candy_house_wallets
        ), h AS (
         SELECT w.edition_key,
            count(*) FILTER (WHERE (w.wallet_address IN ( SELECT house.wallet_address
                   FROM house))) AS sealed,
            count(*) FILTER (WHERE (w.wallet_address NOT IN ( SELECT house.wallet_address
                   FROM house))) AS circulating,
            count(DISTINCT w.wallet_address) FILTER (WHERE (w.wallet_address NOT IN ( SELECT house.wallet_address
                   FROM house))) AS holders
           FROM wmc w
          GROUP BY w.edition_key
        )
 SELECT e.external_id,
    e.player_name,
    e.name AS edition_name,
    (e.tier)::text AS tier,
    (e.tier = 'LEGENDARY'::tier_type) AS is_rainbow,
    e.circulation_count,
    COALESCE(h.sealed, (0)::bigint) AS sealed,
    COALESCE(h.circulating, (0)::bigint) AS circulating,
    round(((100.0 * (COALESCE(h.circulating, (0)::bigint))::numeric) / (NULLIF(e.circulation_count, 0))::numeric), 1) AS circulating_pct,
    COALESCE(h.holders, (0)::bigint) AS holders,
    fc.fmv_usd,
    (fc.confidence)::text AS confidence
   FROM ((editions e
     LEFT JOIN h ON ((h.edition_key = (e.external_id)::text)))
     LEFT JOIN candy_fmv_current fc ON ((fc.edition_id = e.id)))
  WHERE ((e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid) AND (e.set_id = '381ae129-7dc7-47f4-9022-dd9e0fc21e39'::uuid));
CREATE UNIQUE INDEX mv_candy_scarcity_board_external_id_uidx ON public.mv_candy_scarcity_board USING btree (external_id);
REVOKE ALL ON public.mv_candy_scarcity_board FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.mv_candy_scarcity_board TO service_role;
GRANT MAINTAIN ON public.mv_candy_scarcity_board TO anon, authenticated;

CREATE VIEW public.candy_scarcity_board WITH (security_invoker = on) AS
 SELECT external_id,
    player_name,
    edition_name,
    tier,
    is_rainbow,
    circulation_count,
    sealed,
    circulating,
    circulating_pct,
    holders,
    fmv_usd,
    confidence
   FROM mv_candy_scarcity_board;
REVOKE ALL ON public.candy_scarcity_board FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.candy_scarcity_board TO service_role;

CREATE OR REPLACE VIEW public.candy_special_serials_board WITH (security_invoker = on) AS
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
