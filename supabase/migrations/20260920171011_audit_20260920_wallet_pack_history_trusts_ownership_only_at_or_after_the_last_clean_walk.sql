-- Part 2 of 2 -- the READER, the sweep headroom, and the watch on the floor.
-- Applied to production as
--   audit_20260920_wallet_pack_history_trusts_ownership_only_at_or_after_the_last_clean_walk
-- immediately after its part 1
--   audit_20260920_wallet_pack_inventory_stops_claiming_packs_the_wallet_no_longer_holds
-- (20260920170756_*.sql), which carries the full write-up, the measurement and
-- the revert path. Split into two files because that is how production recorded
-- it: migration parity matches on NAME, so one file for two applied names would
-- leave the second permanently missing.
--
-- In short: an ownership claim in pack_nft_identity is never retired -- a pack
-- that LEAVES a wallet is never returned by a later walk, and only packs
-- carrying a purchase or a rip row are ever re-checked, so a SEALED pack that
-- leaves by transfer keeps owner_address = the old wallet for ever. 23 such
-- rows on 5 of the 27 saved wallets, 23 of 23 Sealed, every one rendered to its
-- owner as an unopened pack still in their inventory. This half stops the
-- reader believing them.

-- ---------------------------------------------------------------------------
-- 4. The reader.
-- ---------------------------------------------------------------------------

-- anon-exec: intentional — CREATE OR REPLACE keeps the ACL of get_wallet_pack_history (service_role only; unchanged by this migration, verified live after apply)
-- >>> BEGIN verbatim get_wallet_pack_history (pinned by supabase/tests/get_wallet_pack_history.sql) >>>
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
    SELECT id, pack_nft_id, collection_id, sealed_at, moments_pulled, dist_id, pull_value_usd
    FROM public.pack_rips WHERE opener_address = v_wallet
  ),
  -- (3) Dapper's index of what the wallet HOLDS or OPENED (pack_nft_identity,
  --     filled by the pack-nft-identity lane's wallet sync): the packs our
  --     buy/rip tables never saw -- reward packs, boxes and drops from before
  --     on-chain coverage. Ranked below every sale and rip we hold.
  index_holds AS (
    SELECT pack_nft_id, collection_id, coalesce(acquired_at, checked_at) AS at,
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
      wr.id AS rip_id, wr.sealed_at AS ripped_at, wr.moments_pulled, wr.pull_value_usd,
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
      LIMIT 1
    ) hx ON true
  ),
  enriched AS (
    SELECT
      r.*,
      pd.title              AS pack_name,
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
        'moments_pulled', moments_pulled,
        'pull_value_usd', CASE WHEN pull_value_usd IS NULL THEN NULL ELSE ROUND(pull_value_usd::numeric, 2) END,
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
      'marketplace', 'topshot_pack_sales_history / allday_pack_sales_history: Dapper marketplace secondary sales (seller = storefront_address), Top Shot from 2023-09, All Day from 2022-12; ingest is bursty and can lag days',
      'identity', 'pack_nft_identity: Dapper searchPackNft index (dist_id, Sealed/Opened, current owner, acquired_at) filled by the pack-nft-identity lane and the per-wallet sync; identity_sync says when this wallet''s holdings were last confirmed (NULL completed_at = not yet, the list is what we hold so far). An ownership claim is trusted only at or after identity_sync.last_clean_sync_at, the start of the last clean full walk: a row older than that names a pack the wallet no longer holds, is excluded from the held/ripped counts, and carries identity_departed = true'
    ),
    'computed_at', now()
  );
END;
$function$;
-- <<< END verbatim get_wallet_pack_history <<<

-- ---------------------------------------------------------------------------
-- 5. Sweep headroom. Unrelated to the bug above; included because it is the
--    same question ("is every saved wallet up to date?") one growth step later.
--
--    sweep_saved_wallet_pack_syncs re-syncs a wallet once its last completed
--    walk is 3 h old, and the cron hands it N wallets an hour. Steady state
--    therefore needs N >= wallets / 3. At 10 the ceiling is 30 SAVED WALLETS,
--    and there are 27 today -- four short, with no alarm on the crossing: the
--    sweep would simply start leaving the oldest wallets behind, and every
--    wallet would still report a completed sync, just an older one.
--    15 moves the ceiling to 45. It is a headroom change, not a fix: nothing is
--    behind today (every one of the 27 was inside 3 h when measured).
--    Same jobname + same owner (postgres) => cron.schedule updates jobid 510
--    in place rather than creating a second sweep.
-- REVERT: SELECT cron.schedule('rpc-wallet-pack-sync-sweep', '17 * * * *',
--           $$SELECT public.sweep_saved_wallet_pack_syncs(10);$$);
-- ---------------------------------------------------------------------------

SELECT cron.schedule(
  'rpc-wallet-pack-sync-sweep',
  '17 * * * *',
  $$SELECT public.sweep_saved_wallet_pack_syncs(15);$$
);

-- ---------------------------------------------------------------------------
-- 6. The watch on the floor itself.
--
-- ⚠ THE READ GUARD ABOVE FAILS SILENTLY AND IN THE COMFORTABLE DIRECTION. If the
--    trigger stops stamping -- dropped, or a future writer of pack_wallet_sync
--    that does not go through it -- last_clean_sync_at simply stops advancing,
--    every floor reads NULL or stale, `v_sync_floor IS NULL` switches the guard
--    OFF for every wallet, and the phantom holdings come back. Nothing errors.
--    Every test above still passes, because they set the column by hand.
--
--    So: a saved wallet whose sync says it completed cleanly MUST carry a floor
--    at or after that walk's requested_at. Anything else is the trigger not
--    working. Returns [] when clean -- read the LENGTH of the array, never
--    count(*), which is 1 either way.
-- ---------------------------------------------------------------------------

-- anon-exec: intentional — REVOKEd below; check_wallet_pack_sync_floor_drift reads saved_wallets and is service_role-only, like every other check_* invariant.
CREATE OR REPLACE FUNCTION public.check_wallet_pack_sync_floor_drift()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'wallet',             s.wallet,
           'requested_at',       s.requested_at,
           'completed_at',       s.completed_at,
           'last_clean_sync_at', s.last_clean_sync_at)), '[]'::jsonb)
  FROM public.pack_wallet_sync s
  WHERE EXISTS (SELECT 1 FROM public.saved_wallets w WHERE lower(w.wallet_addr) = s.wallet)
    AND s.completed_at IS NOT NULL
    AND s.last_error IS NULL
    AND s.completed_at >= s.requested_at
    AND (s.last_clean_sync_at IS NULL OR s.last_clean_sync_at < s.requested_at);
$function$;

REVOKE EXECUTE ON FUNCTION public.check_wallet_pack_sync_floor_drift()
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.check_wallet_pack_sync_floor_drift() IS
  'Saved wallets whose pack_wallet_sync row records a CLEAN completed walk but '
  'carries no floor at or after it -- i.e. pack_wallet_sync_stamp_clean_floor_trg '
  'is not doing its job, which silently disarms the ownership-confirmation guard '
  'in get_wallet_pack_history and lets departed packs read as held again. '
  '[] = clean; read the array LENGTH, not count(*). Called by '
  'app/api/cron/data-integrity. Added 2026-09-20.';
