-- audit_20260924_candy_holder_board_excludes_an_inventory_wallet_while_it_never_trades
--
-- DECISION (delegated by Trevor 2026-09-24: "make that decision yourself based upon what's best for
-- RPC and our users"): the wallet 1BWutmTvYPwDtmw9abTkS4Ssr8no61spGAvW1X6NDix is excluded from the
-- public Candy holder board, but ONLY while it has no market activity at all. The exclusion
-- re-derives on every hourly refresh (pg_cron job 248), so the day it buys, sells, lists or bids,
-- it is ranked again with no one having to notice.
--
-- WHY. Since 20260923233939 it sat at #1 on the board, with 1,768 serials and ~$17.3k est. value,
-- over 4x the #2 wallet by value. Measured 2026-09-24 ~7:30 AM PT:
--   * ZERO on all five market instruments: moment buys, moment sells (sales), listings
--     (candy_listings, all rows incl. inactive), offers (candy_offers) and pack trades
--     (candy_pack_sales). Every other top-12 holder has 40-1,096 moment trades, so the instruments
--     demonstrably see collectors; this is not a coverage gap.
--   * Its per-edition spread looks like the treasury's, not a collector's: coefficient of variation
--     0.548 (treasury BhA2... 0.538; #2 collector 2srdg8... 1.334), and it holds all 125 editions.
--   * The second-largest sealed-pack holder after the treasury (38 packs on 2026-08-10, 15 now;
--     every other top holder has 0-1).
-- That is inventory, not a collector. A holder board exists to rank collectors, and an inventory
-- wallet at #1 misstates who collects this product.
--
-- WHAT THIS DOES NOT CLAIM. It does not assert that the wallet belongs to Candy Digital; nothing
-- here can prove ownership. So it is NOT merged into the treasury label (candy_treasury_wallet),
-- and the scarcity board's sealed/circulating split is unchanged. Only the holder ranking changes,
-- and the page discloses the rule.
--
-- SHAPE. A small exclusions table (RLS on, no client grants) carries the wallet, the reason and
-- the evidence, so the decision is data rather than a literal buried in a view. The MV is rebuilt
-- with its previous body kept VERBATIM except for the `excluded` CTE and one extra predicate.
-- A materialized view cannot be altered, so it is dropped and re-created, together with its
-- dependent view candy_holder_board, the unique index that REFRESH CONCURRENTLY needs, and the
-- exact ACLs both had before (read live immediately before this migration).
--
-- REVERT: DELETE FROM public.candy_holder_board_exclusions; then
-- REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_candy_holder_board;
-- (that alone restores the previous board). A full revert re-applies the MV body from
-- 20260923233939 and drops the table.
--
-- anon-exec: not applicable — this migration creates no function.

CREATE TABLE IF NOT EXISTS public.candy_holder_board_exclusions (
  wallet_address text PRIMARY KEY,
  reason         text NOT NULL,
  evidence       jsonb,
  decided_at     timestamptz NOT NULL DEFAULT now(),
  decided_by     text NOT NULL
);
ALTER TABLE public.candy_holder_board_exclusions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.candy_holder_board_exclusions FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.candy_holder_board_exclusions TO service_role;
COMMENT ON TABLE public.candy_holder_board_exclusions IS
  'Wallets kept off the public Candy holder board. An entry applies ONLY while the wallet has zero market activity (sales buy/sell, candy_listings, candy_offers, candy_pack_sales); mv_candy_holder_board re-checks that on every refresh, so a wallet that ever trades is ranked again automatically.';

INSERT INTO public.candy_holder_board_exclusions (wallet_address, reason, evidence, decided_by)
VALUES (
  '1BWutmTvYPwDtmw9abTkS4Ssr8no61spGAvW1X6NDix',
  'Inventory-shaped wallet: large holdings, zero market activity on every instrument. Ownership not proven, so not labelled as the treasury.',
  jsonb_build_object(
    'measured_at', '2026-09-24',
    'serials', 1768, 'editions', 125, 'est_fmv_usd', 17255.17,
    'market_activity', jsonb_build_object('moment_trades', 0, 'listings', 0, 'offers', 0, 'pack_trades', 0),
    'top12_other_holders_moment_trades_range', '40-1096',
    'edition_spread_cv', jsonb_build_object('this_wallet', 0.548, 'treasury', 0.538, 'number_2_collector', 1.334),
    'sealed_packs', jsonb_build_object('2026-08-10', 38, '2026-09-24', 15)
  ),
  'Claude Code under delegation from Trevor, 2026-09-24'
)
ON CONFLICT (wallet_address) DO NOTHING;

DROP MATERIALIZED VIEW public.mv_candy_holder_board CASCADE;

CREATE MATERIALIZED VIEW public.mv_candy_holder_board AS
 WITH held AS MATERIALIZED (
         SELECT wallet_moments_cache.wallet_address,
            wallet_moments_cache.edition_key
           FROM wallet_moments_cache
          WHERE (wallet_moments_cache.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid)
        ), treas AS MATERIALIZED (
         SELECT COALESCE(( SELECT candy_packs.owner
                   FROM candy_packs
                  WHERE (candy_packs.owner IS NOT NULL)
                  GROUP BY candy_packs.owner
                  ORDER BY (count(*)) DESC, candy_packs.owner
                 LIMIT 1), ( SELECT held_1.wallet_address
                   FROM held held_1
                  GROUP BY held_1.wallet_address
                  ORDER BY (count(*)) DESC
                 LIMIT 1)) AS wallet_address
        ), excluded AS MATERIALIZED (
         SELECT x.wallet_address
           FROM candy_holder_board_exclusions x
          WHERE NOT EXISTS (SELECT 1 FROM sales s
                             WHERE s.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
                               AND s.buyer_address = x.wallet_address)
            AND NOT EXISTS (SELECT 1 FROM sales s
                             WHERE s.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
                               AND s.seller_address = x.wallet_address)
            AND NOT EXISTS (SELECT 1 FROM candy_listings l WHERE l.seller = x.wallet_address)
            AND NOT EXISTS (SELECT 1 FROM candy_offers o WHERE o.buyer = x.wallet_address)
            AND NOT EXISTS (SELECT 1 FROM candy_pack_sales p
                             WHERE p.buyer = x.wallet_address OR p.seller = x.wallet_address)
        ), key_fmv AS MATERIALIZED (
         SELECT (e.external_id)::text AS edition_key,
            c.fmv_usd
           FROM (editions e
             LEFT JOIN ( SELECT DISTINCT ON (fmv_snapshots.edition_id) fmv_snapshots.edition_id,
                    fmv_snapshots.fmv_usd
                   FROM fmv_snapshots
                  WHERE (fmv_snapshots.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid)
                  ORDER BY fmv_snapshots.edition_id, fmv_snapshots.computed_at DESC) c ON ((c.edition_id = e.id)))
          WHERE (e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid)
        )
 SELECT h.wallet_address,
    count(*) AS serials,
    count(DISTINCT h.edition_key) AS editions,
    round(sum(k.fmv_usd), 2) AS est_fmv_usd,
    count(*) FILTER (WHERE (k.fmv_usd IS NOT NULL)) AS priced_serials
   FROM (held h
     LEFT JOIN key_fmv k ON ((k.edition_key = h.edition_key)))
  WHERE (h.wallet_address <> ( SELECT treas.wallet_address
           FROM treas))
    AND NOT EXISTS (SELECT 1 FROM excluded ex WHERE ex.wallet_address = h.wallet_address)
  GROUP BY h.wallet_address;

CREATE UNIQUE INDEX mv_candy_holder_board_wallet_uidx ON public.mv_candy_holder_board USING btree (wallet_address);

REVOKE ALL ON public.mv_candy_holder_board FROM PUBLIC;
GRANT ALL ON public.mv_candy_holder_board TO service_role;
GRANT MAINTAIN ON public.mv_candy_holder_board TO anon, authenticated;

CREATE VIEW public.candy_holder_board WITH (security_invoker = on) AS
 SELECT wallet_address,
    serials,
    editions,
    est_fmv_usd,
    priced_serials
   FROM mv_candy_holder_board;

REVOKE ALL ON public.candy_holder_board FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.candy_holder_board TO service_role;

DO $assert$
DECLARE v_in int; v_rows int; v_acl text;
BEGIN
  SELECT count(*) INTO v_in FROM public.mv_candy_holder_board
   WHERE wallet_address = '1BWutmTvYPwDtmw9abTkS4Ssr8no61spGAvW1X6NDix';
  IF v_in <> 0 THEN RAISE EXCEPTION 'the excluded inventory wallet is still on the holder board'; END IF;
  SELECT count(*) INTO v_rows FROM public.mv_candy_holder_board;
  IF v_rows < 300 THEN RAISE EXCEPTION 'holder board shrank to % rows; expected ~400', v_rows; END IF;
  SELECT relacl::text INTO v_acl FROM pg_class WHERE oid = 'public.candy_holder_board'::regclass;
  IF v_acl LIKE '%anon%' OR v_acl LIKE '%authenticated%' THEN
    RAISE EXCEPTION 'candy_holder_board ACL widened: %', v_acl;
  END IF;
END
$assert$;
