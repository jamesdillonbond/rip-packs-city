-- DB invariant: public.get_wallet_pack_history — the per-pack timeline behind
-- the wallet Packs tabs (/dashboard/packs, the Collection tab's Packs body) and
-- the sold-packs alert. Three claims it must keep, each of which was FALSE in
-- production until 2026-09-18:
--
--   1. A pack the wallet sold on the Dapper marketplace COUNTS AS SOLD. The
--      on-chain table records the transaction PAYER (Dapper's escrow) as the
--      seller, so `pack_purchases.seller_address = wallet` matched 2 rows of
--      105,505 platform-wide and every wallet read "0 sold". The seller lives in
--      topshot_pack_sales_history / allday_pack_sales_history.storefront_address.
--   2. An unknown price is NULL, never 0. Every Top Shot primary drop has
--      sale_price NULL on chain, and the old body emitted COALESCE(.., 0), so
--      sealed drop packs rendered "BUY $0" and unvalued rips "PULL VALUE $0".
--   3. A sealed pack's distribution resolves from ANY marketplace row for that
--      pack_nft_id, not only from the wallet's own rip — and a pack with no
--      source at all stays NULL rather than borrowing a neighbour's.
--   4. (v5, 2026-09-18) A pack Dapper's index says another wallet now holds,
--      with no sale or rip by this wallet, is TRANSFERRED, never HELD; and the
--      index is a dist source of last resort (dist_source = 'dapper_index').
--   5. (v6) A pack the index says the wallet HOLDS with no buy of ours is HELD
--      (buy NULL, never 0); one it says the wallet OPENED with no rip of ours is
--      RIPPED with pull value NULL. A sale we hold out-ranks a stale identity.
--   6. (v7, 2026-09-20) AN OWNERSHIP CLAIM IS ONLY AS GOOD AS THE WALK THAT
--      CONFIRMED IT. A pack that LEAVES the wallet is never returned by a later
--      walk, so its index row keeps owner_address = that wallet for ever --
--      pack_nft_identity_queue only re-checks packs carrying a purchase or a rip
--      row, so an OPENED pack that leaves is refreshed through its new owner's
--      purchase while a SEALED one that leaves by transfer has no re-check path
--      at all. Measured across the 27 saved wallets on 2026-09-20: 23 such rows
--      on 5 wallets, and 23 OF 23 WERE SEALED -- every one of them rendered to
--      its owner as an unopened pack they still held. So a row older than
--      pack_wallet_sync.last_clean_sync_at is NOT a holding: index-only, it
--      leaves the list entirely; with a buy of ours it is TRANSFERRED, never
--      HELD; and current_owner goes NULL rather than repeat a name known wrong.
--      ⚠ The guard is OFF when there is no clean walk to measure against --
--      never synced, in flight, errored, page-capped -- because suppressing on a
--      PARTIAL walk is the same defect pointing the other way. P19 is the
--      no-change control for that, and the fix cannot move it.
--   7. (v8, 2026-09-26) WIDER AND DEEPER. Golazos and Pinnacle opens (their own
--      tables; pack_rips holds neither) are RIPPED rows, and Golazos marketplace
--      buys/sells count like Top Shot's and All Day's. A pack's pull value comes
--      first from pack_open_pull_values -- priced from the moments Dapper's index
--      says the pack yielded -- and ONLY for the wallet that opened it; the rip
--      row's value is the fallback, and pull_value_source says which. A pack whose
--      pull list is partly priced publishes NULL plus pulls_priced / pulls_total,
--      never a partial sum.
--   8. (v9, 2026-09-26) Packs opened with NO pack NFT (custodial Top Shot
--      packs), rebuilt from moment delivery bursts (wallet_reconstructed_rips),
--      are RIPPED rows with rip_source = 'reconstructed', a labelled name, and
--      pull_value_source = 'delivery_burst' -- and ONLY for their own wallet.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260926170100_audit_20260926_wallet_pack_history_lists_reconstructed_rips.sql).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.collections (id uuid PRIMARY KEY, slug text UNIQUE, name text);
CREATE TABLE public.pack_purchases (
  id uuid DEFAULT gen_random_uuid(), collection_id uuid, pack_nft_id text,
  buyer_address text, seller_address text, sale_price numeric, sale_currency text,
  sealed_at timestamptz, is_primary_drop boolean DEFAULT false, event_kind text, pack_dist_id text
);
CREATE TABLE public.topshot_pack_sales_history (
  tx_hash text, pack_nft_id text, sale_price_usd numeric, purchased boolean,
  buyer_address text, storefront_address text, dist_id text, block_time timestamptz
);
CREATE TABLE public.allday_pack_sales_history (LIKE public.topshot_pack_sales_history);
CREATE TABLE public.pack_rips (
  id uuid DEFAULT gen_random_uuid(), collection_id uuid, pack_nft_id text, opener_address text,
  moments_pulled int, sealed_at timestamptz, dist_id text, pull_value_usd numeric
);
CREATE TABLE public.pack_distributions (
  collection_id uuid, dist_id text, title text, image_url text, metadata jsonb,
  total_sealed int, total_opened int
);
CREATE TABLE public.pack_ask_state (
  collection_slug text, dist_id text, lowest_ask numeric, is_listed boolean, last_checked_at timestamptz
);
-- 2026-09-25: the body skips the MV's could-not-price sentinel (gross_ev = 0 AND
-- edition_count = 0) and rows under 25% FMV coverage; the defaults describe a
-- normally-priced row so the fixtures below keep their meaning.
CREATE TABLE public.mv_pack_ev_latest (collection_id uuid, dist_id text, pack_ev numeric, snapshotted_at timestamptz,
  gross_ev numeric DEFAULT 31.2, edition_count int DEFAULT 10, fmv_coverage_pct numeric DEFAULT 100);
CREATE TABLE public.pack_nft_identity (
  collection_id uuid, pack_nft_id text, dist_id text, status text, owner_address text, checked_at timestamptz DEFAULT now(),
  acquired_at timestamptz,
  PRIMARY KEY (collection_id, pack_nft_id)
);
CREATE TABLE public.pack_wallet_sync (wallet text PRIMARY KEY, requested_at timestamptz, completed_at timestamptz, pages int, packs int, last_error text, last_clean_sync_at timestamptz);
-- v8 (2026-09-26)
CREATE TABLE public.golazos_pack_sales_history (LIKE public.topshot_pack_sales_history);
CREATE TABLE public.golazos_pack_opens (pack_nft_id text, dist_id text, opener_address text, opened_at timestamptz, moments_pulled int, pull_value_usd numeric);
CREATE TABLE public.pinnacle_pack_opens (LIKE public.golazos_pack_opens);
CREATE TABLE public.wallet_reconstructed_rips (wallet text, collection_id uuid, burst_id text, opened_at timestamptz,
  moments_pulled int, nft_ids text[] DEFAULT '{}', n_resolved int, n_priced int, pull_value_usd numeric(14,2));
CREATE TABLE public.pack_open_pull_values (
  collection_id uuid, pack_nft_id text, opener_address text, n_pulls int, n_resolved int, n_priced int,
  pull_value_usd numeric(14,2), priced_at timestamptz DEFAULT now(), PRIMARY KEY (collection_id, pack_nft_id));

-- >>> BEGIN verbatim get_wallet_pack_history (body byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.get_wallet_pack_history(p_wallet text, p_collection_slug text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '20s'
AS $function$
DECLARE
  v_wallet text := lower(coalesce(p_wallet, ''));
  v_safe_limit  int := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_safe_offset int := GREATEST(COALESCE(p_offset, 0), 0);
  v_ts uuid;
  v_ad uuid;
  v_gz uuid;
  v_pin uuid;
  v_total int;
  v_packs jsonb;
  v_sync jsonb;
  -- Start of this wallet's most recent CLEAN full walk
  -- (pack_wallet_sync.last_clean_sync_at). Every pack that walk returned was
  -- stamped checked_at = now() as it was collected, i.e. at or after this
  -- instant -- so a row still naming this wallet with an OLDER checked_at is a
  -- pack the walk no longer found here: one the wallet has parted with.
  -- NULL when no clean walk has ever finished (never synced, one in flight,
  -- errored, or the 60-page cap hit). The guards below then trust the index
  -- as-is, because suppressing on a PARTIAL walk would read every page it
  -- never reached as a mass departure -- the same defect pointing the other way.
  v_sync_floor timestamptz;
BEGIN
  IF v_wallet = '' THEN
    RETURN jsonb_build_object('error', 'wallet required');
  END IF;

  SELECT id INTO v_ts FROM public.collections WHERE slug = 'nba_top_shot';
  SELECT id INTO v_ad FROM public.collections WHERE slug = 'nfl_all_day';
  SELECT id INTO v_gz FROM public.collections WHERE slug = 'laliga_golazos';
  SELECT id INTO v_pin FROM public.collections WHERE slug = 'disney_pinnacle';

  SELECT jsonb_build_object('requested_at', s.requested_at, 'completed_at', s.completed_at,
                            'pages', s.pages, 'packs', s.packs, 'last_error', s.last_error,
                            'last_clean_sync_at', s.last_clean_sync_at),
         s.last_clean_sync_at
    INTO v_sync, v_sync_floor
    FROM public.pack_wallet_sync s WHERE s.wallet = v_wallet;

  WITH buy_src AS (
    -- (1) on-chain, via pack-events-ingest: secondary ListingCompleted rows AND
    --     primary Withdraw/Mint rows (sale_price NULL on chain -> priced at retail below)
    SELECT pack_nft_id, collection_id, sale_price AS price, sale_currency AS currency,
           sealed_at AS at, seller_address AS counterparty, is_primary_drop, event_kind,
           pack_dist_id AS dist_id, 'onchain'::text AS src, 1 AS pri
    FROM public.pack_purchases WHERE buyer_address = v_wallet
    UNION ALL
    -- (2) Dapper marketplace history (Atlas walker). Buyer-side rows. USD.
    SELECT pack_nft_id, v_ts, sale_price_usd, 'USD', block_time, storefront_address, false,
           'secondary_sale', dist_id, 'marketplace', 2
    FROM public.topshot_pack_sales_history WHERE buyer_address = v_wallet AND purchased
    UNION ALL
    SELECT pack_nft_id, v_ad, sale_price_usd, 'USD', block_time, storefront_address, false,
           'secondary_sale', dist_id, 'marketplace', 2
    FROM public.allday_pack_sales_history WHERE buyer_address = v_wallet AND purchased
    UNION ALL
    -- 2026-09-26: Golazos marketplace history (same walker shape, same meaning).
    SELECT pack_nft_id, v_gz, sale_price_usd, 'USD', block_time, storefront_address, false,
           'secondary_sale', dist_id, 'marketplace', 2
    FROM public.golazos_pack_sales_history WHERE buyer_address = v_wallet AND purchased
  ),
  -- One buy per pack. The same purchase is often in BOTH sources with DIFFERENT
  -- timestamps: the marketplace row carries the sale moment, the on-chain row
  -- the settlement, which lands later by a median 4 h and a p90 of 9 DAYS
  -- (31,995 matched Top Shot pairs, Jun-Aug 2026). So rows within 30 days of
  -- the pack's latest buy row are ONE purchase: price/counterparty come from
  -- its latest row (on-chain on a tie), bought_at is the EARLIEST of them --
  -- otherwise a quick flip whose on-chain settlement post-dates the resale
  -- reads as "bought back" and renders HELD.
  buy_ranked AS (
    SELECT b.*, MAX(at) OVER (PARTITION BY collection_id, pack_nft_id) AS max_at
    FROM buy_src b
  ),
  latest_buys AS (
    SELECT DISTINCT ON (collection_id, pack_nft_id)
           pack_nft_id, collection_id, price AS buy_price, currency AS buy_currency,
           MIN(at) FILTER (WHERE at >= max_at - interval '30 days')
             OVER (PARTITION BY collection_id, pack_nft_id) AS bought_at,
           counterparty AS bought_from, is_primary_drop AS bought_primary,
           event_kind AS bought_event_kind, src AS buy_src
    FROM buy_ranked
    ORDER BY collection_id, pack_nft_id, at DESC, pri
  ),
  buy_dist AS (
    SELECT collection_id, pack_nft_id, MAX(dist_id) AS dist_id
    FROM buy_src WHERE dist_id IS NOT NULL GROUP BY 1, 2
  ),
  sell_src AS (
    -- (1) on-chain rows whose seller IS this wallet: rows the worker ingests
    --     after its Withdraw.from fix, plus the 68,889 historical rows the
    --     2026-09-18 backfill re-attributed from the marketplace tables.
    SELECT pack_nft_id, collection_id, sale_price AS price, sale_currency AS currency,
           sealed_at AS at, buyer_address AS counterparty, pack_dist_id AS dist_id,
           'onchain'::text AS src, 1 AS pri
    FROM public.pack_purchases WHERE seller_address = v_wallet
    UNION ALL
    -- (2) marketplace history: storefront_address is the SELLING wallet.
    SELECT pack_nft_id, v_ts, sale_price_usd, 'USD', block_time, buyer_address, dist_id, 'marketplace', 2
    FROM public.topshot_pack_sales_history WHERE storefront_address = v_wallet AND purchased
    UNION ALL
    SELECT pack_nft_id, v_ad, sale_price_usd, 'USD', block_time, buyer_address, dist_id, 'marketplace', 2
    FROM public.allday_pack_sales_history WHERE storefront_address = v_wallet AND purchased
    UNION ALL
    SELECT pack_nft_id, v_gz, sale_price_usd, 'USD', block_time, buyer_address, dist_id, 'marketplace', 2
    FROM public.golazos_pack_sales_history WHERE storefront_address = v_wallet AND purchased
  ),
  latest_sells AS (
    SELECT DISTINCT ON (collection_id, pack_nft_id)
           pack_nft_id, collection_id, price AS sell_price, currency AS sell_currency,
           at AS sold_at, counterparty AS sold_to, src AS sell_src
    FROM sell_src
    ORDER BY collection_id, pack_nft_id, at DESC, pri
  ),
  sell_dist AS (
    SELECT collection_id, pack_nft_id, MAX(dist_id) AS dist_id
    FROM sell_src WHERE dist_id IS NOT NULL GROUP BY 1, 2
  ),
  wallet_rips AS (
    SELECT id, pack_nft_id, collection_id, sealed_at, moments_pulled, dist_id, pull_value_usd,
           'rip'::text AS rip_source, NULL::int AS rc_pulls, NULL::int AS rc_resolved, NULL::int AS rc_priced
    FROM public.pack_rips WHERE opener_address = v_wallet
    UNION ALL
    -- 2026-09-26: Golazos and Pinnacle opens live in their own tables (pack_rips
    -- holds neither -- 0 rows each), so the Opened tab never listed them.
    SELECT NULL::uuid, pack_nft_id, v_gz, opened_at, moments_pulled, dist_id, pull_value_usd,
           'rip', NULL, NULL, NULL
    FROM public.golazos_pack_opens WHERE opener_address = v_wallet
    UNION ALL
    SELECT NULL::uuid, pack_nft_id, v_pin, opened_at, moments_pulled, dist_id, pull_value_usd,
           'rip', NULL, NULL, NULL
    FROM public.pinnacle_pack_opens WHERE opener_address = v_wallet
    UNION ALL
    -- 2026-09-26 (v9): packs opened with NO pack NFT (custodial Top Shot packs),
    -- reconstructed from the wallet's pack-pull delivery bursts
    -- (wallet_reconstructed_rips). No dist, no price paid; rip_source says so.
    SELECT NULL::uuid, burst_id, collection_id, opened_at, moments_pulled, NULL::text, pull_value_usd,
           'reconstructed', moments_pulled, n_resolved, n_priced
    FROM public.wallet_reconstructed_rips WHERE wallet = v_wallet
  ),
  -- (3) Dapper's index of what the wallet HOLDS or OPENED (pack_nft_identity,
  --     filled by the pack-nft-identity lane's wallet sync): the packs our
  --     buy/rip tables never saw -- reward packs, boxes and drops from before
  --     on-chain coverage. Ranked below every sale and rip we hold.
  index_holds AS (
    SELECT pack_nft_id, collection_id, acquired_at AS at,  -- 2026-09-24: never the CHECK time (see header)
           CASE WHEN status = 'Opened' THEN 'idx_open' ELSE 'idx_hold' END AS role
    FROM public.pack_nft_identity
    WHERE owner_address = v_wallet AND status IN ('Sealed', 'Opened')
      -- ... and this wallet's own last clean walk still found it here. Without
      -- this arm a pack that LEFT keeps owner_address = this wallet for ever --
      -- pack_nft_identity_queue only ever enqueues a pack carrying a purchase or
      -- a rip row, so an OPENED pack that leaves is re-checked through its new
      -- owner's purchase while a SEALED one that leaves by transfer has no
      -- re-check path at all -- and the reader publishes it to the user as an
      -- unopened pack they still own. Measured 2026-09-20 across the 27 saved
      -- wallets: 23 such rows on 5 wallets, and 23 of 23 were Sealed.
      AND (v_sync_floor IS NULL OR checked_at >= v_sync_floor)
  ),
  events AS (
    SELECT collection_id, pack_nft_id, bought_at AS event_at, 'buy'::text AS role FROM latest_buys
    UNION ALL
    SELECT collection_id, pack_nft_id, sold_at, 'sell' FROM latest_sells
    UNION ALL
    SELECT collection_id, pack_nft_id, sealed_at, 'rip' FROM wallet_rips
    UNION ALL
    SELECT collection_id, pack_nft_id, at, role FROM index_holds
  ),
  dedup AS (
    SELECT collection_id, pack_nft_id,
      MAX(event_at)              AS latest_event_at,
      MIN(event_at)              AS first_event_at,
      bool_or(role = 'buy')      AS has_buy,
      bool_or(role = 'sell')     AS has_sell,
      bool_or(role = 'rip')      AS has_rip,
      bool_or(role = 'idx_hold') AS has_idx_hold,
      bool_or(role = 'idx_open') AS has_idx_open
    FROM events GROUP BY 1, 2
  ),
  resolved AS (
    SELECT
      d.*,
      c.slug AS collection_slug, c.name AS collection_name,
      lb.buy_price, lb.buy_currency, lb.bought_at, lb.bought_from, lb.bought_primary,
      lb.bought_event_kind, lb.buy_src,
      ls.sell_price, ls.sell_currency, ls.sold_at, ls.sold_to, ls.sell_src,
      wr.id AS rip_id, wr.sealed_at AS ripped_at,
      -- 2026-09-26: what the pack yielded, from Dapper's own list of its moments
      -- (pack_open_pull_values, the wallet-pack-pulls lane) first; the rip
      -- record's value only where that list has not been priced. Both are
      -- current FMV, whole-pack, NULL -- never 0 -- when any pull is unpriced.
      COALESCE(wr.moments_pulled, pov.n_pulls) AS moments_pulled,
      COALESCE(pov.pull_value_usd, wr.pull_value_usd) AS pull_value_usd,
      CASE WHEN pov.pull_value_usd IS NOT NULL THEN 'dapper_pulls'
           WHEN wr.pull_value_usd IS NOT NULL AND wr.rip_source = 'reconstructed' THEN 'delivery_burst'
           WHEN wr.pull_value_usd IS NOT NULL THEN 'rip_record'
      END AS pull_value_source,
      COALESCE(pov.n_pulls,    wr.rc_pulls)    AS pulls_total,
      COALESCE(pov.n_resolved, wr.rc_resolved) AS pulls_identified,
      COALESCE(pov.n_priced,   wr.rc_priced)   AS pulls_priced,
      wr.rip_source,
      -- Dapper's own index of the pack (pack_nft_identity, filled by the
      -- pack-nft-identity lane): current owner + Sealed/Opened, as of checked_at.
      -- TRUE when the index still names this wallet but the wallet's last clean
      -- walk did not return the pack: it has left. NULL when we cannot tell --
      -- no identity row, or no clean walk to measure against -- so every arm
      -- below reads it through coalesce(..., false) and never lets "unknown"
      -- decide anything.
      CASE WHEN pi.pack_nft_id IS NULL OR v_sync_floor IS NULL THEN NULL
           ELSE (pi.owner_address = v_wallet AND pi.checked_at < v_sync_floor)
      END AS index_departed,
      -- Once it has left, the index's owner_address is a name we KNOW to be
      -- wrong, so this says unknown rather than repeating it back.
      CASE WHEN v_sync_floor IS NOT NULL AND pi.owner_address = v_wallet
                AND pi.checked_at < v_sync_floor THEN NULL
           ELSE pi.owner_address
      END AS current_owner,
      pi.status        AS identity_status,
      pi.checked_at    AS identity_checked_at,
      -- distribution: rip > the wallet's own rows > any marketplace row > the index
      COALESCE(wr.dist_id, bd.dist_id, sd.dist_id, hx.dist_id, NULLIF(pi.dist_id, '0')) AS dist_id,
      CASE
        WHEN wr.dist_id IS NOT NULL THEN 'rip'
        WHEN bd.dist_id IS NOT NULL OR sd.dist_id IS NOT NULL THEN 'own_row'
        WHEN hx.dist_id IS NOT NULL THEN 'peer_sale'
        WHEN NULLIF(pi.dist_id, '0') IS NOT NULL THEN 'dapper_index'
        ELSE NULL
      END AS dist_source
    FROM dedup d
    JOIN public.collections c ON c.id = d.collection_id
    LEFT JOIN latest_buys  lb ON lb.collection_id = d.collection_id AND lb.pack_nft_id = d.pack_nft_id
    LEFT JOIN latest_sells ls ON ls.collection_id = d.collection_id AND ls.pack_nft_id = d.pack_nft_id
    LEFT JOIN wallet_rips  wr ON wr.collection_id = d.collection_id AND wr.pack_nft_id = d.pack_nft_id
    LEFT JOIN buy_dist     bd ON bd.collection_id = d.collection_id AND bd.pack_nft_id = d.pack_nft_id
    LEFT JOIN sell_dist    sd ON sd.collection_id = d.collection_id AND sd.pack_nft_id = d.pack_nft_id
    LEFT JOIN public.pack_nft_identity pi ON pi.collection_id = d.collection_id AND pi.pack_nft_id = d.pack_nft_id
    LEFT JOIN public.pack_open_pull_values pov
      ON pov.collection_id = d.collection_id AND pov.pack_nft_id = d.pack_nft_id AND pov.opener_address = v_wallet
    LEFT JOIN LATERAL (
      SELECT h.dist_id FROM public.topshot_pack_sales_history h
      WHERE d.collection_id = v_ts
        AND wr.dist_id IS NULL AND bd.dist_id IS NULL AND sd.dist_id IS NULL
        AND h.pack_nft_id = d.pack_nft_id AND h.dist_id IS NOT NULL
      UNION ALL
      SELECT h.dist_id FROM public.allday_pack_sales_history h
      WHERE d.collection_id = v_ad
        AND wr.dist_id IS NULL AND bd.dist_id IS NULL AND sd.dist_id IS NULL
        AND h.pack_nft_id = d.pack_nft_id AND h.dist_id IS NOT NULL
      UNION ALL
      SELECT h.dist_id FROM public.golazos_pack_sales_history h
      WHERE d.collection_id = v_gz
        AND wr.dist_id IS NULL AND bd.dist_id IS NULL AND sd.dist_id IS NULL
        AND h.pack_nft_id = d.pack_nft_id AND h.dist_id IS NOT NULL
      LIMIT 1
    ) hx ON true
  ),
  enriched AS (
    SELECT
      r.*,
      COALESCE(pd.title, CASE WHEN r.rip_source = 'reconstructed'
                              THEN r.collection_name || ' pack (no pack NFT, reconstructed)' END) AS pack_name,
      pd.image_url          AS pack_image,
      pd.metadata->>'tier'  AS pack_tier,
      pd.total_sealed       AS dist_total_sealed,
      pd.total_opened       AS dist_total_opened,
      (pd.metadata->>'retail_price_usd')::numeric AS retail_usd,
      -- what the wallet PAID: on-chain/marketplace price for a secondary buy,
      -- the distribution's retail price for a primary drop, NULL when unknown.
      CASE WHEN r.bought_primary THEN (pd.metadata->>'retail_price_usd')::numeric
           ELSE r.buy_price END AS buy_usd,
      CASE
        WHEN NOT r.has_buy THEN NULL
        WHEN r.bought_primary AND (pd.metadata->>'retail_price_usd') IS NOT NULL THEN 'retail'
        WHEN r.bought_primary THEN NULL
        WHEN r.buy_price IS NULL THEN NULL
        ELSE r.buy_src
      END AS buy_price_source
    FROM resolved r
    LEFT JOIN public.pack_distributions pd
      ON pd.dist_id = r.dist_id AND pd.collection_id = r.collection_id
  ),
  classified AS (
    SELECT *,
      CASE
        WHEN has_rip                                            THEN 'ripped'
        WHEN has_sell AND has_buy AND sold_at >= bought_at      THEN 'flipped'
        WHEN has_sell AND NOT has_buy                           THEN 'sold'
        -- bought, never sold or opened by this wallet, and Dapper's index says a
        -- DIFFERENT wallet holds it now: it left by transfer, or by a sale the
        -- marketplace walker has not reached. Never HELD.
        -- ... or the index no longer places it here at all. Same outcome, we
        -- just cannot name who holds it now -- and this arm is the only one that
        -- can catch it, because a stale row still says the owner IS us, which
        -- made the test above pass it straight through to HELD.
        WHEN has_buy AND ((current_owner IS NOT NULL AND current_owner <> v_wallet)
                          OR coalesce(index_departed, false))
                                                                THEN 'transferred'
        WHEN has_buy                                            THEN 'held'
        -- the index alone: opened by this wallet (no rip row of ours) or held
        WHEN has_idx_open                                       THEN 'ripped'
        WHEN has_idx_hold                                       THEN 'held'
        ELSE 'other'
      END AS status
    FROM enriched
  ),
  with_pl AS (
    SELECT *,
      CASE
        WHEN status = 'ripped'  AND pull_value_usd IS NOT NULL AND buy_usd IS NOT NULL THEN pull_value_usd - buy_usd
        WHEN status = 'flipped' AND sell_price     IS NOT NULL AND buy_usd IS NOT NULL THEN sell_price     - buy_usd
        ELSE NULL
      END AS realized_pl_usd
    FROM classified
  ),
  filtered AS (
    SELECT * FROM with_pl
    WHERE (p_collection_slug IS NULL OR collection_slug = p_collection_slug)
      AND (
        p_status IS NULL
        OR p_status = 'all'
        -- virtual status: every "no longer sealed in this wallet, sold on"
        -- outcome, regardless of whether a matching buy was attributable
        OR (p_status = 'sold_any' AND status IN ('flipped', 'sold'))
        OR status = p_status
      )
  ),
  page AS (
    SELECT * FROM filtered
    ORDER BY latest_event_at DESC NULLS LAST, collection_id, pack_nft_id
    LIMIT v_safe_limit OFFSET v_safe_offset
  ),
  -- market context, PAGE rows only: current floor ask, latest EV snapshot, last
  -- recorded secondary sale of the same distribution. All NULL when unknown.
  page_market AS (
    SELECT
      p.*,
      CASE WHEN pas.is_listed THEN pas.lowest_ask END AS lowest_ask_usd,
      pas.last_checked_at                             AS ask_checked_at,
      ev.pack_ev                                      AS pack_ev_usd,
      ev.snapshotted_at                               AS ev_snapshotted_at,
      lsale.sale_price                                AS last_sale_usd,
      lsale.sealed_at                                 AS last_sale_at
    FROM page p
    LEFT JOIN public.pack_ask_state pas
      ON p.dist_id IS NOT NULL
     AND pas.dist_id = p.dist_id
     AND pas.collection_slug = replace(p.collection_slug, '_', '-')
    LEFT JOIN public.mv_pack_ev_latest ev
      ON p.dist_id IS NOT NULL
     AND ev.dist_id = p.dist_id AND ev.collection_id = p.collection_id
     -- 2026-09-24: mirror pack_table_rows' publish gates — the MV's sentinel
     -- (gross_ev = 0 AND edition_count = 0) is "could not price", not "$0".
     AND NOT (ev.gross_ev = 0 AND ev.edition_count = 0)
     AND (ev.fmv_coverage_pct IS NULL OR ev.fmv_coverage_pct >= 25)
    LEFT JOIN LATERAL (
      SELECT pp.sale_price, pp.sealed_at
      FROM public.pack_purchases pp
      WHERE p.dist_id IS NOT NULL
        AND pp.pack_dist_id = p.dist_id
        AND pp.collection_id = p.collection_id
        AND pp.event_kind = 'secondary_sale'
        AND pp.sale_price IS NOT NULL
      ORDER BY pp.sealed_at DESC
      LIMIT 1
    ) lsale ON true
  )
  SELECT
    (SELECT COUNT(*) FROM filtered),
    COALESCE(jsonb_agg(
      jsonb_build_object(
        'pack_nft_id', pack_nft_id, 'collection_id', collection_id,
        'collection_slug', collection_slug, 'collection_name', collection_name,
        'status', status, 'has_buy', has_buy, 'has_sell', has_sell, 'has_rip', has_rip,
        'latest_event_at', latest_event_at, 'first_event_at', first_event_at,
        'pack_name', pack_name, 'pack_image', pack_image, 'pack_tier', pack_tier,
        'dist_id', dist_id, 'dist_source', dist_source,
        'dist_total_sealed', dist_total_sealed, 'dist_total_opened', dist_total_opened,
        'current_owner', current_owner, 'identity_status', identity_status,
        'identity_checked_at', identity_checked_at,
        -- Provenance for the two fields above. true = the index still names this
        -- wallet but its last clean walk did not return the pack, so
        -- identity_status is a LAST-SEEN and not a now; false = that walk
        -- confirmed it; null = no identity row, or no clean walk to judge by.
        'identity_departed', index_departed,
        'rip_id', rip_id, 'ripped_at', ripped_at,
        -- 'rip' (an open event we hold) | 'reconstructed' (a pack opened with no
        -- pack NFT, rebuilt from its moment deliveries) | NULL (not opened here)
        'rip_source', rip_source,
        'moments_pulled', moments_pulled,
        'pull_value_usd', CASE WHEN pull_value_usd IS NULL THEN NULL ELSE ROUND(pull_value_usd::numeric, 2) END,
        -- 'dapper_pulls' | 'rip_record' | NULL; and, when Dapper's list is held,
        -- how many of the pack's moments are identified / priced (so a NULL
        -- value can say "3 of 4 priced" instead of nothing).
        'pull_value_source', pull_value_source,
        'pulls_total', pulls_total, 'pulls_identified', pulls_identified, 'pulls_priced', pulls_priced,
        'buy_price', CASE WHEN buy_price IS NULL THEN NULL ELSE ROUND(buy_price::numeric, 2) END,
        'buy_usd',   CASE WHEN buy_usd   IS NULL THEN NULL ELSE ROUND(buy_usd::numeric, 2) END,
        'buy_price_source', buy_price_source,
        'buy_currency', buy_currency, 'bought_at', bought_at, 'bought_from', bought_from,
        'bought_primary', bought_primary,
        'event_kind', bought_event_kind,
        'sell_price', CASE WHEN sell_price IS NULL THEN NULL ELSE ROUND(sell_price::numeric, 2) END,
        'sell_source', sell_src,
        'sell_currency', sell_currency, 'sold_at', sold_at, 'sold_to', sold_to,
        'realized_pl_usd', CASE WHEN realized_pl_usd IS NULL THEN NULL ELSE ROUND(realized_pl_usd::numeric, 2) END,
        'lowest_ask_usd', CASE WHEN lowest_ask_usd IS NULL THEN NULL ELSE ROUND(lowest_ask_usd::numeric, 2) END,
        'ask_checked_at', ask_checked_at,
        'pack_ev_usd', CASE WHEN pack_ev_usd IS NULL THEN NULL ELSE ROUND(pack_ev_usd::numeric, 2) END,
        'ev_snapshotted_at', ev_snapshotted_at,
        'last_sale_usd', CASE WHEN last_sale_usd IS NULL THEN NULL ELSE ROUND(last_sale_usd::numeric, 2) END,
        'last_sale_at', last_sale_at
      ) ORDER BY latest_event_at DESC NULLS LAST, collection_id, pack_nft_id
    ), '[]'::jsonb)
  INTO v_total, v_packs
  FROM page_market;

  RETURN jsonb_build_object(
    'wallet', v_wallet,
    'collection_slug', p_collection_slug,
    'status_filter', p_status,
    'limit', v_safe_limit,
    'offset', v_safe_offset,
    'total_count', v_total,
    'packs', v_packs,
    'identity_sync', v_sync,
    'coverage', jsonb_build_object(
      'onchain', 'pack_purchases: Top Shot + All Day, block-indexed from 2026-04; primary drops carry no price on chain',
      'opens', 'pack_rips (Top Shot, All Day) + golazos_pack_opens + pinnacle_pack_opens',
      'reconstructed', 'wallet_reconstructed_rips: Top Shot packs opened with NO pack NFT (custodial packs, 2021 on), rebuilt from the wallet''s pack-pull moment deliveries (a gap > 3 s starts a new reveal; 114 of 115 bursts overlapping a known pack matched its moment list exactly). rip_source = reconstructed; no distribution, no price paid; covers deliveries seeded into moment_acquisitions (through 2026-03)',
      'pulls', 'pack_open_pull_values: every pack this wallet opened, priced from the moments Dapper''s searchPackNft.nfts says it yielded (current FMV, whole-pack: NULL unless every moment is priced; pulls_priced / pulls_total say how close). Refreshed by the wallet-pack-pulls lane; pull_value_source = rip_record where only the rip row''s value is held',
      'marketplace', 'topshot_pack_sales_history / allday_pack_sales_history / golazos_pack_sales_history: Dapper marketplace secondary sales (seller = storefront_address), Top Shot from 2023-09, All Day from 2022-12; ingest is bursty and can lag days',
      'identity', 'pack_nft_identity: Dapper searchPackNft index (dist_id, Sealed/Opened, current owner, acquired_at) filled by the pack-nft-identity lane and the per-wallet sync; identity_sync says when this wallet''s holdings were last confirmed (NULL completed_at = not yet, the list is what we hold so far). An ownership claim is trusted only at or after identity_sync.last_clean_sync_at, the start of the last clean full walk: a row older than that names a pack the wallet no longer holds, is excluded from the held/ripped counts, and carries identity_departed = true'
    ),
    'computed_at', now()
  );
END;
$function$;
-- <<< END verbatim get_wallet_pack_history <<<

INSERT INTO public.collections VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'nba_top_shot', 'NBA Top Shot'),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'nfl_all_day', 'NFL All Day'),
  ('06248cc4-b85f-47cd-af67-1855d14acd75', 'laliga_golazos', 'LaLiga Golazos'),
  ('7dd9dd11-e8b6-45c4-ac99-71331f959714', 'disney_pinnacle', 'Disney Pinnacle');

INSERT INTO public.pack_distributions VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'D1', 'Fresh Threads Pack', 'https://img/d1.png', '{"retail_price_usd":"10"}', 100, 40),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'D2', 'Quest Reward Pack', 'https://img/d2.png', '{"retail_price_usd":"0"}', 50, 10),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'D3', 'Mystery Pack', NULL, '{}', 10, 1);

-- W bought P1 on chain (primary drop, no price, no dist), never opened it.
-- Another wallet later BOUGHT P1 on the marketplace FROM W (storefront = W): SOLD.
INSERT INTO public.pack_purchases (collection_id, pack_nft_id, buyer_address, seller_address, sale_price, sealed_at, is_primary_drop, event_kind)
VALUES ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'P1', '0xwallet', '0x0b2a3299cc857e29', NULL, '2026-05-01', true, 'primary_withdraw');
INSERT INTO public.topshot_pack_sales_history VALUES
  ('tx-p1', 'P1', 25, true, '0xother', '0xwallet', 'D1', '2026-06-01');
-- P2: sold by W on the marketplace with NO buy anywhere (pre-coverage primary drop).
INSERT INTO public.topshot_pack_sales_history VALUES
  ('tx-p2', 'P2', 40, true, '0xother', '0xwallet', 'D1', '2024-03-01');
-- P3: on-chain primary drop, sealed, no rip, no marketplace row -> dist unknown.
INSERT INTO public.pack_purchases (collection_id, pack_nft_id, buyer_address, seller_address, sale_price, sealed_at, is_primary_drop, event_kind)
VALUES ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'P3', '0xwallet', '0x0b2a3299cc857e29', NULL, '2026-07-01', true, 'primary_withdraw');
-- P4: sealed primary drop, dist knowable ONLY from a THIRD-PARTY marketplace row
-- (someone else sold that pack before W acquired it on chain).
INSERT INTO public.pack_purchases (collection_id, pack_nft_id, buyer_address, seller_address, sale_price, sealed_at, is_primary_drop, event_kind)
VALUES ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'P4', '0xwallet', '0x0b2a3299cc857e29', NULL, '2026-07-02', true, 'primary_withdraw');
INSERT INTO public.topshot_pack_sales_history VALUES
  ('tx-p4', 'P4', 12, true, '0xsomeone', '0xelse', 'D2', '2026-01-01');
-- P5: bought on the marketplace in 2024 (pre on-chain coverage), ripped; the rip
-- carries no pull value -> pull_value_usd and realized P&L must be NULL, not 0.
INSERT INTO public.topshot_pack_sales_history VALUES
  ('tx-p5', 'P5', 30, true, '0xwallet', '0xseller', 'D1', '2024-05-01');
INSERT INTO public.pack_rips (collection_id, pack_nft_id, opener_address, moments_pulled, sealed_at, dist_id, pull_value_usd)
VALUES ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'P5', '0xwallet', 3, '2024-05-02', 'D1', NULL);
-- P6: the same secondary purchase seen by BOTH sources (same second) -> one row.
INSERT INTO public.pack_purchases (collection_id, pack_nft_id, buyer_address, seller_address, sale_price, sale_currency, sealed_at, is_primary_drop, event_kind)
VALUES ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'P6', '0xwallet', '0x18eb4ee6b3c026d2', 8, 'DUC', '2026-08-01 10:00:00', false, 'secondary_sale');
INSERT INTO public.topshot_pack_sales_history VALUES
  ('tx-p6', 'P6', 8, true, '0xwallet', '0xseller', 'D3', '2026-08-01 10:00:00');
-- P7: sold on the marketplace, then bought back later on chain -> HELD, not FLIPPED.
INSERT INTO public.topshot_pack_sales_history VALUES
  ('tx-p7', 'P7', 5, true, '0xother', '0xwallet', 'D1', '2026-03-01');
INSERT INTO public.pack_purchases (collection_id, pack_nft_id, buyer_address, seller_address, sale_price, sale_currency, sealed_at, is_primary_drop, event_kind)
VALUES ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'P7', '0xwallet', '0x18eb4ee6b3c026d2', 6, 'DUC', '2026-08-15', false, 'secondary_sale');
-- P10: the settlement-lag flip. Bought on the marketplace 06-01, resold 06-05,
-- and the on-chain record of the BUY settles 06-10 (lag p90 = 9 days). The two
-- buy rows are one purchase; bought_at is the earliest -> FLIPPED, not held.
INSERT INTO public.topshot_pack_sales_history VALUES
  ('tx-p10a', 'P10', 20, true, '0xwallet', '0xseller', 'D1', '2026-06-01'),
  ('tx-p10b', 'P10', 28, true, '0xother',  '0xwallet', 'D1', '2026-06-05');
INSERT INTO public.pack_purchases (collection_id, pack_nft_id, buyer_address, seller_address, sale_price, sale_currency, sealed_at, is_primary_drop, event_kind)
VALUES ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'P10', '0xwallet', '0x18eb4ee6b3c026d2', 20, 'DUC', '2026-06-10', false, 'secondary_sale');
-- P11: bought on chain, never sold or ripped here, and Dapper's index says a
-- DIFFERENT wallet holds it now (opened by them) -> TRANSFERRED, never HELD.
INSERT INTO public.pack_purchases (collection_id, pack_nft_id, buyer_address, seller_address, sale_price, sealed_at, is_primary_drop, event_kind)
VALUES ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'P11', '0xwallet', '0x0b2a3299cc857e29', NULL, '2026-05-28', true, 'primary_withdraw');
INSERT INTO public.pack_nft_identity VALUES ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'P11', 'D1', 'Opened', '0xc5ababe825dc3122', '2026-09-18');
-- P12: sealed primary drop, still this wallet's per the index, dist known ONLY
-- from the index -> held, named, dist_source dapper_index.
INSERT INTO public.pack_purchases (collection_id, pack_nft_id, buyer_address, seller_address, sale_price, sealed_at, is_primary_drop, event_kind)
VALUES ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'P12', '0xwallet', '0x0b2a3299cc857e29', NULL, '2026-07-03', true, 'primary_withdraw');
INSERT INTO public.pack_nft_identity VALUES ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'P12', 'D2', 'Sealed', '0xwallet', '2026-09-18');
-- P13: like P12 but the index only knows dist "0" (uncatalogued) -> stays NULL.
INSERT INTO public.pack_purchases (collection_id, pack_nft_id, buyer_address, seller_address, sale_price, sealed_at, is_primary_drop, event_kind)
VALUES ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'P13', '0xwallet', '0x0b2a3299cc857e29', NULL, '2026-07-04', true, 'primary_withdraw');
INSERT INTO public.pack_nft_identity VALUES ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'P13', '0', 'Sealed', '0xwallet', '2026-09-18');
-- P14: index-only: the wallet HOLDS it (Sealed), we have no buy/sell/rip -> held,
-- named from the index, buy NULL (never 0), latest_event_at = acquired_at.
INSERT INTO public.pack_nft_identity VALUES ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'P14', 'D1', 'Sealed', '0xwallet', '2026-09-18', '2024-11-05');
-- P15: index-only: OPENED by the wallet, no rip row of ours -> ripped, pull NULL.
INSERT INTO public.pack_nft_identity VALUES ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'P15', 'D2', 'Opened', '0xwallet', '2026-09-18', '2025-02-01');
-- P16: STALE identity (says the wallet still holds it) but we hold a marketplace
-- SALE by the wallet -> the sale wins: sold, not held.
INSERT INTO public.pack_nft_identity VALUES ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'P16', 'D1', 'Sealed', '0xwallet', '2026-09-01', '2025-03-01');
INSERT INTO public.topshot_pack_sales_history VALUES
  ('tx-p16', 'P16', 22, true, '0xother', '0xwallet', 'D1', '2026-09-10');
-- The wallet's last CLEAN walk started 2026-09-18 00:00, so every identity row
-- above with checked_at >= that instant (P12..P15) is CONFIRMED and keeps its
-- v5/v6 verdict unchanged. P16's row is older -- it is genuinely stale, as its
-- own comment says -- and is now flagged as such, though the sale still wins.
INSERT INTO public.pack_wallet_sync VALUES ('0xwallet', '2026-09-18 00:00', '2026-09-18 00:05', 4, 375, NULL, '2026-09-18 00:00');
-- P17: index-only SEALED, still naming this wallet, but the clean walk did not
-- return it -> the wallet has parted with it. It must leave the list entirely:
-- before v7 this was a phantom UNOPENED PACK in the user's own inventory, and
-- it is the exact shape of all 23 rows measured in production.
INSERT INTO public.pack_nft_identity VALUES ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'P17', 'D1', 'Sealed', '0xwallet', '2026-09-01', '2025-06-01');
-- P18: the same departure, but this one we BOUGHT. The v5 'transferred' arm
-- could not catch it -- that arm tests current_owner <> wallet, and a stale row
-- still says the owner IS us -- so it fell through to HELD. Now transferred,
-- with current_owner NULL because we cannot name who holds it instead.
INSERT INTO public.pack_purchases (collection_id, pack_nft_id, buyer_address, seller_address, sale_price, sale_currency, sealed_at, is_primary_drop, event_kind, pack_dist_id)
VALUES ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'P18', '0xwallet', '0xother', 12, 'DUC', '2026-08-01', false, 'secondary_sale', 'D1');
INSERT INTO public.pack_nft_identity VALUES ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'P18', 'D1', 'Sealed', '0xwallet', '2026-09-01', '2026-08-01');
-- P19: THE NO-CHANGE CONTROL, and the arm the fix must NOT be able to move.
-- Same stale shape as P17 -- Sealed, owner = the wallet, checked_at long before
-- anything -- but on a wallet with NO pack_wallet_sync row at all, so there is
-- no clean walk to judge by. It must still read HELD. A guard that suppressed
-- here would turn "we have not looked yet" into "you no longer own it", which
-- is the same lie in the other direction, and is what a partial or in-flight
-- walk looks like from inside the reader.
INSERT INTO public.pack_nft_identity VALUES ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'P19', 'D1', 'Sealed', '0xnosync', '2026-09-01', '2025-06-01');
-- A cancelled listing (purchased=false) must count as nothing.
INSERT INTO public.topshot_pack_sales_history VALUES
  ('tx-p8', 'P8', 99, false, '0xother', '0xwallet', 'D1', '2026-08-20');
-- Market context for D1 on the page rows.
INSERT INTO public.pack_ask_state VALUES ('nba-top-shot', 'D1', 22.5, true, '2026-09-18');
INSERT INTO public.mv_pack_ev_latest VALUES ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'D1', 31.2, '2026-09-18');
INSERT INTO public.pack_purchases (collection_id, pack_nft_id, buyer_address, seller_address, sale_price, sale_currency, sealed_at, is_primary_drop, event_kind, pack_dist_id)
VALUES ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'P9', '0xa', '0x18eb4ee6b3c026d2', 19, 'DUC', '2026-09-10', false, 'secondary_sale', 'D1');

DO $$
DECLARE
  r jsonb;
  row_ jsonb;
  sold jsonb;
BEGIN
  r := public.get_wallet_pack_history('0xWALLET', NULL, NULL, 50, 0);
  -- 15, not 14: P18 joins (bought, then departed -> transferred). P17 does NOT
  -- -- it is index-only and the walk says it is gone, so there is nothing left
  -- to report. P19 belongs to another wallet. RE-PINNED for v7, not inverted:
  -- the premise changed, the claim did not.
  PERFORM _assert_eq(r->>'total_count', '15', 'P1..P7 + P10..P16 + P18 = 15; P8 cancelled, P17 departed index-only');
  PERFORM _assert_eq(r->'identity_sync'->>'packs', '375', 'identity_sync carried from pack_wallet_sync');

  -- 1. sold packs come from the marketplace history
  sold := public.get_wallet_pack_history('0xwallet', 'nba_top_shot', 'sold_any', 50, 0);
  PERFORM _assert_eq(sold->>'total_count', '4', 'sold_any = P1 (flipped) + P2 (sold) + P10 (flipped) + P16 (sold, stale identity)');
  SELECT p INTO row_ FROM jsonb_array_elements(r->'packs') p WHERE p->>'pack_nft_id' = 'P10';
  PERFORM _assert_eq(row_->>'status', 'flipped', 'P10: on-chain settlement AFTER the resale is still one purchase -> flipped');
  PERFORM _assert_eq(row_->>'buy_price_source', 'onchain', 'P10 price from the latest (on-chain) row of the purchase');
  PERFORM _assert_eq(row_->>'bought_at', '2026-06-01T00:00:00+00:00', 'P10 bought_at is the EARLIEST row of the purchase');
  PERFORM _assert_eq(row_->>'realized_pl_usd', '8.00', 'P10 P&L 28 - 20');
  SELECT p INTO row_ FROM jsonb_array_elements(r->'packs') p WHERE p->>'pack_nft_id' = 'P1';
  PERFORM _assert_eq(row_->>'status', 'flipped', 'P1: on-chain buy + marketplace sell = flipped');
  PERFORM _assert_eq(row_->>'sell_price', '25.00', 'P1 sell price from the marketplace row');
  PERFORM _assert_eq(row_->>'sell_source', 'marketplace', 'P1 sell provenance');
  PERFORM _assert_eq(row_->>'sold_to', '0xother', 'P1 buyer is the marketplace buyer');
  PERFORM _assert_eq(row_->>'realized_pl_usd', '15.00', 'P1 P&L = 25 sale - 10 retail (dist from the sale row)');
  PERFORM _assert_eq(row_->>'buy_price_source', 'retail', 'P1 buy priced at retail');
  SELECT p INTO row_ FROM jsonb_array_elements(r->'packs') p WHERE p->>'pack_nft_id' = 'P2';
  PERFORM _assert_eq(row_->>'status', 'sold', 'P2: sale with no attributable buy = sold');
  PERFORM _assert(row_->>'realized_pl_usd' IS NULL, 'P2: no buy leg -> P&L NULL, not the sale price');
  PERFORM _assert_eq(row_->>'pack_name', 'Fresh Threads Pack', 'P2 named from the sale row dist');

  -- 2. unknown prices are NULL, never 0
  SELECT p INTO row_ FROM jsonb_array_elements(r->'packs') p WHERE p->>'pack_nft_id' = 'P3';
  PERFORM _assert_eq(row_->>'status', 'held', 'P3 sealed primary drop = held');
  PERFORM _assert(row_->>'buy_price' IS NULL, 'P3 buy_price NULL (never $0) for an unpriced primary drop');
  PERFORM _assert(row_->>'buy_usd' IS NULL, 'P3 buy_usd NULL when neither price nor retail is known');
  PERFORM _assert(row_->>'buy_price_source' IS NULL, 'P3 buy_price_source NULL');
  PERFORM _assert(row_->>'dist_id' IS NULL AND row_->>'pack_name' IS NULL, 'P3 distribution honestly unknown');
  PERFORM _assert(row_->>'lowest_ask_usd' IS NULL AND row_->>'pack_ev_usd' IS NULL, 'P3 no market data without a dist');
  SELECT p INTO row_ FROM jsonb_array_elements(r->'packs') p WHERE p->>'pack_nft_id' = 'P5';
  PERFORM _assert_eq(row_->>'status', 'ripped', 'P5 ripped');
  PERFORM _assert(row_->>'pull_value_usd' IS NULL, 'P5 unvalued rip -> pull_value_usd NULL, not $0');
  PERFORM _assert(row_->>'realized_pl_usd' IS NULL, 'P5 P&L NULL when the pull value is unknown');
  PERFORM _assert_eq(row_->>'buy_price', '30.00', 'P5 buy price from a 2024 marketplace row the on-chain table cannot see');
  PERFORM _assert_eq(row_->>'buy_price_source', 'marketplace', 'P5 buy provenance');

  -- 3. sealed identity from any marketplace row; market context on resolved rows
  SELECT p INTO row_ FROM jsonb_array_elements(r->'packs') p WHERE p->>'pack_nft_id' = 'P4';
  PERFORM _assert_eq(row_->>'status', 'held', 'P4 still held (third-party sale predates the buy and is not W''s)');
  PERFORM _assert_eq(row_->>'dist_id', 'D2', 'P4 dist from a third-party marketplace row');
  PERFORM _assert_eq(row_->>'dist_source', 'peer_sale', 'P4 dist provenance');
  PERFORM _assert_eq(row_->>'pack_name', 'Quest Reward Pack', 'P4 named');
  PERFORM _assert_eq(row_->>'buy_usd', '0.00', 'P4 retail $0 is a KNOWN zero (reward pack), kept');
  PERFORM _assert_eq(row_->>'buy_price_source', 'retail', 'P4 retail provenance');
  SELECT p INTO row_ FROM jsonb_array_elements(r->'packs') p WHERE p->>'pack_nft_id' = 'P1';
  PERFORM _assert_eq(row_->>'lowest_ask_usd', '22.50', 'D1 floor ask on the page row');
  PERFORM _assert_eq(row_->>'pack_ev_usd', '31.20', 'D1 EV on the page row');
  PERFORM _assert_eq(row_->>'last_sale_usd', '19.00', 'D1 last recorded secondary sale (any wallet)');
  PERFORM _assert_eq(row_->>'dist_total_sealed', '100', 'D1 sealed supply carried');

  -- dedup + time-aware status
  SELECT p INTO row_ FROM jsonb_array_elements(r->'packs') p WHERE p->>'pack_nft_id' = 'P6';
  PERFORM _assert_eq(row_->>'status', 'held', 'P6 one purchase, seen by both sources, one row');
  PERFORM _assert_eq(row_->>'buy_price_source', 'onchain', 'P6 tie -> on-chain row wins');
  PERFORM _assert_eq(row_->>'dist_id', 'D3', 'P6 dist taken from the marketplace copy of the same purchase');
  PERFORM _assert(row_->>'pack_image' IS NULL AND row_->>'pack_name' = 'Mystery Pack', 'P6 name without an image stays honest');
  SELECT p INTO row_ FROM jsonb_array_elements(r->'packs') p WHERE p->>'pack_nft_id' = 'P7';
  PERFORM _assert_eq(row_->>'status', 'held', 'P7 sold then bought back = held');

  -- v5: transferred + the index as a dist source
  SELECT p INTO row_ FROM jsonb_array_elements(r->'packs') p WHERE p->>'pack_nft_id' = 'P11';
  PERFORM _assert_eq(row_->>'status', 'transferred', 'P11: another wallet holds it per the index -> transferred, not held');
  PERFORM _assert_eq(row_->>'current_owner', '0xc5ababe825dc3122', 'P11 current owner carried');
  PERFORM _assert_eq(row_->>'identity_status', 'Opened', 'P11 index status carried');
  PERFORM _assert_eq(row_->>'pack_name', 'Fresh Threads Pack', 'P11 named from the index dist');
  PERFORM _assert(row_->>'realized_pl_usd' IS NULL, 'P11 no P&L: nothing was realised by this wallet');
  SELECT p INTO row_ FROM jsonb_array_elements(r->'packs') p WHERE p->>'pack_nft_id' = 'P12';
  PERFORM _assert_eq(row_->>'status', 'held', 'P12 still this wallet''s per the index -> held');
  PERFORM _assert_eq(row_->>'dist_source', 'dapper_index', 'P12 dist from the index, last in the order');
  PERFORM _assert_eq(row_->>'pack_name', 'Quest Reward Pack', 'P12 named');
  SELECT p INTO row_ FROM jsonb_array_elements(r->'packs') p WHERE p->>'pack_nft_id' = 'P13';
  PERFORM _assert_eq(row_->>'status', 'held', 'P13 held');
  PERFORM _assert(row_->>'dist_id' IS NULL AND row_->>'dist_source' IS NULL, 'P13: the index''s dist "0" is not a distribution');
  -- RE-PINNED for v7: v7 adds a SECOND way to be transferred (P18), so a bare
  -- count of 1 no longer states the v5 property. Assert P11's MEMBERSHIP
  -- instead -- that keeps this arm exercised and immune to later additions,
  -- where a count would just be re-bumped each time and stop meaning anything.
  PERFORM _assert(EXISTS (
    SELECT 1 FROM jsonb_array_elements((public.get_wallet_pack_history('0xwallet', 'nba_top_shot', 'transferred', 50, 0))->'packs') p
     WHERE p->>'pack_nft_id' = 'P11'
  ), 'transferred filter still contains P11 -- the index naming ANOTHER owner is its own route to transferred');
  PERFORM _assert_eq((public.get_wallet_pack_history('0xwallet', 'nba_top_shot', 'sold_any', 50, 0))->>'total_count', '4', 'a transferred pack is NOT a sale; P16 IS');

  -- v6: the index as a holdings source
  SELECT p INTO row_ FROM jsonb_array_elements(r->'packs') p WHERE p->>'pack_nft_id' = 'P14';
  PERFORM _assert_eq(row_->>'status', 'held', 'P14 index-only holding = held');
  PERFORM _assert(row_->>'has_buy' = 'false' AND row_->>'buy_usd' IS NULL AND row_->>'buy_price' IS NULL, 'P14 no buy of ours -> buy NULL, never 0');
  PERFORM _assert_eq(row_->>'pack_name', 'Fresh Threads Pack', 'P14 named from the index');
  PERFORM _assert_eq(row_->>'dist_source', 'dapper_index', 'P14 provenance');
  PERFORM _assert_eq(row_->>'latest_event_at', '2024-11-05T00:00:00+00:00', 'P14 when = the index acquisition time');
  PERFORM _assert(row_->>'realized_pl_usd' IS NULL, 'P14 no P&L');
  SELECT p INTO row_ FROM jsonb_array_elements(r->'packs') p WHERE p->>'pack_nft_id' = 'P15';
  PERFORM _assert_eq(row_->>'status', 'ripped', 'P15 opened per the index, no rip row of ours -> ripped');
  PERFORM _assert(row_->>'has_rip' = 'false' AND row_->>'pull_value_usd' IS NULL AND row_->>'rip_id' IS NULL, 'P15 pull value unknown -> NULL');
  SELECT p INTO row_ FROM jsonb_array_elements(r->'packs') p WHERE p->>'pack_nft_id' = 'P16';
  PERFORM _assert_eq(row_->>'status', 'sold', 'P16 stale identity loses to the sale we hold');

  -- v7: an ownership claim is only as good as the walk that confirmed it
  PERFORM _assert(NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r->'packs') p WHERE p->>'pack_nft_id' = 'P17'),
    'P17: index-only SEALED row the clean walk did not return -> gone from the list, NOT an unopened pack in inventory');
  SELECT p INTO row_ FROM jsonb_array_elements(r->'packs') p WHERE p->>'pack_nft_id' = 'P18';
  PERFORM _assert_eq(row_->>'status', 'transferred', 'P18: bought, then departed per the clean walk -> transferred, never held');
  PERFORM _assert(row_->>'current_owner' IS NULL, 'P18: current_owner NULL -- the index name is known wrong, and we cannot supply the right one');
  PERFORM _assert_eq(row_->>'identity_departed', 'true', 'P18 carries its own provenance');
  PERFORM _assert_eq(row_->>'identity_status', 'Sealed', 'P18 keeps the LAST-SEEN status; identity_departed is what says it is not a now');
  SELECT p INTO row_ FROM jsonb_array_elements(r->'packs') p WHERE p->>'pack_nft_id' = 'P12';
  PERFORM _assert_eq(row_->>'identity_departed', 'false', 'P12 was confirmed by the same walk -- the guard discriminates, it does not blanket-suppress');
  PERFORM _assert_eq(r->'identity_sync'->>'last_clean_sync_at', '2026-09-18T00:00:00+00:00', 'the floor is published, so a reader can see what the claim rests on');
  PERFORM _assert_eq((public.get_wallet_pack_history('0xwallet', 'nba_top_shot', 'transferred', 50, 0))->>'total_count', '2', 'transferred = P11 (index names another wallet) + P18 (index names us, and is stale)');
  PERFORM _assert_eq((public.get_wallet_pack_history('0xwallet', 'nba_top_shot', 'sold_any', 50, 0))->>'total_count', '4', 'a departed pack is still NOT a sale');

  -- ... and the control: no clean walk, no suppression.
  PERFORM _assert_eq((public.get_wallet_pack_history('0xnosync', NULL, 'held', 50, 0))->>'total_count', '1',
    'P19: same stale shape on a wallet with NO completed walk -> still HELD. Suppressing here would read "we have not looked yet" as "you no longer own it"');
  SELECT p INTO row_ FROM jsonb_array_elements((public.get_wallet_pack_history('0xnosync', NULL, NULL, 50, 0))->'packs') p WHERE p->>'pack_nft_id' = 'P19';
  PERFORM _assert(row_->>'identity_departed' IS NULL, 'P19: with no floor to measure against, departure is UNKNOWN -- not false, and not true');
  PERFORM _assert_eq(row_->>'current_owner', '0xnosync', 'P19: unconfirmed is not disproved -- the index owner still stands');

  -- filters + paging still hold
  -- STILL 7, and that is the assertion the whole v7 change exists to keep: P17
  -- and P18 would have made it 9 before the floor guard, both of them packs the
  -- wallet had already parted with.
  PERFORM _assert_eq((public.get_wallet_pack_history('0xwallet', 'nba_top_shot', 'held', 2, 0))->>'total_count', '7', 'held = P3, P4, P6, P7, P12, P13, P14 -- P17/P18 departed');
  PERFORM _assert_eq(jsonb_array_length((public.get_wallet_pack_history('0xwallet', 'nba_top_shot', 'held', 2, 0))->'packs')::text, '2', 'limit honoured');
  PERFORM _assert_eq((public.get_wallet_pack_history('0xwallet', 'nfl_all_day', NULL, 50, 0))->>'total_count', '0', 'collection filter');
  PERFORM _assert_eq((public.get_wallet_pack_history('0xnobody', NULL, NULL, 50, 0))->>'total_count', '0', 'unknown wallet -> empty, not error');
  PERFORM _assert((public.get_wallet_pack_history('', NULL, NULL, 50, 0))->>'error' = 'wallet required', 'empty wallet -> error');
END $$;

-- ── v8 (2026-09-26): wider (Golazos/Pinnacle) and deeper (Dapper pull lists) ──
-- A second wallet so every count above is untouched.
-- P20: Top Shot rip whose rip row is unvalued; Dapper's pull list prices it.
INSERT INTO public.pack_rips (collection_id, pack_nft_id, opener_address, moments_pulled, sealed_at, dist_id, pull_value_usd)
VALUES ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'P20', '0xwallet2', 3, '2026-09-01', 'D1', NULL),
-- P21: rip row valued at 7, Dapper's list only 2 of 3 priced -> the rip value stands.
       ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'P21', '0xwallet2', 3, '2026-09-02', 'D1', 7);
INSERT INTO public.pack_open_pull_values (collection_id, pack_nft_id, opener_address, n_pulls, n_resolved, n_priced, pull_value_usd) VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'P20', '0xwallet2', 3, 3, 3, 12.50),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'P21', '0xwallet2', 3, 3, 2, NULL),
-- a value keyed to ANOTHER opener must never price this wallet's P5
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'P5', '0xsomeoneelse', 3, 3, 3, 99.00),
  ('06248cc4-b85f-47cd-af67-1855d14acd75', 'G1', '0xwallet2', 4, 4, 4, 5.00);
-- G1: a Golazos open (golazos_pack_opens); G2 bought / G3 sold on the Golazos market.
INSERT INTO public.golazos_pack_opens VALUES ('G1', 'GD1', '0xwallet2', '2026-09-03', 4, 4.00);
INSERT INTO public.golazos_pack_sales_history VALUES
  ('tx-g2', 'G2', 15, true, '0xwallet2', '0xgzseller', 'GD1', '2026-09-04'),
  ('tx-g3', 'G3', 21, true, '0xgzbuyer', '0xwallet2', 'GD1', '2026-09-05');
-- PN1: a Pinnacle open; only the open row's own value is known.
INSERT INTO public.pinnacle_pack_opens VALUES ('PN1', 'PD1', '0xwallet2', '2026-09-06', 5, 3.30);

DO $$
DECLARE r jsonb; row_ jsonb;
BEGIN
  r := public.get_wallet_pack_history('0xwallet2', NULL, NULL, 50, 0);
  PERFORM _assert_eq(r->>'total_count', '6', 'P20, P21, G1, G2, G3, PN1');
  SELECT p INTO row_ FROM jsonb_array_elements(r->'packs') p WHERE p->>'pack_nft_id' = 'P20';
  PERFORM _assert_eq(row_->>'pull_value_usd', '12.50', 'P20 priced from Dapper''s pull list when the rip row is unvalued');
  PERFORM _assert_eq(row_->>'pull_value_source', 'dapper_pulls', 'P20 provenance');
  PERFORM _assert_eq(row_->>'realized_pl_usd', NULL, 'P20 no buy leg -> no P&L');
  SELECT p INTO row_ FROM jsonb_array_elements(r->'packs') p WHERE p->>'pack_nft_id' = 'P21';
  PERFORM _assert_eq(row_->>'pull_value_usd', '7.00', 'P21 a partly priced pull list never overrides a whole rip value');
  PERFORM _assert_eq(row_->>'pull_value_source', 'rip_record', 'P21 provenance');
  PERFORM _assert(row_->>'pulls_priced' = '2' AND row_->>'pulls_total' = '3', 'P21 carries how close the pull list is');
  SELECT p INTO row_ FROM jsonb_array_elements(r->'packs') p WHERE p->>'pack_nft_id' = 'G1';
  PERFORM _assert(row_->>'status' = 'ripped' AND row_->>'collection_slug' = 'laliga_golazos', 'G1 a Golazos open is RIPPED');
  PERFORM _assert_eq(row_->>'pull_value_usd', '5.00', 'G1 Dapper pull list first');
  PERFORM _assert_eq(row_->>'moments_pulled', '4', 'G1 moments from the open row');
  SELECT p INTO row_ FROM jsonb_array_elements(r->'packs') p WHERE p->>'pack_nft_id' = 'G2';
  PERFORM _assert(row_->>'status' = 'held' AND row_->>'buy_price' = '15.00' AND row_->>'buy_price_source' = 'marketplace', 'G2 a Golazos market buy is a BUY');
  SELECT p INTO row_ FROM jsonb_array_elements(r->'packs') p WHERE p->>'pack_nft_id' = 'G3';
  PERFORM _assert(row_->>'status' = 'sold' AND row_->>'sell_price' = '21.00' AND row_->>'sold_to' = '0xgzbuyer', 'G3 a Golazos market sale is a SALE');
  SELECT p INTO row_ FROM jsonb_array_elements(r->'packs') p WHERE p->>'pack_nft_id' = 'PN1';
  PERFORM _assert(row_->>'status' = 'ripped' AND row_->>'collection_slug' = 'disney_pinnacle', 'PN1 a Pinnacle open is RIPPED');
  PERFORM _assert(row_->>'pull_value_usd' = '3.30' AND row_->>'pull_value_source' = 'rip_record', 'PN1 value from the open row');

  -- the opener scoping: another wallet's pull value never prices P5
  SELECT p INTO row_ FROM jsonb_array_elements((public.get_wallet_pack_history('0xwallet', NULL, NULL, 50, 0))->'packs') p WHERE p->>'pack_nft_id' = 'P5';
  PERFORM _assert(row_->>'pull_value_usd' IS NULL AND row_->>'pull_value_source' IS NULL, 'P5 stays NULL: a pull value keyed to another opener is not this wallet''s');
END $$;

-- ── v9: reconstructed rips (packs opened with no pack NFT) ──
INSERT INTO public.wallet_reconstructed_rips (wallet, collection_id, burst_id, opened_at, moments_pulled, n_resolved, n_priced, pull_value_usd) VALUES
  ('0xwallet3', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'burst:111', '2022-06-01', 3, 3, 3, 8.40),
  ('0xwallet3', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'burst:222', '2022-06-02', 2, 2, 1, NULL),
  ('0xsomeoneelse', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'burst:333', '2022-06-03', 1, 1, 1, 1.00);

DO $$
DECLARE r jsonb; row_ jsonb;
BEGIN
  r := public.get_wallet_pack_history('0xwallet3', NULL, 'ripped', 50, 0);
  PERFORM _assert_eq(r->>'total_count', '2', 'both reconstructed rips are RIPPED rows; another wallet''s is not');
  SELECT p INTO row_ FROM jsonb_array_elements(r->'packs') p WHERE p->>'pack_nft_id' = 'burst:111';
  PERFORM _assert_eq(row_->>'rip_source', 'reconstructed', 'provenance says reconstructed');
  PERFORM _assert_eq(row_->>'pack_name', 'NBA Top Shot pack (no pack NFT, reconstructed)', 'a labelled name, never a borrowed distribution');
  PERFORM _assert(row_->>'dist_id' IS NULL AND row_->>'buy_usd' IS NULL, 'no distribution, no price paid');
  PERFORM _assert(row_->>'pull_value_usd' = '8.40' AND row_->>'pull_value_source' = 'delivery_burst', 'valued from its own moments');
  PERFORM _assert_eq(row_->>'moments_pulled', '3', 'moments from the burst');
  SELECT p INTO row_ FROM jsonb_array_elements(r->'packs') p WHERE p->>'pack_nft_id' = 'burst:222';
  PERFORM _assert(row_->>'pull_value_usd' IS NULL AND row_->>'pulls_priced' = '1' AND row_->>'pulls_total' = '2', 'partly priced burst: NULL + how close');
  -- the older rows keep their provenance
  SELECT p INTO row_ FROM jsonb_array_elements((public.get_wallet_pack_history('0xwallet2', NULL, NULL, 50, 0))->'packs') p WHERE p->>'pack_nft_id' = 'P20';
  PERFORM _assert_eq(row_->>'rip_source', 'rip', 'a held open event stays rip_source = rip');
END $$;

ROLLBACK;
