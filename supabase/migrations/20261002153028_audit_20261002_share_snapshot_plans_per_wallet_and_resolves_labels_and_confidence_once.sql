-- audit_20261002_share_snapshot_plans_per_wallet_and_resolves_labels_and_confidence_once
--
-- 2026-10-02 ~9:15 AM PT (Claude Code, cloud, autonomous pass). Sibling of 20261002152419
-- (get_wallet_intel_summary), the other RPC behind the /share/[wallet] card.
--
-- WHAT WAS WRONG. `get_wallet_collection_snapshot(p_wallet)` is the read behind /share/[wallet]
-- and its OG card. Two bursts of `[api/collection-snapshot/get_wallet_collection_snapshot] read
-- exceeded 8000ms` (00:50 and 02:08 AM PT) came from one whale's share-card load. Measured on
-- Rigged (0xf77bf547fccf6656, 43,366 cache rows across 5 collections), EXPLAIN (ANALYZE, BUFFERS):
--     SELECT get_wallet_collection_snapshot(…) ........ 744,517 buffers · 2,178 ms (+11,272 temp)
--     the same body as a statement, wallet written in . 178,715 buffers · 1,748 ms
-- Three costs, all shape not data:
--   1. GENERIC PLAN. Inside the SQL-language function the wallet is a parameter; the planner
--      estimates a typical wallet and joins editions / edition_fmv_current / collection_series
--      by per-row nested loops. 4.2× the buffers of the plan it picks when it knows the wallet.
--   2. LABELS PER MOMENT. `series_rows` called series_display_label() once per cache row —
--      38,666 calls for 8 distinct (collection, series) values — 77,546 buffers.
--   3. CONFIDENCE PER MOMENT. `per_coll` resolved each moment's current FMV confidence through a
--      LATERAL editions → edition_fmv_current probe (memoized, still 8,304 misses · 58,084
--      buffers); `stale` repeated the same join.
--
-- WHAT THIS DOES (the pin supabase/tests/get_wallet_collection_snapshot.sql carries this DDL
-- VERBATIM and its eight invariants still pass on it, locally and in CI):
--   * plpgsql wrapper, body unchanged in shape, run through `EXECUTE … USING p_wallet` so each
--     wallet is planned on its own row estimate (the 20261002152419 technique);
--   * `series_rows` labels DISTINCT (collection_id, series_number) and sums the counts — the
--     same groups as before (min series_number per label, one bar per label);
--   * one `conf` CTE resolves confidence once per distinct (edition_key, collection) —
--     editions(external_id, collection_id) is UNIQUE, so it is the row the LIMIT 1 probe returned —
--     and both `per_coll` and `stale` read it.
--   `wallet` is still p_wallet as given (not lower-cased), as before.
--
-- MEASURED after, whole function (EXPLAIN ANALYZE, BUFFERS, LARGE instance):
--     Rigged  0xf77b…  744,517 → 68,104 buffers (10.9×) · 2,178 → 476 ms
--     founder 0xbd94…  344,100 → 55,306 buffers (6.2×) · 928 → 274 ms
--   The remaining cost is the wallet's own cache rows (34,470 heap pages for Rigged, scattered)
--   and the materialised `w` CTE (temp 12,681 buffers); both are the data, not the shape.
--
-- EQUIVALENCE, on production data in the same snapshot, old body vs new function, key by key
-- (jsonb_each): founder — md5 identical (1bc75588…); Rigged — ZERO differing keys across all 12
-- (totalMoments 43,366 · totalFmv · topMoments · badgeCount 8,186 · seriesBreakdown · seriesBars ·
-- seriesCollection · perCollection · rarest · staleFmv 506.25 · staleCount 25 · wallet).
--
-- UNCHANGED: signature, SECURITY DEFINER, search_path, ACL (anon/authenticated false,
-- service_role true), every output key. No exception handler (R118 guard reads []).
-- Pin re-pointed here in __tests__/db-invariants-drift-guard.test.ts.
--
-- REVERT: re-apply the SQL-language body from
--   supabase/migrations/20260925182927_audit_20260925_share_snapshot_stale_count_pairs_with_stale_fmv.sql
--   (live prosrc md5 471785f179676703ce12f13b74ee6273 before this apply) and point the pin back.
--
-- anon-exec: unchanged (get_wallet_collection_snapshot) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved (anon=false, authenticated=false, service_role=true verified live 2026-10-02), re-asserted below.

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
    SELECT count(DISTINCT be.external_id)::int AS c
    FROM badge_editions be
    WHERE be.external_id IN (SELECT DISTINCT edition_key FROM w WHERE edition_key IS NOT NULL)
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

DO $mig$
DECLARE v jsonb;
BEGIN
  IF has_function_privilege('anon', 'public.get_wallet_collection_snapshot(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.get_wallet_collection_snapshot(text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.get_wallet_collection_snapshot(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'get_wallet_collection_snapshot ACL changed';
  END IF;
  v := public.get_wallet_collection_snapshot('0xbd94cade097e50ac');
  IF v IS NULL OR NOT (v ? 'totalMoments' AND v ? 'totalFmv' AND v ? 'topMoments' AND v ? 'badgeCount' AND v ? 'seriesBreakdown'
                       AND v ? 'seriesBars' AND v ? 'seriesCollection' AND v ? 'perCollection' AND v ? 'rarest' AND v ? 'staleFmv' AND v ? 'staleCount' AND v ? 'wallet') THEN
    RAISE EXCEPTION 'get_wallet_collection_snapshot shape changed: %', left(v::text, 300);
  END IF;
  IF (v->>'totalMoments')::int <= 0 OR jsonb_array_length(v->'seriesBars') <= 0 THEN
    RAISE EXCEPTION 'control wallet read empty — the body lost its rows';
  END IF;
  v := public.get_wallet_collection_snapshot('0x0000000000000001');
  IF (v->>'totalMoments')::int <> 0 OR v->'rarest' <> 'null'::jsonb OR v->'perCollection' <> '[]'::jsonb THEN
    RAISE EXCEPTION 'empty wallet is not zeros/[]/null: %', left(v::text, 300);
  END IF;
END
$mig$;
