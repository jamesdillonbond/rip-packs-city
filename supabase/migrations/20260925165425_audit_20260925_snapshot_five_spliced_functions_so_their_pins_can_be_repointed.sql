-- audit_20260925_snapshot_five_spliced_functions_so_their_pins_can_be_repointed
--
-- `npm run db:pins:check` reported five STALE pins on 2026-09-25 (PT): each function
-- was changed by a COMMITTED migration that SPLICES its live body (reads prosrc,
-- replace()s a substring, EXECUTEs), so no migration file carried the full current
-- text and each pin test was still validating the previous body:
--   detect_floor_drops                  <- 20260925065017 + 20260925065051
--   detect_topshot_sweeps               <- 20260925061726
--   get_wallet_collection_snapshot      <- 20260925062018 + 20260925071828
--   get_wallet_pack_history             <- 20260925051809 + 20260925063638
--   backfill_wmc_metadata_from_editions <- 20260925062451
--
-- Each body below is the live pg_get_functiondef() captured 2026-09-25 ~9:30 AM PT
-- through query_sql (prosrc md5: detect_floor_drops e44df77d, detect_topshot_sweeps f6f1b810, get_wallet_collection_snapshot d94b25b5, get_wallet_pack_history 8d7e0a69, backfill_wmc_metadata_from_editions 024b66a3),
-- byte-identical to production, so applying this is a no-op on the database. It
-- exists so the repo DESCRIBES what runs. The five PINS entries in
-- __tests__/db-invariants-drift-guard.test.ts and their supabase/tests copies now
-- point here; CI's db-tests job re-runs each test's assertions against these bodies.
--
-- ⚠ What was APPLIED under this version (schema_migrations.statements) is NOT this
-- text: it is a DO block asserting md5(prosrc) of each function equals the md5s
-- above, and it passed. The bodies were not re-typed through the MCP tool, to rule
-- out a transcription change to five live functions. Replaying THIS file is equally
-- a no-op, so the two describe the same database.
--
-- anon-exec: unchanged (detect_floor_drops, detect_topshot_sweeps, get_wallet_collection_snapshot, get_wallet_pack_history, backfill_wmc_metadata_from_editions) — CREATE OR REPLACE of existing fns with identical bodies; ACL preserved.
-- Revert: nothing to revert (identical bodies); to un-pin, restore the previous PINS paths.

-- ── detect_floor_drops ──
CREATE OR REPLACE FUNCTION public.detect_floor_drops(p_collection_slug text DEFAULT 'nba_top_shot'::text, p_min_drop_pct numeric DEFAULT 30.0, p_min_recent_sales integer DEFAULT 3)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inserted int := 0;
  v_collection_id uuid;
BEGIN
  SELECT id INTO v_collection_id FROM collections WHERE slug = p_collection_slug;
  IF v_collection_id IS NULL THEN
    RETURN json_build_object('error', 'collection not found');
  END IF;

  WITH 
  recent_floors AS (
    SELECT DISTINCT ON (edition_id) edition_id, floor_price_usd AS now_floor, computed_at
    FROM fmv_snapshots
    WHERE collection_id = v_collection_id AND floor_price_usd IS NOT NULL
      AND computed_at > NOW() - INTERVAL '6 hours'
    ORDER BY edition_id, computed_at DESC
  ),
  prior_floors AS (
    SELECT DISTINCT ON (edition_id) edition_id, floor_price_usd AS prior_floor, computed_at
    FROM fmv_snapshots
    WHERE collection_id = v_collection_id AND floor_price_usd IS NOT NULL
      AND computed_at BETWEEN NOW() - INTERVAL '36 hours' AND NOW() - INTERVAL '20 hours'
    ORDER BY edition_id, computed_at DESC
  ),
  recent_sales_check AS (
    SELECT edition_id, COUNT(*) AS sales_24h
    FROM sales
    WHERE collection_id = v_collection_id AND sold_at > NOW() - INTERVAL '24 hours'
      AND edition_id IS NOT NULL
    GROUP BY edition_id
    HAVING COUNT(*) >= p_min_recent_sales
  ),
  drops AS (
    SELECT r.edition_id, r.now_floor, p.prior_floor,
      ROUND(100.0 * (p.prior_floor - r.now_floor) / NULLIF(p.prior_floor, 0), 1) AS drop_pct,
      rsc.sales_24h, COALESCE(e.player_name, e.team_name, e.name) AS player_name, e.set_name, e.tier
    FROM recent_floors r
    JOIN prior_floors p USING (edition_id)
    JOIN recent_sales_check rsc USING (edition_id)
    JOIN editions e ON e.id = r.edition_id
    WHERE p.prior_floor > r.now_floor
      AND (p.prior_floor - r.now_floor) / NULLIF(p.prior_floor, 0) * 100 >= p_min_drop_pct
      AND p.prior_floor > 5
      AND NOT EXISTS (
        SELECT 1 FROM topshot_insider_alerts a
        WHERE a.alert_type = 'floor_drop'
          AND a.evidence_jsonb->>'edition_id' = r.edition_id::text
          AND a.generated_at > NOW() - INTERVAL '12 hours'
      )
  )
  INSERT INTO topshot_insider_alerts (
    alert_type, title, summary, evidence_jsonb, severity, generated_at, expires_at
  )
  SELECT 
    'floor_drop',
    format('%s · %s · floor down %s%% in 24h ($%s → $%s)', player_name, set_name, drop_pct, ROUND(prior_floor, 2), ROUND(now_floor, 2)),
    format('%s drops floor by %s%% in 24h with %s active sales. Was $%s, now $%s.',
           player_name, drop_pct, sales_24h, ROUND(prior_floor, 2), ROUND(now_floor, 2)),
    jsonb_build_object(
      'edition_id', edition_id, 'collection_slug', p_collection_slug,
      'now_floor_usd', now_floor, 'prior_floor_usd', prior_floor,
      'drop_pct', drop_pct, 'sales_24h', sales_24h,
      'tier', tier, 'player_name', player_name, 'set_name', set_name
    ),
    CASE WHEN drop_pct > 60 THEN 3 WHEN drop_pct > 45 THEN 2 ELSE 1 END::smallint,
    NOW(), NOW() + INTERVAL '24 hours'
  FROM drops;
  
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN json_build_object('collection', p_collection_slug, 'alerts_inserted', v_inserted);
END;
$function$;

-- ── detect_topshot_sweeps ──
CREATE OR REPLACE FUNCTION public.detect_topshot_sweeps(p_collection_slug text DEFAULT 'nba_top_shot'::text, p_min_moments integer DEFAULT 15, p_min_distinct_editions integer DEFAULT 8, p_lookback_hours integer DEFAULT 24)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inserted int := 0;
  v_collection_id uuid;
  v_gap_minutes int := 20;
  v_min_spend numeric := 75;
  v_duc_proposer text := '0xead892083b3e2c6c';
BEGIN
  IF p_collection_slug <> 'nba_top_shot' THEN
    RETURN json_build_object('collection', p_collection_slug, 'alerts_inserted', 0, 'skipped', 'ts_only');
  END IF;

  SELECT id INTO v_collection_id FROM collections WHERE slug = p_collection_slug;
  IF v_collection_id IS NULL THEN
    RETURN json_build_object('error', 'collection not found');
  END IF;

  WITH base AS (
    SELECT s.buyer_address, s.sold_at, s.edition_id, s.price_usd, e.set_name
    FROM sales s
    JOIN editions e ON e.id = s.edition_id
    WHERE s.collection_id = v_collection_id
      AND s.proposer_address = v_duc_proposer
      AND s.sold_at > NOW() - make_interval(hours => p_lookback_hours)
      AND s.buyer_address IS NOT NULL
      AND s.edition_id IS NOT NULL
      AND s.buyer_address NOT IN ('0x3cdbb3d569211ff3', '0xedf9df96c92f4595', '0xc1e4f4f4c4257510')
  ),
  marked AS (
    SELECT b.*,
      CASE
        WHEN LAG(b.sold_at) OVER (PARTITION BY b.buyer_address ORDER BY b.sold_at) IS NULL
          OR b.sold_at - LAG(b.sold_at) OVER (PARTITION BY b.buyer_address ORDER BY b.sold_at)
             > make_interval(mins => v_gap_minutes)
        THEN 1 ELSE 0
      END AS is_new
    FROM base b
  ),
  sessioned AS (
    SELECT m.*,
      SUM(m.is_new) OVER (PARTITION BY m.buyer_address ORDER BY m.sold_at ROWS UNBOUNDED PRECEDING) AS sess
    FROM marked m
  ),
  agg AS (
    SELECT
      buyer_address, sess,
      COUNT(*)                     AS moments,
      COUNT(DISTINCT edition_id)   AS distinct_editions,
      SUM(price_usd)               AS total_spent,
      AVG(price_usd)               AS avg_price,
      MIN(sold_at)                 AS first_buy,
      MAX(sold_at)                 AS last_buy,
      (ARRAY_AGG(DISTINCT set_name))[1:3] AS sample_sets
    FROM sessioned
    GROUP BY buyer_address, sess
  ),
  qualified AS (
    SELECT a.* FROM agg a
    WHERE a.distinct_editions >= p_min_distinct_editions
      AND (a.moments >= p_min_moments OR a.total_spent >= v_min_spend)
      AND NOT EXISTS (
        SELECT 1 FROM topshot_insider_alerts al
        WHERE al.alert_type = 'floor_sweep'
          AND al.evidence_jsonb->>'buyer_address' = a.buyer_address
          AND (al.evidence_jsonb->>'last_buy')::timestamptz = a.last_buy
          AND al.generated_at > NOW() - INTERVAL '48 hours'
      )
  ),
  ranked AS (
    SELECT q.*,
      (CASE
        WHEN q.moments >= 40 OR q.total_spent >= 250 THEN 3
        WHEN q.moments >= 20 OR q.total_spent >= 100 THEN 2
        ELSE 1
      END)::smallint AS sev,
      ROW_NUMBER() OVER (
        PARTITION BY q.buyer_address
        ORDER BY q.last_buy DESC, q.moments DESC, q.total_spent DESC
      ) AS rn
    FROM qualified q
  )
  INSERT INTO topshot_insider_alerts (
    alert_type, title, summary, evidence_jsonb, severity, generated_at, expires_at
  )
  SELECT
    'floor_sweep',
    format('Floor sweep: %s moments across %s editions ($%s)',
           ranked.moments, ranked.distinct_editions, ROUND(ranked.total_spent, 0)),
    format('%s swept %s moments across %s editions in one burst (%s). Avg $%s, total $%s.%s',
           COALESCE(
             NULLIF(wu.username, '') || ' (' || SUBSTRING(ranked.buyer_address, 1, 10) || '…)',
             'Wallet ' || SUBSTRING(ranked.buyer_address, 1, 10) || '...'
           ),
           ranked.moments, ranked.distinct_editions,
           to_char(ranked.first_buy AT TIME ZONE 'America/Los_Angeles', 'Mon DD HH12:MI AM') || '–' || to_char(ranked.last_buy AT TIME ZONE 'America/Los_Angeles', 'HH12:MI AM PT'),
           ROUND(ranked.avg_price, 2), ROUND(ranked.total_spent, 2),
           CASE WHEN COALESCE(array_length(ranked.sample_sets, 1), 0) > 0
                THEN ' Sets: ' || array_to_string(ranked.sample_sets, ', ') || '.' ELSE '' END),
    jsonb_build_object(
      'buyer_address', ranked.buyer_address,
      'buyer_username', NULLIF(wu.username, ''),
      'collection_slug', p_collection_slug,
      'moments', ranked.moments,
      'distinct_editions', ranked.distinct_editions,
      'total_spent', ranked.total_spent,
      'avg_price', ranked.avg_price,
      'first_buy', ranked.first_buy,
      'last_buy', ranked.last_buy,
      'sample_sets', ranked.sample_sets,
      'via', 'quick_buy'
    ),
    ranked.sev,
    NOW(), NOW() + INTERVAL '24 hours'
  FROM ranked
  LEFT JOIN wallet_usernames wu ON wu.wallet_addr = ranked.buyer_address
  WHERE ranked.rn = 1;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN json_build_object('collection', p_collection_slug, 'alerts_inserted', v_inserted);
END;
$function$;

-- ── get_wallet_collection_snapshot ──
CREATE OR REPLACE FUNCTION public.get_wallet_collection_snapshot(p_wallet text)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH w AS (
    SELECT player_name, set_name, tier, serial_number, edition_key,
           image_url, series_number, fmv_usd, mint_count, collection_id
    FROM wallet_moments_cache
    WHERE wallet_address = p_wallet
  ),
  top5 AS (
    SELECT jsonb_agg(t) AS arr FROM (
      SELECT player_name AS "playerName",
             set_name    AS "setName",
             tier,
             serial_number AS serial,
             round(COALESCE(fmv_usd, 0)::numeric, 2) AS fmv,
             image_url   AS "thumbnailUrl"
      FROM w
      WHERE fmv_usd IS NOT NULL AND fmv_usd > 0
      ORDER BY fmv_usd DESC
      LIMIT 5
    ) t
  ),
  -- 2026-09-24: the bars are the wallet's LARGEST collection's series, named
  -- the way every other page names them (series_display_label). Mixing every
  -- collection's raw series number into one row named nothing ("S0", "S9").
  series_coll AS (
    SELECT w.collection_id, c.slug, c.name
    FROM w JOIN collections c ON c.id = w.collection_id
    GROUP BY w.collection_id, c.slug, c.name
    ORDER BY count(*) DESC, c.slug
    LIMIT 1
  ),
  series_rows AS (
    -- 2026-09-25: grouped by LABEL — on-chain 0 and a stored 1 are both Top Shot
    -- "Series 1" and drew two bars.
    SELECT min(w.series_number) AS series_number,
           COALESCE(public.series_display_label(w.collection_id, w.series_number::int), 'SUnknown') AS label,
           count(*)::int AS cnt
    FROM w
    WHERE w.collection_id = (SELECT collection_id FROM series_coll)
    GROUP BY w.collection_id, COALESCE(public.series_display_label(w.collection_id, w.series_number::int), 'SUnknown')
  ),
  series AS (
    SELECT jsonb_object_agg(label, cnt) AS obj FROM series_rows
  ),
  series_bars AS (
    SELECT jsonb_agg(jsonb_build_object('label', label, 'count', cnt, 'series_number', series_number)
                     ORDER BY series_number NULLS LAST) AS arr
    FROM series_rows
  ),
  badges AS (
    SELECT count(DISTINCT be.external_id)::int AS c
    FROM badge_editions be
    WHERE be.external_id IN (SELECT DISTINCT edition_key FROM w WHERE edition_key IS NOT NULL)
  ),
  per_coll AS (
    SELECT jsonb_agg(pc ORDER BY (pc->>'moments')::int DESC) AS arr FROM (
      SELECT jsonb_build_object(
               'slug', c.slug,
               'name', c.name,
               'moments', count(*),
               -- Closed markets carry a count but no dollar total (a closed
               -- market has no current value). market_closed_at lets the UI
               -- render a "count + note" instead of a figure.
               'fmv', round(COALESCE(sum(w.fmv_usd), 0)::numeric, 2),
               -- 2026-09-06: same basis as the headline (total − stale). The card
               -- printed NBA Top Shot $87,785 raw beside a $50,223 headline.
               'stale_fmv', round(COALESCE(sum(w.fmv_usd) FILTER (WHERE l.confidence = 'STALE'), 0)::numeric, 2),
               'stale_count', count(*) FILTER (WHERE l.confidence = 'STALE'),
               'market_closed_at', c.market_closed_at
             ) AS pc
      FROM w JOIN collections c ON c.id = w.collection_id
      LEFT JOIN LATERAL (
        SELECT l.confidence FROM editions e JOIN edition_fmv_current l ON l.edition_id = e.id
         WHERE e.external_id = w.edition_key AND e.collection_id = w.collection_id LIMIT 1
      ) l ON true
      GROUP BY c.slug, c.name, c.market_closed_at
    ) x
  ),
  -- 2026-09-04: stale split, so the front door can headline total − stale like the profile
  stale AS (
    SELECT
      round(COALESCE(sum(w.fmv_usd) FILTER (
        WHERE w.collection_id NOT IN (SELECT id FROM collections WHERE market_closed_at IS NOT NULL)
      ), 0)::numeric, 2) AS stale_fmv,
      count(*)::int AS stale_count
    FROM w
    JOIN editions e ON e.external_id = w.edition_key AND e.collection_id = w.collection_id
    JOIN edition_fmv_current l ON l.edition_id = e.id
    WHERE l.confidence = 'STALE'
  ),
  rarest AS (
    SELECT to_jsonb(r) AS obj FROM (
      SELECT player_name AS "playerName",
             set_name    AS "setName",
             tier,
             serial_number AS serial,
             mint_count  AS "mintCount",
             round(COALESCE(fmv_usd, 0)::numeric, 2) AS fmv,
             image_url   AS "thumbnailUrl"
      FROM w
      WHERE mint_count IS NOT NULL AND mint_count > 0
      ORDER BY mint_count ASC, fmv_usd DESC NULLS LAST
      LIMIT 1
    ) r
  )
  SELECT jsonb_build_object(
    'wallet', p_wallet,
    'totalMoments', (SELECT count(*)::int FROM w),
    -- Grand FMV excludes collections whose market has closed; their moments
    -- still count in totalMoments (real holdings), but their dead-market value
    -- is not folded into the headline total.
    'totalFmv', round(COALESCE((
        SELECT sum(fmv_usd) FROM w
        WHERE collection_id NOT IN (SELECT id FROM collections WHERE market_closed_at IS NOT NULL)
      ), 0)::numeric, 2),
    'topMoments', COALESCE((SELECT arr FROM top5), '[]'::jsonb),
    'badgeCount', COALESCE((SELECT c FROM badges), 0),
    'seriesBreakdown', COALESCE((SELECT obj FROM series), '{}'::jsonb),
    'seriesBars', COALESCE((SELECT arr FROM series_bars), '[]'::jsonb),
    'seriesCollection', (SELECT jsonb_build_object('slug', slug, 'name', name) FROM series_coll),
    'perCollection', COALESCE((SELECT arr FROM per_coll), '[]'::jsonb),
    'rarest', (SELECT obj FROM rarest),
    'staleFmv', COALESCE((SELECT stale_fmv FROM stale), 0),
    'staleCount', COALESCE((SELECT stale_count FROM stale), 0)
  );
$function$;

-- ── get_wallet_pack_history ──
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

-- ── backfill_wmc_metadata_from_editions ──
CREATE OR REPLACE FUNCTION public.backfill_wmc_metadata_from_editions(p_wallet_address text DEFAULT NULL::text, p_collection_id uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_updated integer;
BEGIN
  -- ⚠ EXECUTE … USING, not a plain statement: a plain one is planned GENERIC
  -- from the sixth call of a pooled session onward, and the generic plan for
  -- this WHERE clause seq-scans `editions` and probes wmc per edition — 62x the
  -- buffers (measured 2026-09-13; see this migration's header and #113).
  EXECUTE $q$
  WITH updated AS (
    UPDATE public.wallet_moments_cache wmc
       SET tier        = COALESCE(wmc.tier,        e.tier::text),
           player_name = COALESCE(wmc.player_name, e.player_name, e.team_name),
           set_name    = COALESCE(wmc.set_name,    e.set_name),
           mint_count  = COALESCE(wmc.mint_count,  e.circulation_count),
           team_name   = COALESCE(wmc.team_name,   e.team_name),
           -- 2026-09-24: series was the one column this fill skipped (940k NULLs).
           series_number = COALESCE(wmc.series_number, e.series::int)
      FROM public.editions e
     WHERE e.collection_id = wmc.collection_id
       AND e.external_id   = wmc.edition_key
       AND wmc.edition_key IS NOT NULL
       -- Only rows where at least one NULL can actually be filled. Without the
       -- right-hand IS NOT NULL checks a row whose edition is also NULL in that
       -- column was rewritten with identical values on every run (2026-08-30).
       AND (
         (wmc.tier        IS NULL AND e.tier IS NOT NULL) OR
         (wmc.player_name IS NULL AND COALESCE(e.player_name, e.team_name) IS NOT NULL) OR
         (wmc.set_name    IS NULL AND e.set_name IS NOT NULL) OR
         (wmc.mint_count  IS NULL AND e.circulation_count IS NOT NULL) OR
         (wmc.team_name   IS NULL AND e.team_name IS NOT NULL) OR
         (wmc.series_number IS NULL AND e.series IS NOT NULL)
       )
       AND ($1 IS NULL OR wmc.wallet_address = $1)
       AND ($2 IS NULL OR wmc.collection_id  = $2)
    RETURNING 1
  )
  SELECT COUNT(*)::int FROM updated
  $q$
  INTO v_updated
  USING p_wallet_address, p_collection_id;

  RETURN COALESCE(v_updated, 0);
END;
$function$;
