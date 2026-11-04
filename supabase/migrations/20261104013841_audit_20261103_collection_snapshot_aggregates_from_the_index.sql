-- audit_20261103_collection_snapshot_aggregates_from_the_index (known-issues #228)
--
-- 2026-11-03 ~5:25–5:45 PM PT (Claude Code cloud; Trevor: "work autonomously … fix any issues you encounter").
--
-- WHAT WAS WRONG. /api/collection-snapshot timed out (RPC_READ_TIMEOUT, 8 s) for the largest wallets whenever
-- their rows were cache-cold: Vercel error group 7 hits / 5 users since 09-11, last 11-03 3:40 PM PT. The
-- body's `w` CTE read TEN wmc columns per moment (names, image, serial …), so it touched every heap page the
-- wallet's rows sit on — the largest wallet (0xb7700366fa738a43, 70,280 rows) spans ~47k heap pages:
-- 11.3 s cold / 685 ms warm (#228), and the wide CTE spilled 14,770 temp blocks.
--
-- CHANGE. `w` now reads only (collection_id, edition_key, fmv_usd, series_number, mint_count) — every
-- aggregate (totals, per-collection, stale split, badges, series bars, the rarest SORT KEY) comes from an
-- index-only scan of the new covering index below. The wide display columns are read from the heap only for
-- the top-5 editions (top_keys) and the one rarest edition (rare_key):
--   * top 5 moments by FMV ⊆ rows of the top 5 editions by max(FMV) — an edition outside those has a max no
--     higher than the 5th moment, so it cannot place;
--   * the rarest moment is fetched by its exact (collection, edition, mint_count, fmv) key.
-- Display rows are fetched through two arms (edition_key = k / both NULL) rather than one OR: the OR dropped
-- collection_id from the index condition and probed the wallet's whole index range per key (measured).
--
-- MEASURED (same instrument, EXPLAIN ANALYZE BUFFERS, the 70,280-row wallet, 11-03 ~5:35 PM PT):
--   live body  75,236 buffers + 14,770 temp blocks, 762 ms (warm)
--   new body   44,933 buffers,     0 temp blocks, 470 ms; `w` = Index Only Scan on the new cover,
--              Heap Fetches 14,259 (pages the 10-min FMV refresh had just dirtied; 0 and 3,522 on two
--              earlier reads) — a cold read touches those pages, not all ~47k.
-- EQUIVALENCE (pg_temp copy of the new body vs the live function, 30 seeded wallets / 57,455 moments, one
-- statement snapshot): every field except topMoments/rarest byte-identical 30/30; the top-5 FMV sequence
-- identical 30/30; the rarest (mintCount, fmv) identical 30/30. The 6 top-5 / 1 rarest differences are
-- which moment is shown among EQUAL-FMV ties — the old ORDER BY was equally arbitrary there.
-- NULL edition_key: 1 wmc row estate-wide (no fmv, no mint) — handled anyway by the IS NULL arm.
--
-- INDEX (executed 11-03 ~5:33 PM PT via execute_sql, finished inside the client's 60 s; indisvalid=true, 189 MB):
--   CREATE INDEX CONCURRENTLY idx_wmc_wallet_coll_ek_snap_cover ON public.wallet_moments_cache
--     USING btree (wallet_address, collection_id, edition_key) INCLUDE (fmv_usd, tier, series_number, mint_count);
-- It is a strict SUPERSET of idx_wmc_wallet_coll_ek_fmv_tier (same keys, INCLUDE (fmv_usd, tier)), which reads
-- 335 MB. Recorded here, NOT re-issued: a non-concurrent CREATE INDEX IF NOT EXISTS in a migration transaction
-- takes a ShareLock on wmc (the hottest write table) before it finds the name. FOLLOW-UP (staged, needs a
-- destructive-statement approval — docs/proposals/wmc-snapshot-cover-index-swap-STAGED.sql): drop the old index
-- CONCURRENTLY and rename the new one onto its name, so the weekly reindex job (rpc-weekly-wmc-reindex-*) and
-- run_wmc_reindex_verify() — which target that NAME — keep covering it.
--
-- anon-exec: unchanged (get_wallet_collection_snapshot) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved (postgres + service_role only).
--
-- Base verified 11-03 ~5:27 PM PT: live prosrc read via pg_proc and compared with the body of
-- 20261027032833_audit_20261026_collection_card_counts_candy_designations.sql (the newest migration defining it);
-- the new body was built from that file's verbatim block (the DB-invariant pin's copy).
--
-- REVERT: re-apply the get_wallet_collection_snapshot block of
--   20261027032833_audit_20261026_collection_card_counts_candy_designations.sql verbatim. The index can stay
--   (it only adds a covering option) or be dropped: DROP INDEX CONCURRENTLY IF EXISTS public.idx_wmc_wallet_coll_ek_snap_cover;

CREATE OR REPLACE FUNCTION public.get_wallet_collection_snapshot(p_wallet text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v jsonb;
BEGIN
  -- 2026-10-02: dynamic SQL on purpose. EXECUTE … USING plans the statement with the
  -- wallet's REAL row estimate, so an 18k-moment wallet gets hash joins where the
  -- SQL-language body's generic plan gave it per-row nested loops (744k buffers).
  -- 2026-11-03 (#228): `w` reads ONLY columns carried by the wallet covering index
  -- (wallet_address, collection_id, edition_key) INCLUDE (fmv_usd, tier, series_number,
  -- mint_count), so every aggregate is an index-only scan. The wide display columns
  -- (names, image, serial) are read from the heap for the top-5 / rarest EDITIONS only.
  -- The largest wallet's rows sit on ~47k heap pages: 11.3 s cold, 8 s route timeout.
  EXECUTE $q$
  WITH w AS (
    SELECT collection_id, edition_key, fmv_usd, series_number, mint_count
    FROM wallet_moments_cache
    WHERE wallet_address = $1
  ),
  -- The top 5 moments by FMV all belong to the top 5 editions by max FMV (an edition
  -- outside them has a max no higher than the 5th moment), so only those editions'
  -- rows are fetched for display.
  top_keys AS (
    SELECT collection_id, edition_key
    FROM w
    WHERE fmv_usd IS NOT NULL AND fmv_usd > 0
    GROUP BY collection_id, edition_key
    ORDER BY max(fmv_usd) DESC
    LIMIT 5
  ),
  top5 AS (
    SELECT jsonb_agg(t) AS arr FROM (
      SELECT m.player_name AS "playerName",
             m.set_name    AS "setName",
             m.tier,
             m.serial_number AS serial,
             round(COALESCE(m.fmv_usd, 0)::numeric, 2) AS fmv,
             m.image_url   AS "thumbnailUrl"
      FROM (
        -- Two arms, not one OR: an OR on edition_key drops collection_id from the
        -- index condition and probes the whole wallet's index range per key.
        SELECT m.player_name, m.set_name, m.tier, m.serial_number, m.fmv_usd, m.image_url
        FROM top_keys k
        JOIN wallet_moments_cache m
          ON m.wallet_address = $1 AND m.collection_id = k.collection_id AND m.edition_key = k.edition_key
        UNION ALL
        SELECT m.player_name, m.set_name, m.tier, m.serial_number, m.fmv_usd, m.image_url
        FROM top_keys k
        JOIN wallet_moments_cache m
          ON m.wallet_address = $1 AND m.collection_id = k.collection_id AND m.edition_key IS NULL
        WHERE k.edition_key IS NULL
      ) m
      WHERE m.fmv_usd IS NOT NULL AND m.fmv_usd > 0
      ORDER BY m.fmv_usd DESC
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
    -- 2026-10-02: labelled per DISTINCT (collection, series_number), not per
    -- moment — series_display_label ran 38,666 times (77k buffers) on one wallet
    -- for 8 distinct values.
    SELECT min(d.series_number) AS series_number,
           COALESCE(public.series_display_label(d.collection_id, d.series_number::int), 'SUnknown') AS label,
           sum(d.cnt)::int AS cnt
    FROM (
      SELECT w.collection_id, w.series_number, count(*) AS cnt
      FROM w
      WHERE w.collection_id = (SELECT collection_id FROM series_coll)
      GROUP BY w.collection_id, w.series_number
    ) d
    GROUP BY d.collection_id, COALESCE(public.series_display_label(d.collection_id, d.series_number::int), 'SUnknown')
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
    SELECT ((
      SELECT count(DISTINCT be.external_id)
      FROM badge_editions be
      WHERE be.external_id IN (SELECT DISTINCT edition_key FROM w WHERE edition_key IS NOT NULL)
    ) + (
      -- 2026-10-26: Candy MLB's designations (editions.badges 'Rookie' / 'First Mint', from Candy's
      -- checklist; the Rainbow colours are the parallel, not a designation). badge_editions holds no
      -- Candy rows, so a Candy card read "0 badges" beside 111 designated cards.
      SELECT count(DISTINCT e.external_id)
      FROM editions e
      WHERE e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
        AND e.badges && ARRAY['Rookie', 'First Mint']::text[]
        AND e.external_id IN (SELECT DISTINCT w.edition_key FROM w
                               WHERE w.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid)
    ))::int AS c
  ),
  -- 2026-10-02: each held edition's CURRENT confidence, resolved ONCE per distinct
  -- (edition_key, collection) instead of a LATERAL probe per moment (58k buffers
  -- on one wallet). editions(external_id, collection_id) is unique, so this is the
  -- same row the LIMIT 1 probe returned.
  conf AS (
    SELECT e.external_id AS edition_key, e.collection_id, l.confidence
    FROM editions e
    JOIN edition_fmv_current l ON l.edition_id = e.id
    WHERE (e.external_id, e.collection_id) IN (
      SELECT DISTINCT w.edition_key, w.collection_id FROM w WHERE w.edition_key IS NOT NULL
    )
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
      LEFT JOIN conf l ON l.edition_key = w.edition_key AND l.collection_id = w.collection_id
      GROUP BY c.slug, c.name, c.market_closed_at
    ) x
  ),
  -- 2026-09-04: stale split, so the front door can headline total − stale like the profile
  stale AS (
    SELECT
      round(COALESCE(sum(w.fmv_usd) FILTER (
        WHERE w.collection_id NOT IN (SELECT id FROM collections WHERE market_closed_at IS NOT NULL)
      ), 0)::numeric, 2) AS stale_fmv,
      -- 2026-09-25: the COUNT pairs with the AMOUNT — a closed market's STALE
      -- holdings are outside both, or the card says "$6,419 across 227" when
      -- 191 of the 227 are UFC moments whose dollars the figure excludes.
      count(*) FILTER (
        WHERE w.collection_id NOT IN (SELECT id FROM collections WHERE market_closed_at IS NOT NULL)
      )::int AS stale_count
    FROM w
    JOIN conf l ON l.edition_key = w.edition_key AND l.collection_id = w.collection_id
    WHERE l.confidence = 'STALE'
  ),
  -- The rarest moment's sort key (smallest positive mint, FMV-desc tiebreak) is read
  -- from `w`; its display row is then fetched from that one edition.
  rare_key AS (
    SELECT collection_id, edition_key, mint_count, fmv_usd
    FROM w
    WHERE mint_count IS NOT NULL AND mint_count > 0
    ORDER BY mint_count ASC, fmv_usd DESC NULLS LAST
    LIMIT 1
  ),
  rarest AS (
    SELECT to_jsonb(r) AS obj FROM (
      SELECT m.player_name AS "playerName",
             m.set_name    AS "setName",
             m.tier,
             m.serial_number AS serial,
             m.mint_count  AS "mintCount",
             round(COALESCE(m.fmv_usd, 0)::numeric, 2) AS fmv,
             m.image_url   AS "thumbnailUrl"
      FROM (
        SELECT m.player_name, m.set_name, m.tier, m.serial_number, m.mint_count, m.fmv_usd, m.image_url
        FROM rare_key k
        JOIN wallet_moments_cache m
          ON m.wallet_address = $1 AND m.collection_id = k.collection_id AND m.edition_key = k.edition_key
        WHERE m.mint_count = k.mint_count AND m.fmv_usd IS NOT DISTINCT FROM k.fmv_usd
        UNION ALL
        SELECT m.player_name, m.set_name, m.tier, m.serial_number, m.mint_count, m.fmv_usd, m.image_url
        FROM rare_key k
        JOIN wallet_moments_cache m
          ON m.wallet_address = $1 AND m.collection_id = k.collection_id AND m.edition_key IS NULL
        WHERE k.edition_key IS NULL
          AND m.mint_count = k.mint_count AND m.fmv_usd IS NOT DISTINCT FROM k.fmv_usd
      ) m
      LIMIT 1
    ) r
  )
  SELECT jsonb_build_object(
    'wallet', $1,
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
  )
  $q$ INTO v USING p_wallet;
  RETURN v;
END
$function$;
