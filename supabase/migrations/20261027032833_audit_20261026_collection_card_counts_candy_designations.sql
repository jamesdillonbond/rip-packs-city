-- audit_20261026: the wallet collection card counts Candy MLB's designations as badges.
--
-- /share/<wallet> (and every consumer of /api/collection-snapshot) printed "1624 moments · 0 badges" for a
-- Candy collector holding 111 designated cards: get_wallet_collection_snapshot's `badges` CTE counts held
-- editions in badge_editions, which holds Top Shot rows only. Candy's designations — editions.badges 'Rookie' /
-- 'First Mint', from Candy's published checklist, the same ones the Market tab's Badges filter and (since
-- 20261027031432) the Analytics Badge Premium read — are now added: distinct HELD Candy editions carrying one.
-- The Rainbow colours ('Rainbow (…)') are the parallel, not a designation. The badge_editions arm is
-- byte-for-byte the old count. Everything else in the body is unchanged (live prosrc md5 verified before:
-- c8f50fcef1d3a909ca4387fd712d11e5).
--
-- anon-exec: unchanged (get_wallet_collection_snapshot) — CREATE OR REPLACE of an existing fn; ACL preserved (postgres + service_role only).
--
-- Revert: re-apply this body with the `badges` CTE back to its single badge_editions count (the md5 above).

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
  EXECUTE $q$
  WITH w AS (
    SELECT player_name, set_name, tier, serial_number, edition_key,
           image_url, series_number, fmv_usd, mint_count, collection_id
    FROM wallet_moments_cache
    WHERE wallet_address = $1
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
