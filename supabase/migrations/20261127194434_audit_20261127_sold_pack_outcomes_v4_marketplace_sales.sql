-- audit_20261127_sold_pack_outcomes_v4_marketplace_sales
--
-- 2026-11-27 (PT, midday; Claude Code cloud; Trevor: "Keep digging and probing").
-- Bases (same day): 20261127193527_audit_20261127_sold_pack_outcomes_v3_probe_fixes.sql (reader, runner),
-- 20261127184816_audit_20261127_sold_pack_open_tx_reads.sql (dispatch),
-- 20261127185651_audit_20261127_sold_container_open_search.sql (container search).
--
-- WHY: the Sold tab's rows come mostly from Dapper's MARKETPLACE history (get_wallet_pack_history reads
-- *_pack_sales_history WHERE storefront_address = wallet AND purchased, 2023 on), but the reader proved a
-- sale only from pack_purchases (the on-chain storefront ingest, 2026-04 on). Trevor's Top Shot Sold tab:
-- 379 rows, 12 recognized; saved wallets overall: 33,435 Top Shot + 6,005 All Day marketplace sales vs
-- 8,771 in pack_purchases -- the column read "—" on most of the tab.
--
-- WHAT:
--   * reader: a sale is either source; latest sale wins. `contents_unknown` now also covers an opened
--     pack with no pull on record (was: only one with no rip) -- the honest label for the ~19k Top Shot
--     marketplace-sold packs ripped before 2025-10, whose blocks no live Flow node serves (#181).
--   * open-tx lane: scope includes marketplace sales; reads are routed by block -- rest-mainnet from the
--     current spork root (137390146), access-001.mainnet27 for 130290659..137390145 (1,188 such rips;
--     measured: 200 with TopShot.Deposit events in the open tx), and nothing below; 60 a tick.
--   * container search and opener usernames: marketplace sales enrol too (container search: sales in the
--     current spork only -- its events endpoint serves nothing older).
--
-- REVERT: re-apply each body from its base file named above.

CREATE OR REPLACE FUNCTION public.get_wallet_sold_pack_outcomes(p_wallet text, p_pack_nft_ids text[])
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '15s'
AS $fn$
WITH RECURSIVE me AS (
  -- Flow addresses fold to lower case; a base58 (Solana) key is case-sensitive and is kept as given.
  SELECT CASE WHEN p_wallet ~* '^0x' THEN lower(p_wallet) ELSE p_wallet END AS w
),
ids AS (
  SELECT DISTINCT x AS pack_nft_id
  FROM unnest(p_pack_nft_ids[1:100]) AS x
  WHERE x IS NOT NULL AND x <> ''
),
sold_rows AS (
  -- every recorded sale BY this wallet: the on-chain storefront ingest (pack_purchases, 2026-04 on)
  -- and Dapper's marketplace history (*_pack_sales_history, 2023 on -- the Sold tab's main source)
  SELECT pp.pack_nft_id, pp.collection_id, pp.pack_dist_id, pp.sale_price, pp.sealed_at AS sold_at
  FROM ids
  JOIN public.pack_purchases pp ON pp.pack_nft_id = ids.pack_nft_id
  WHERE pp.seller_address = (SELECT w FROM me)
  UNION ALL
  SELECT h.pack_nft_id, '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, h.dist_id, h.sale_price_usd, h.block_time
  FROM ids
  JOIN public.topshot_pack_sales_history h ON h.pack_nft_id = ids.pack_nft_id
  WHERE h.purchased AND h.storefront_address = (SELECT w FROM me)
  UNION ALL
  SELECT h.pack_nft_id, 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid, h.dist_id, h.sale_price_usd, h.block_time
  FROM ids
  JOIN public.allday_pack_sales_history h ON h.pack_nft_id = ids.pack_nft_id
  WHERE h.purchased AND h.storefront_address = (SELECT w FROM me)
  UNION ALL
  SELECT h.pack_nft_id, '06248cc4-b85f-47cd-af67-1855d14acd75'::uuid, h.dist_id, h.sale_price_usd, h.block_time
  FROM ids
  JOIN public.golazos_pack_sales_history h ON h.pack_nft_id = ids.pack_nft_id
  WHERE h.purchased AND h.storefront_address = (SELECT w FROM me)
),
sold AS (
  -- only packs this wallet sold; the latest sale of each is the one that let it go
  SELECT DISTINCT ON (pack_nft_id) * FROM sold_rows ORDER BY pack_nft_id, sold_at DESC
),
tree(root, collection_id, pack_nft_id, depth) AS (
  -- the sold pack itself, then (for a box or case) the packs it opened into, two levels deep
  SELECT s.pack_nft_id, s.collection_id, s.pack_nft_id, 0 FROM sold s
  UNION ALL
  SELECT t.root, t.collection_id, b.pack_nft_id, t.depth + 1
  FROM tree t
  JOIN public.pack_box_contents b ON b.collection_id = t.collection_id AND b.box_pack_nft_id = t.pack_nft_id
  WHERE t.depth < 2
),
node AS (
  SELECT t.*,
         EXISTS (SELECT 1 FROM public.pack_box_contents b
                  WHERE b.collection_id = t.collection_id AND b.box_pack_nft_id = t.pack_nft_id) AS has_children
  FROM tree t
),
leaf AS (
  -- packs of moments: every node that did not itself open into packs
  SELECT n.root, n.collection_id, n.pack_nft_id, n.depth,
         r.id AS rip_id, r.tx_hash AS rip_tx, r.moments_pulled,
         (r.id IS NOT NULL
          OR (i.status = 'Opened')
          OR (i.status = 'Revealed' AND n.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd')) AS opened
  FROM node n
  LEFT JOIN public.pack_rips r ON r.pack_nft_id = n.pack_nft_id AND r.collection_id = n.collection_id
  LEFT JOIN public.pack_nft_identity i ON i.collection_id = n.collection_id AND i.pack_nft_id = n.pack_nft_id
  WHERE NOT n.has_children
),
pull_ids AS (
  -- Top Shot (and any collection whose pulls carry source_pack_rip_id)
  SELECT l.root, l.pack_nft_id, l.collection_id, ma.nft_id, NULL::uuid AS edition_id
  FROM leaf l
  JOIN public.moment_acquisitions ma
    ON ma.source_pack_rip_id = l.rip_id AND ma.collection_id = l.collection_id
  WHERE ma.acquisition_method = 'pack_pull'
    -- a pull arrives in the open transaction; a link to an acquisition from another tx is a mis-link
    -- (11-27: 2 of 27,501 links on sold packs -- an old moment bought 12 min before the open)
    AND (l.rip_tx IS NULL OR ma.transaction_hash IS NULL OR ma.transaction_hash = l.rip_tx)
  UNION
  -- the wallet walk and the open-tx reads
  SELECT l.root, l.pack_nft_id, l.collection_id, p.nft_id, p.edition_id
  FROM leaf l
  JOIN public.pack_open_pulls p
    ON p.collection_id = l.collection_id AND p.pack_nft_id = l.pack_nft_id
  UNION
  -- All Day
  SELECT l.root, l.pack_nft_id, l.collection_id, a.moment_nft_id, a.edition_id
  FROM leaf l
  JOIN public.allday_pack_pull a ON a.pack_nft_id = l.pack_nft_id
  WHERE l.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
),
pulls AS (
  -- one row per pulled moment; an edition named by any source wins over NULL
  SELECT root, pack_nft_id, collection_id, nft_id,
         (array_agg(edition_id) FILTER (WHERE edition_id IS NOT NULL))[1] AS edition_id
  FROM pull_ids
  GROUP BY root, pack_nft_id, collection_id, nft_id
),
named AS (
  SELECT p.root, p.nft_id,
         COALESCE(p.edition_id, m.edition_id) AS edition_id,
         m.serial_number
  FROM pulls p
  LEFT JOIN public.moments m ON m.collection_id = p.collection_id AND m.nft_id = p.nft_id
),
priced AS (
  SELECT n.root, n.nft_id, n.edition_id, n.serial_number,
         e.player_name, e.set_name, e.tier::text AS tier, e.circulation_count,
         CASE WHEN f.fmv_usd > 0 THEN f.fmv_usd END AS fmv_usd,
         e.subedition_name
  FROM named n
  LEFT JOIN public.editions e ON e.id = n.edition_id
  LEFT JOIN LATERAL (
    SELECT s.fmv_usd FROM public.fmv_snapshots s
    WHERE s.edition_id = n.edition_id
    ORDER BY s.computed_at DESC
    LIMIT 1
  ) f ON n.edition_id IS NOT NULL
),
per_root_pulls AS (
  SELECT root,
         count(*) AS pulls_ids,
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
           'parallel', subedition_name,
           'fmv_usd', round(fmv_usd::numeric, 2)
         ) ORDER BY fmv_usd DESC NULLS LAST, nft_id) AS pulls
  FROM priced
  GROUP BY root
),
per_root_leaves AS (
  SELECT root,
         count(*) AS leaves,
         count(*) FILTER (WHERE opened) AS leaves_opened,
         count(*) FILTER (WHERE opened AND moments_pulled IS NULL) AS leaves_opened_uncounted,
         sum(moments_pulled) AS moments_expected
  FROM leaf
  GROUP BY root
),
top AS (
  SELECT s.*,
         r.opener_address, r.sealed_at AS rip_at,
         i.status AS idx_status, i.owner_address AS idx_owner,
         d.metadata->>'pack_type' AS pack_type,
         EXISTS (SELECT 1 FROM public.pack_box_contents b
                  WHERE b.collection_id = s.collection_id AND b.box_pack_nft_id = s.pack_nft_id) AS is_container
  FROM sold s
  LEFT JOIN public.pack_rips r ON r.pack_nft_id = s.pack_nft_id AND r.collection_id = s.collection_id
  LEFT JOIN public.pack_nft_identity i ON i.collection_id = s.collection_id AND i.pack_nft_id = s.pack_nft_id
  LEFT JOIN public.pack_distributions_v d ON d.collection_id = s.collection_id AND d.dist_id = s.pack_dist_id
),
answer AS (
  SELECT t.*,
         (t.opener_address IS NOT NULL OR t.is_container
          OR t.idx_status = 'Opened'
          OR (t.idx_status = 'Revealed' AND t.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd')) AS opened,
         -- who opened it: the rip's opener, else the index owner of an Opened pack
         COALESCE(t.opener_address, CASE WHEN t.idx_status IN ('Opened', 'Revealed') THEN t.idx_owner END) AS opener,
         pl.leaves, pl.leaves_opened, pl.leaves_opened_uncounted, pl.moments_expected,
         pp.pulls_ids, pp.pulls_named, pp.pulls_priced, pp.fmv_sum, pp.pulls
  FROM top t
  LEFT JOIN per_root_leaves pl ON pl.root = t.pack_nft_id
  LEFT JOIN per_root_pulls pp ON pp.root = t.pack_nft_id
)
SELECT COALESCE(jsonb_agg(jsonb_build_object(
  'pack_nft_id', a.pack_nft_id,
  'sold_at', a.sold_at,
  'sale_price', a.sale_price,
  'opened', a.opened,
  'opened_at', a.rip_at,
  'opener_is_you', a.opener IS NOT NULL AND a.opener = (SELECT w FROM me),
  'opener_username', CASE WHEN a.opener IS NULL OR a.opener = (SELECT w FROM me) THEN NULL
                          ELSE COALESCE(wu.username, up.username) END,
  'is_container', a.is_container,
  'packs_inside', CASE WHEN a.is_container THEN a.leaves END,
  'packs_opened', CASE WHEN a.is_container THEN a.leaves_opened END,
  -- a box/case writes no rip when opened (after ~2026-07-11), so with no rip, no known contents and an
  -- index that does not say Sealed, whether it was opened is NOT known -- never "not opened yet"
  'open_status_unknown', COALESCE(NOT a.opened AND a.opener_address IS NULL AND a.pack_type IN ('box', 'case')
                                  AND a.idx_status IS DISTINCT FROM 'Sealed', false),
  -- an open is known but nothing it yielded is (a container opened after July, a pack with no pull on
  -- record -- e.g. a Top Shot rip before 2025-10, whose block no live Flow node can read)
  'contents_unknown', a.opened AND COALESCE(a.pulls_ids, 0) = 0 AND NOT a.is_container,
  'moments_pulled', a.moments_expected,
  'pulls_named', COALESCE(a.pulls_named, 0),
  'pulls_priced', COALESCE(a.pulls_priced, 0),
  -- all-or-nothing: every pack (inner pack, for a box or case) opened and counted, every pull named
  -- and priced, and as many pulls as the rips say they yielded
  'pull_value_usd', CASE WHEN a.opened AND a.leaves_opened = a.leaves AND a.leaves_opened_uncounted = 0
                              AND a.moments_expected IS NOT NULL
                              AND a.pulls_priced = a.moments_expected AND a.pulls_ids = a.moments_expected
                         THEN round(a.fmv_sum::numeric, 2) END,
  'pulls', COALESCE(a.pulls, '[]'::jsonb)
) ORDER BY a.sold_at DESC), '[]'::jsonb)
FROM answer a
LEFT JOIN public.wallet_usernames wu ON wu.wallet_addr = a.opener
LEFT JOIN LATERAL (
  SELECT u.username FROM public.user_profiles u WHERE u.wallet_address = a.opener LIMIT 1
) up ON a.opener IS NOT NULL;
$fn$;

COMMENT ON FUNCTION public.get_wallet_sold_pack_outcomes(text, text[]) IS
  'Binder Sold tab (2026-11-27, v4): for packs p_wallet SOLD sealed (on-chain storefront or Dapper marketplace history), who opened them, when, and every pull at current FMV (all-or-nothing, fmv > 0); a box or case answers with its inner packs'' pulls. Reader only.';
REVOKE EXECUTE ON FUNCTION public.get_wallet_sold_pack_outcomes(text, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_wallet_sold_pack_outcomes(text, text[]) TO service_role;

CREATE OR REPLACE FUNCTION public.dispatch_sold_pack_open_tx_reads(p_max integer DEFAULT 30)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  x record;
  v_n integer := 0;
BEGIN
  FOR x IN
    WITH RECURSIVE sold AS (
      SELECT pp.pack_nft_id
        FROM public.pack_purchases pp
       WHERE pp.collection_id = v_ts
         AND pp.pack_nft_id IS NOT NULL
         AND pp.custom_id IS DISTINCT FROM 'nba'
         AND pp.seller_address IN (SELECT DISTINCT wallet_addr FROM public.saved_wallets)
      UNION
      SELECT h.pack_nft_id
        FROM public.topshot_pack_sales_history h
       WHERE h.purchased
         AND h.storefront_address IN (SELECT DISTINCT wallet_addr FROM public.saved_wallets)
    ), scope(pack_nft_id, depth) AS (
      SELECT pack_nft_id, 0 FROM sold
      UNION
      SELECT b.pack_nft_id, s.depth + 1
        FROM scope s
        JOIN public.pack_box_contents b ON b.collection_id = v_ts AND b.box_pack_nft_id = s.pack_nft_id
       WHERE s.depth < 2
    )
    SELECT DISTINCT r.pack_nft_id, r.tx_hash, r.opener_address, r.block_height
      FROM (SELECT DISTINCT pack_nft_id FROM scope) s
      -- LATERAL keeps this a per-id probe of pack_rips' unique pack_nft_id index; a plain join
      -- planned a hash over every Top Shot rip and ran past the 60 s budget (measured 11-27)
      CROSS JOIN LATERAL (SELECT r0.* FROM public.pack_rips r0
                           WHERE r0.pack_nft_id = s.pack_nft_id AND r0.collection_id = v_ts
                           LIMIT 1) r
     WHERE r.tx_hash ~ '^[0-9a-f]{64}$'
       -- mainnet27 root: older blocks have no live Flow node (#181), so they are not asked
       AND r.block_height >= 130290659
       AND r.opener_address ~ '^0x[0-9a-f]{16}$'
       AND NOT EXISTS (SELECT 1 FROM public.moment_acquisitions ma
                        WHERE ma.source_pack_rip_id = r.id AND ma.collection_id = v_ts)
       AND NOT EXISTS (SELECT 1 FROM public.pack_open_pulls o
                        WHERE o.collection_id = v_ts AND o.pack_nft_id = r.pack_nft_id)
       AND NOT EXISTS (SELECT 1 FROM public.pack_box_contents b
                        WHERE b.collection_id = v_ts AND b.box_pack_nft_id = r.pack_nft_id)
       AND NOT EXISTS (SELECT 1 FROM public.sold_pack_open_tx_reads q
                        WHERE q.pack_nft_id = r.pack_nft_id
                          AND (q.outcome IS NULL OR q.outcome NOT IN ('no_response') ))
     LIMIT GREATEST(p_max, 0)
  LOOP
    INSERT INTO public.sold_pack_open_tx_reads (pack_nft_id, collection_id, tx_hash, opener_address, request_id, dispatched_at)
    VALUES (x.pack_nft_id, v_ts, x.tx_hash, x.opener_address,
            net.http_get(CASE WHEN x.block_height <= 137390145
                              THEN 'http://access-001.mainnet27.nodes.onflow.org:8070'
                              ELSE 'https://rest-mainnet.onflow.org' END
                         || '/v1/transaction_results/' || x.tx_hash,
                         timeout_milliseconds := 20000),
            now())
    ON CONFLICT (pack_nft_id) DO UPDATE
      SET request_id = EXCLUDED.request_id, dispatched_at = now(), collected_at = NULL, outcome = NULL, n_written = NULL;
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END
$fn$;

CREATE OR REPLACE FUNCTION public.run_sold_pack_open_tx_reads()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '60s'
AS $fn$
DECLARE
  v_collect jsonb; v_dispatched integer; v_err text;
  v_wallets text[]; v_names integer := 0;
BEGIN
  BEGIN
    v_collect := public.collect_sold_pack_open_tx_reads();
    v_dispatched := public.dispatch_sold_pack_open_tx_reads(60);

    -- openers of sold packs with no username on record: one Atlas profile batch (<= 25) per tick,
    -- dispatched into member_wallet_username_requests so resolve_member_wallet_usernames_via_atlas
    -- (pg_cron rpc-member-wallet-usernames-atlas) collects it and writes wallet_usernames -- only when
    -- that lane has nothing in flight, so it never doubles its request rate
    IF NOT EXISTS (SELECT 1 FROM public.member_wallet_username_requests WHERE drained_at IS NULL) THEN
      SELECT array_agg(w ORDER BY w) INTO v_wallets
        FROM (
          SELECT o.w
            FROM (
              SELECT r.opener_address AS w
                FROM (SELECT pp.pack_nft_id
                        FROM public.pack_purchases pp
                       WHERE pp.pack_nft_id IS NOT NULL AND pp.custom_id IS DISTINCT FROM 'nba'
                         AND pp.seller_address IN (SELECT DISTINCT wallet_addr FROM public.saved_wallets)
                      UNION
                      SELECT h.pack_nft_id FROM public.topshot_pack_sales_history h
                       WHERE h.purchased AND h.storefront_address IN (SELECT DISTINCT wallet_addr FROM public.saved_wallets)
                      UNION
                      SELECT h.pack_nft_id FROM public.allday_pack_sales_history h
                       WHERE h.purchased AND h.storefront_address IN (SELECT DISTINCT wallet_addr FROM public.saved_wallets)) s
                CROSS JOIN LATERAL (SELECT r0.opener_address FROM public.pack_rips r0
                                     WHERE r0.pack_nft_id = s.pack_nft_id LIMIT 1) r
              UNION
              SELECT opener_address FROM public.sold_container_open_search
            ) o
            LEFT JOIN public.wallet_usernames wu ON wu.wallet_addr = o.w
           WHERE o.w ~ '^0x[0-9a-f]{16}$'
             AND (wu.wallet_addr IS NULL
                  OR (wu.username IS NULL AND (wu.last_attempted_at IS NULL OR wu.last_attempted_at < now() - interval '14 days')))
           ORDER BY o.w
           LIMIT 25
        ) c;
      IF v_wallets IS NOT NULL THEN
        INSERT INTO public.member_wallet_username_requests (request_id, wallets)
        VALUES (net.http_post(
                  url := 'https://api.production.atlas.dapperlabs.com/public/atlas.v1.ProfileService/SearchUserProfiles',
                  body := jsonb_build_object('product', 'nba', 'flow_addresses', to_jsonb(v_wallets)),
                  headers := public.atlas_market_headers('nba'),
                  timeout_milliseconds := 15000),
                v_wallets);
        v_names := cardinality(v_wallets);
      END IF;
    END IF;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_err := left(SQLERRM, 300);
  END;
  PERFORM public.log_pipeline_run('sold-pack-open-tx-reads', v_err IS NULL,
    jsonb_build_object('collect', v_collect, 'dispatched', v_dispatched, 'opener_names_asked', v_names,
                       'error', v_err, 'via', 'pg_cron'));
  RETURN jsonb_build_object('collect', v_collect, 'dispatched', v_dispatched, 'opener_names_asked', v_names, 'error', v_err);
END
$fn$;

CREATE OR REPLACE FUNCTION public.run_sold_container_open_search(p_max integer DEFAULT 20)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '60s'
AS $fn$
DECLARE
  v_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_win constant integer := 250;
  v_cap constant integer := 40;
  x record;
  v_hit record;
  v_new integer := 0; v_found integer := 0; v_sent integer := 0; v_err text;
BEGIN
  BEGIN
    -- (1) enrol new containers
    WITH ins AS (
      INSERT INTO public.sold_container_open_search
        (pack_nft_id, collection_id, opener_address, sale_block, anchor_block, direction, next_start)
      SELECT c.pack_nft_id, v_ts, c.opener, c.sale_bh, c.anchor,
             CASE WHEN c.anchor IS NULL THEN 'forward' ELSE 'back' END,
             CASE WHEN c.anchor IS NULL THEN c.sale_bh ELSE GREATEST(c.anchor - v_win + 1, c.sale_bh) END
        FROM (
          SELECT s.pack_nft_id, s.sale_bh, COALESCE(i.owner_address, s.buyer_address) AS opener,
                 (SELECT min(r.block_height)
                    FROM public.pack_rips r
                    JOIN public.pack_container_recipes pc
                      ON pc.collection_id = r.collection_id AND pc.inner_dist_id = r.dist_id
                     AND pc.container_dist_id = s.pack_dist_id
                   WHERE r.collection_id = v_ts AND r.opener_address = COALESCE(i.owner_address, s.buyer_address)
                     AND r.block_height > s.sale_bh) AS anchor
            FROM (SELECT DISTINCT ON (u.pack_nft_id) u.pack_nft_id, u.pack_dist_id, u.sale_bh, u.buyer_address
                    FROM (SELECT pp.pack_nft_id, pp.pack_dist_id, pp.block_height AS sale_bh, pp.buyer_address, pp.sealed_at AS at
                            FROM public.pack_purchases pp
                           WHERE pp.collection_id = v_ts AND pp.pack_nft_id IS NOT NULL
                             AND pp.custom_id IS DISTINCT FROM 'nba'
                             AND pp.seller_address IN (SELECT DISTINCT wallet_addr FROM public.saved_wallets)
                          UNION ALL
                          SELECT h.pack_nft_id, h.dist_id, h.block_height, h.buyer_address, h.block_time
                            FROM public.topshot_pack_sales_history h
                           WHERE h.purchased
                             AND h.storefront_address IN (SELECT DISTINCT wallet_addr FROM public.saved_wallets)) u
                   ORDER BY u.pack_nft_id, u.at DESC) s
            LEFT JOIN public.pack_nft_identity i ON i.collection_id = v_ts AND i.pack_nft_id = s.pack_nft_id
            JOIN public.pack_distributions_v d ON d.collection_id = v_ts AND d.dist_id = s.pack_dist_id
           -- index-confirmed opens, and boxes whose index status is unknown (not 'Sealed'): for those the
           -- last buyer stands in for the opener, and a search that finds nothing ends 'exhausted'
           WHERE i.status IS DISTINCT FROM 'Sealed'
             AND COALESCE(i.owner_address, s.buyer_address) ~ '^0x[0-9a-f]{16}$'
             AND d.metadata->>'pack_type' IN ('box', 'case')
             AND s.sale_bh IS NOT NULL
             -- the events endpoint answers the current spork only; container opens with no rip are all
             -- after ~2026-07-11, so an older sale cannot be one of them
             AND s.sale_bh >= 137390146
             AND NOT EXISTS (SELECT 1 FROM public.pack_rips r WHERE r.pack_nft_id = s.pack_nft_id)
             AND NOT EXISTS (SELECT 1 FROM public.pack_box_contents b
                              WHERE b.collection_id = v_ts AND b.box_pack_nft_id = s.pack_nft_id)
        ) c
      ON CONFLICT (pack_nft_id) DO NOTHING
      RETURNING 1)
    SELECT count(*) INTO v_new FROM ins;

    -- (2) read answered windows
    FOR x IN
      SELECT q.*, h.status_code, h.content, (h.id IS NULL) AS gone
        FROM public.sold_container_open_search q
        LEFT JOIN net._http_response h ON h.id = q.request_id
       WHERE q.outcome IS NULL AND q.request_id IS NOT NULL
         AND (h.id IS NOT NULL OR q.updated_at < now() - interval '30 minutes')
    LOOP
      IF x.gone THEN
        UPDATE public.sold_container_open_search SET request_id = NULL, updated_at = now() WHERE pack_nft_id = x.pack_nft_id;
        CONTINUE;  -- re-ask the same window
      END IF;
      IF x.status_code IS DISTINCT FROM 200 THEN
        UPDATE public.sold_container_open_search SET outcome = 'http_' || coalesce(x.status_code::text, 'none'), updated_at = now()
         WHERE pack_nft_id = x.pack_nft_id;
        CONTINUE;
      END IF;
      SELECT blk->>'block_height' AS bh, ev->>'transaction_id' AS tx INTO v_hit
        FROM jsonb_array_elements(x.content::jsonb) blk
        CROSS JOIN LATERAL jsonb_array_elements(coalesce(blk->'events', '[]'::jsonb)) ev
       WHERE convert_from(decode(ev->>'payload', 'base64'), 'UTF8')::jsonb->'value'->'fields'->0->'value'->>'value' = x.pack_nft_id
       LIMIT 1;
      IF v_hit.tx IS NOT NULL THEN
        UPDATE public.sold_container_open_search
           SET outcome = 'found', open_tx = v_hit.tx, open_block = v_hit.bh::bigint, request_id = NULL, updated_at = now()
         WHERE pack_nft_id = x.pack_nft_id;
        INSERT INTO public.sold_pack_open_tx_reads (pack_nft_id, collection_id, tx_hash, opener_address, request_id, dispatched_at)
        VALUES (x.pack_nft_id, v_ts, v_hit.tx, x.opener_address,
                net.http_get('https://rest-mainnet.onflow.org/v1/transaction_results/' || v_hit.tx, timeout_milliseconds := 20000),
                now())
        ON CONFLICT (pack_nft_id) DO NOTHING;
        v_found := v_found + 1;
      ELSE
        UPDATE public.sold_container_open_search
           SET request_id = NULL, windows = windows + 1, updated_at = now(),
               next_start = CASE WHEN direction = 'back' THEN next_start - v_win ELSE next_start + v_win END,
               outcome = CASE
                 WHEN windows + 1 >= v_cap THEN 'exhausted'
                 WHEN direction = 'back' AND next_start <= sale_block THEN 'below_sale'
                 END
         WHERE pack_nft_id = x.pack_nft_id;
      END IF;
    END LOOP;

    -- (2b) a backward walk that reached the sale block (or its cap) without the open: the anchor rip
    -- belonged to another box of the same drop, so this box opened AFTER it -- walk forward from the
    -- anchor instead, once (direction 'forward' never turns back)
    UPDATE public.sold_container_open_search
       SET direction = 'forward', next_start = anchor_block + 1, windows = 0, outcome = NULL,
           request_id = NULL, updated_at = now()
     WHERE direction = 'back' AND outcome IN ('below_sale', 'exhausted') AND anchor_block IS NOT NULL;

    -- (3) ask the next window of each open search
    FOR x IN
      SELECT * FROM public.sold_container_open_search
       WHERE outcome IS NULL AND request_id IS NULL
       ORDER BY windows, pack_nft_id
       LIMIT GREATEST(p_max, 0)
    LOOP
      UPDATE public.sold_container_open_search
         SET req_start = GREATEST(x.next_start, x.sale_block),
             request_id = net.http_get(
               'https://rest-mainnet.onflow.org/v1/events?type=A.0b2a3299cc857e29.PackNFT.Opened'
               || '&start_height=' || GREATEST(x.next_start, x.sale_block)
               || '&end_height=' || (GREATEST(x.next_start, x.sale_block) + v_win - 1),
               timeout_milliseconds := 20000),
             updated_at = now()
       WHERE pack_nft_id = x.pack_nft_id;
      v_sent := v_sent + 1;
    END LOOP;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_err := left(SQLERRM, 300);
  END;
  PERFORM public.log_pipeline_run('sold-container-open-search', v_err IS NULL,
    jsonb_build_object('enrolled', v_new, 'found', v_found, 'windows_sent', v_sent, 'error', v_err, 'via', 'pg_cron'));
  RETURN jsonb_build_object('enrolled', v_new, 'found', v_found, 'windows_sent', v_sent, 'error', v_err);
END
$fn$;

REVOKE ALL ON FUNCTION public.dispatch_sold_pack_open_tx_reads(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.run_sold_pack_open_tx_reads() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.run_sold_container_open_search(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_sold_pack_open_tx_reads(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.run_sold_pack_open_tx_reads() TO service_role;
GRANT EXECUTE ON FUNCTION public.run_sold_container_open_search(integer) TO service_role;
