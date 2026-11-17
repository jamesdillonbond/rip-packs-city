-- 2026-09-26 (PT) — get_wallet_pack_history v11: a Top Shot pack Dapper MINTED
-- straight into the wallet carries its drop's retail (inferred) however late it
-- arrived; a Trade Ticket pack is never priced in dollars.
--
-- WHY. The sale-window rule (20260926190300) left 227 of 0xbd94cade097e50ac's
-- sealed Top Shot packs and 7 rips with no cost: they reached the wallet a median
-- ~2 months after their drops started. 215 of them arrived in ONE Flow
-- transaction (849c43fa...13a2, 2026-04-24 04:15 AM PT) in which Dapper's PDS
-- account mints PackNFTs for a list of distributions (Anthology Quick Rip 2024-06,
-- Fast Break rewards, 2026 Trade Ticket packs) straight into the wallet -- packs
-- the account already held at Dapper, turned into NFTs. A minted-in pack never
-- passed through a marketplace; 20260926200000 records those mints
-- (pack_nft_mints). And 37 Top Shot distributions are Trade Ticket packs whose
-- retail_price_usd ("10", "100" for Premium) is a ticket count: they read as $10
-- recorded primary buys (6 on this wallet) and $10 inferred costs (7).
--
-- WHAT.
--   pack_retail_usd(raw, title): NULL for a Trade Ticket distribution, else
--     pack_retail_usd(raw). The history reads retail through it.
--   inferable: the sale-window rule, OR (Top Shot) a pack_nft_mints row within
--     2 s of the index's acquisition instant for this wallet. New key
--     minted_to_wallet_at says so per row.
-- anon-exec: unchanged (get_wallet_pack_history) — CREATE OR REPLACE of an existing fn; ACL preserved, has_function_privilege anon=false, authenticated=false (read 2026-09-26).
-- anon-exec: pack_retail_usd(text, text) — new; REVOKE FROM PUBLIC, anon, authenticated below.
--
-- Revert: re-apply the body from
--   supabase/migrations/20260926190300_audit_20260926_inferred_drop_cost_only_inside_the_drops_sale_window.sql
-- and repoint its pin; then (after 20260926200200 / 200300 are reverted too)
--   DROP FUNCTION public.pack_retail_usd(text, text);

CREATE OR REPLACE FUNCTION public.pack_retail_usd(p_raw text, p_title text)
RETURNS numeric
LANGUAGE sql
IMMUTABLE PARALLEL SAFE
SET search_path TO 'public'
AS $function$
  -- A drop's retail in DOLLARS, knowing which drop it is: a Trade Ticket pack is
  -- bought with Trade Tickets, and its retail_price_usd is the ticket price --
  -- no dollar amount exists, so NULL (unknown), never the ticket count as $.
  SELECT CASE WHEN p_title ILIKE '%trade ticket%' THEN NULL
              ELSE public.pack_retail_usd(p_raw) END
$function$;

REVOKE ALL ON FUNCTION public.pack_retail_usd(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pack_retail_usd(text, text) TO postgres, service_role;

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
      pi.acquired_at   AS identity_acquired_at,
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
      rt.retail_usd,
      mt.minted_at AS minted_to_wallet_at,
      -- what the wallet PAID: on-chain/marketplace price for a secondary buy,
      -- the distribution's retail price for a primary drop, NULL when unknown.
      -- 2026-09-26 (v10): ... and, for a pack with NO buy row that can only have
      -- come from Dapper, the drop's retail price, labelled 'retail_inferred'.
      CASE WHEN r.bought_primary THEN rt.retail_usd
           WHEN NOT r.has_buy AND inf.inferable THEN rt.retail_usd
           ELSE r.buy_price END AS buy_usd,
      CASE
        WHEN NOT r.has_buy AND inf.inferable AND rt.retail_usd IS NOT NULL THEN 'retail_inferred'
        WHEN NOT r.has_buy THEN NULL
        WHEN r.bought_primary AND rt.retail_usd IS NOT NULL THEN 'retail'
        WHEN r.bought_primary THEN NULL
        WHEN r.buy_price IS NULL THEN NULL
        ELSE r.buy_src
      END AS buy_price_source
    FROM resolved r
    LEFT JOIN public.pack_distributions pd
      ON pd.dist_id = r.dist_id AND pd.collection_id = r.collection_id
    -- 2026-09-26: retail in DOLLARS. Top Shot's pack_distributions.metadata
    -- carries some prices in UFix64 units (x1e8: 109 dists, 371 primary buys
    -- read as tens of millions of dollars); pack_retail_usd() normalises by the
    -- estate's rule (>= 1,000,000 -> /1e8). All Day keeps its drop price in
    -- allday_pack_supply.pack_price, where 0 is "not known", never "free".
    LEFT JOIN public.allday_pack_supply aps
      ON r.collection_id = v_ad AND aps.dist_id = r.dist_id
    CROSS JOIN LATERAL (
      SELECT CASE WHEN r.collection_id = v_ad THEN NULLIF(aps.pack_price, 0)
                  ELSE public.pack_retail_usd(pd.metadata->>'retail_price_usd', pd.title) END AS retail_usd
    ) rt
    -- A pack with no buy row we hold is priced at its drop's retail ONLY when it
    -- was acquired inside that drop's sale window -- from 1 day before the
    -- drop's start_time to 30 days after (the acquisition is Dapper's index
    -- date, else bounded by when the wallet sold or opened it) -- and our
    -- marketplace history covers that window (every Top Shot PackNFT; an All
    -- Day drop that started on/after 2022-12-16). An old drop acquired long
    -- after its sale (All Day Series 1 packs received in 2023-25 with no sale
    -- on record: rewards, not retail) stays NULL, as does any drop with no
    -- start_time. A transfer inside the window would read the same. Never a
    -- reconstructed rip (no distribution).
    CROSS JOIN LATERAL (
      SELECT CASE WHEN pg_input_is_valid(pd.metadata->>'start_time', 'timestamptz')
                  THEN (pd.metadata->>'start_time')::timestamptz END AS drop_start
    ) ds
    -- 2026-09-26 (v11): ... OR Dapper MINTED the pack into this wallet at the
    -- instant its index says the wallet acquired it (pack_nft_mints, read from
    -- Flow's PackNFT.Minted). A pack minted in never passed through a
    -- marketplace, so it came from Dapper however long after its drop: a
    -- custodial pack turned into an NFT (215 of 0xbd94...'s, one PDS mint on
    -- 2026-04-24) or a drop bought and minted in. Top Shot only -- its reward
    -- packs carry a retail of 0, so a reward reads "$0 (reward)"; All Day's
    -- supply price does not mark a reward, and a reward priced as a purchase is
    -- the Series 1 defect this window exists to prevent.
    LEFT JOIN LATERAL (
      SELECT m.minted_at FROM public.pack_nft_mints m
       WHERE r.collection_id = v_ts
         AND m.collection_id = r.collection_id AND m.pack_nft_id = r.pack_nft_id
         AND r.identity_acquired_at IS NOT NULL
         AND abs(extract(epoch FROM m.minted_at - r.identity_acquired_at)) <= 2
    ) mt ON true
    CROSS JOIN LATERAL (
      SELECT coalesce(r.dist_id IS NOT NULL
              AND r.rip_source IS DISTINCT FROM 'reconstructed'
              AND ((ds.drop_start IS NOT NULL
                    AND (r.collection_id = v_ts
                         OR (r.collection_id = v_ad AND ds.drop_start >= timestamptz '2022-12-16'))
                    AND COALESCE(r.identity_acquired_at, LEAST(r.sold_at, r.ripped_at))
                          BETWEEN ds.drop_start - interval '1 day' AND ds.drop_start + interval '30 days')
                   OR mt.minted_at IS NOT NULL), false) AS inferable
    ) inf
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
        -- 2026-09-26: a pack sold with no buy row, priced at its drop's retail
        WHEN status = 'sold'    AND sell_price     IS NOT NULL AND buy_usd IS NOT NULL
                                AND buy_price_source = 'retail_inferred'           THEN sell_price     - buy_usd
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
      )
      -- 2026-09-26 (v11): when Dapper minted this pack straight into this
      -- wallet (Flow PackNFT.Minted at the index's acquisition instant); NULL =
      -- not known to be (a buy, a transfer, or before the spork floor). A second
      -- object: the one above is at Postgres's 100-argument limit.
      || jsonb_build_object('minted_to_wallet_at', minted_to_wallet_at)
      ORDER BY latest_event_at DESC NULLS LAST, collection_id, pack_nft_id
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
      'retail', 'buy_price_source = retail_inferred: a pack with no buy row we hold, priced at its drop''s retail -- only when it was acquired inside the drop''s sale window (start_time - 1 day .. + 30 days; acquisition = Dapper''s index date, else bounded by the sale / open) and the marketplace history covers that window (every Top Shot PackNFT; All Day drops from 2022-12-16), or -- Top Shot -- Dapper minted it straight into this wallet (minted_to_wallet_at; pack_nft_mints, Flow PackNFT.Minted from the 2025-12-29 spork floor). An old drop acquired long after its sale otherwise stays NULL. A transfer inside the window would read the same. A Trade Ticket pack''s price is in tickets, not dollars: NULL. Retail is in dollars (Top Shot UFix64 values normalised; All Day from allday_pack_supply, 0 = unknown)',
      'reconstructed', 'wallet_reconstructed_rips: Top Shot packs opened with NO pack NFT (custodial packs, 2021 on), rebuilt from the wallet''s pack-pull moment deliveries (a gap > 3 s starts a new reveal; 114 of 115 bursts overlapping a known pack matched its moment list exactly). rip_source = reconstructed; no distribution, no price paid; covers deliveries seeded into moment_acquisitions (through 2026-03)',
      'pulls', 'pack_open_pull_values: every pack this wallet opened, priced from the moments Dapper''s searchPackNft.nfts says it yielded (current FMV, whole-pack: NULL unless every moment is priced; pulls_priced / pulls_total say how close). Refreshed by the wallet-pack-pulls lane; pull_value_source = rip_record where only the rip row''s value is held',
      'marketplace', 'topshot_pack_sales_history / allday_pack_sales_history / golazos_pack_sales_history: Dapper marketplace secondary sales (seller = storefront_address), Top Shot from 2023-09, All Day from 2022-12; ingest is bursty and can lag days',
      'identity', 'pack_nft_identity: Dapper searchPackNft index (dist_id, Sealed/Opened, current owner, acquired_at) filled by the pack-nft-identity lane and the per-wallet sync; identity_sync says when this wallet''s holdings were last confirmed (NULL completed_at = not yet, the list is what we hold so far). An ownership claim is trusted only at or after identity_sync.last_clean_sync_at, the start of the last clean full walk: a row older than that names a pack the wallet no longer holds, is excluded from the held/ripped counts, and carries identity_departed = true'
    ),
    'computed_at', now()
  );
END;
$function$;
