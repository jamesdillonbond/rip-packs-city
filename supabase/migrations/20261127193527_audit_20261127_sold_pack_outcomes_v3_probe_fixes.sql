-- audit_20261127_sold_pack_outcomes_v3_probe_fixes
--
-- 2026-11-27 (PT, midday; Claude Code cloud; Trevor: "Keep digging and probing").
-- Bases (same day): reader 20261127185407_audit_20261127_sold_pack_outcomes_v2_containers.sql,
-- lane runner 20261127184816_audit_20261127_sold_pack_open_tx_reads.sql.
--
-- Probing every pack saved wallets sold through the v2 reader found:
--   1. A MIS-LINKED PULL. Pack 237494514047637 listed 6 pulls for a 4-moment rip: two
--      moment_acquisitions rows linked to its rip (source_pack_rip_id) came from OTHER transactions
--      12 minutes before the open -- one an old Series 1 moment (#4227). 2 of 27,501 links on sold
--      packs (the last 14 days estate-wide: 0 of 74,178), so the reader now requires a linked
--      acquisition to share the rip's tx. The link itself is upstream data, left as is.
--   2. A $0 SNAPSHOT counted as priced. pack_open_pull_values (the binder's Opened tab) prices a pull
--      only when fmv_usd > 0; the reader now uses the same rule (0 such pulls today -- a guard).
--   3. PARALLELS were unnamed. 3,951 of 26,955 sold-pack pulls are Top Shot parallels (all on their
--      ::sub edition, so priced right); the pull JSON now carries `parallel` (editions.subedition_name,
--      NULL for the Standard printing).
--   4. 80 OPENERS had no username on record, so the page said "Another collector". The runner now
--      asks Atlas SearchUserProfiles for up to 25 of them a tick, through the member username lane's
--      own request table (that lane collects the answer and writes wallet_usernames).
--
-- REVERT: re-apply both function bodies from their base files named above.

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
sold AS (
  -- only packs this wallet sold; the latest sale of each is the one that let it go
  SELECT DISTINCT ON (pp.pack_nft_id)
         pp.pack_nft_id, pp.collection_id, pp.pack_dist_id, pp.sale_price, pp.sealed_at AS sold_at
  FROM ids
  JOIN public.pack_purchases pp ON pp.pack_nft_id = ids.pack_nft_id
  WHERE pp.seller_address = (SELECT w FROM me)
  ORDER BY pp.pack_nft_id, pp.sealed_at DESC
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
  -- an open is known but nothing it yielded is (a container opened after July, or a pack with no pull on record)
  'contents_unknown', a.opened AND COALESCE(a.pulls_ids, 0) = 0 AND NOT a.is_container
                      AND a.moments_expected IS NULL,
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
  'Binder Sold tab (2026-11-27, v3): for packs p_wallet SOLD sealed, who opened them, when, and every pull at current FMV (all-or-nothing total, fmv > 0); a box or case answers with its inner packs'' pulls; pulls carry their parallel. Reader only.';
REVOKE EXECUTE ON FUNCTION public.get_wallet_sold_pack_outcomes(text, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_wallet_sold_pack_outcomes(text, text[]) TO service_role;

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
    v_dispatched := public.dispatch_sold_pack_open_tx_reads(30);

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
                FROM (SELECT DISTINCT pp.pack_nft_id
                        FROM public.pack_purchases pp
                       WHERE pp.pack_nft_id IS NOT NULL AND pp.custom_id IS DISTINCT FROM 'nba'
                         AND pp.seller_address IN (SELECT DISTINCT wallet_addr FROM public.saved_wallets)) s
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

REVOKE ALL ON FUNCTION public.run_sold_pack_open_tx_reads() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_sold_pack_open_tx_reads() TO service_role;
