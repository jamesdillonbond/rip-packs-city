-- 2026-10-21 ~12:50 PM PT (Claude Code cloud; Trevor: "Do all that makes sense") — #204, the honest half:
-- a Panini set page that mixes several PRODUCTS under one set name now says so, and names them.
--
-- /panini-blockchain/set/base-prizms-blue (2026 Prizm World Cup) listed "LeBron James · #6/49" and a Cam
-- Reddish NBA edition with no disclosure: editions.set_name 'Base Prizms Blue' spans three products — the
-- 2026 World Cup catalog (499 editions), 2022-23 Panini NFT Prizm Basketball (97), 2022 Prizm FIFA World
-- Cup (6). The page's existing "Combined view: N sets share this name" banner keys on
-- underlying_set_count, which tests sets.name against the edition set name; Panini's sets rows are
-- product-scoped ("<product> · <set>"), so it matched one and the banner never fired. Measured 10-21:
-- 386 of 1,979 Panini set names span more than one product.
--
-- CHANGE (Panini only): underlying_set_count counts the distinct `sets` rows the matching editions point
-- at (idx_editions_collection_set_name, ~3 ms on the largest), and a new `underlying_sets` key lists them
-- ({name, editions}, largest first) so the page can name the products. Every other collection keeps the
-- generic count unchanged and returns underlying_sets = null. Splitting the URL per product (the design
-- half of #204) is NOT done here: it changes URLs, the sitemap and set progress.
--
-- Built from the pinned 20261019005911 body (live md5(prosrc) 69d67414… = that file, re-read immediately
-- before applying). Pinned: supabase/tests/get_set_detail.sql (verbatim + 4 assertions; planted defect
-- `IF false` red locally). PINS entry re-pointed here.
--
-- anon-exec: intentional — unchanged; CREATE OR REPLACE with the same signature keeps the existing grants (postgres + service_role only) (get_set_detail)
-- REVERT: re-apply the CREATE OR REPLACE from 20261019005911_audit_20261018_set_detail_underlying_count_needs_editions.sql.
CREATE OR REPLACE FUNCTION public.get_set_detail(p_collection_id uuid, p_set_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
AS $function$
DECLARE
  v_pinnacle_uuid CONSTANT uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_panini_uuid   CONSTANT uuid := 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b';
  v_set       RECORD;
  v_fmv_total numeric;
  v_floor_total numeric;
  v_fmv_ask_derived numeric;
  v_listed_count int;
  v_editions_with_fmv int;
  v_edition_count int;
  v_collection_slug text;
  v_underlying_set_count int;
  v_underlying_sets jsonb;
  v_pin_circulation bigint;
BEGIN
  SELECT * INTO v_set
  FROM sets_summary
  WHERE collection_id = p_collection_id
    AND set_slug = p_set_slug;

  IF v_set IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT slug INTO v_collection_slug FROM collections WHERE id = p_collection_id;

  -- The per-edition latest-FMV rollup is the only expensive read here. On the
  -- largest sets it can exceed the request statement budget cold and would
  -- otherwise error the whole page (Sentry JAVASCRIPT-NEXTJS-22). Catch that
  -- cancellation and degrade the header stats to NULL (rendered "-") instead of
  -- throwing; normal-sized sets finish in a few ms and never trip this.
  BEGIN
    IF p_collection_id = v_pinnacle_uuid THEN
      -- Render-level (per-pin), matching the get_set_editions grid. Joined by
      -- btrim(set_name) to defuse the catalog leading-space quirk.
      -- Total Mint too (2026-09-27): sets_summary's figure for Pinnacle is ONE
      -- set-level legacy key's mint count, not the set's (163 of 178 sets were
      -- understated, median 4.9x). Summed over the same pins the grid lists, and
      -- NULL — never a partial sum — if any pin's mint count is unknown.
      SELECT
        COUNT(*),
        SUM(pc.fmv_usd)                                  FILTER (WHERE pc.fmv_usd > 0),
        SUM(pc.floor_ask)                                FILTER (WHERE pc.floor_ask > 0),
        COUNT(pc.fmv_usd)                                FILTER (WHERE pc.fmv_usd > 0),
        CASE WHEN COUNT(*) > 0 AND COUNT(*) = COUNT(pc.total_minted) THEN SUM(pc.total_minted) END,
        SUM(pc.fmv_usd)                                  FILTER (WHERE pc.fmv_usd > 0 AND pc.fmv_confidence::text = 'ASK_ONLY'),
        COUNT(*)                                         FILTER (WHERE pc.floor_ask > 0)
      INTO v_edition_count, v_fmv_total, v_floor_total, v_editions_with_fmv, v_pin_circulation, v_fmv_ask_derived, v_listed_count
      FROM pinnacle_catalog pc
      WHERE btrim(pc.set_name) = ANY (SELECT btrim(x) FROM unnest(v_set.set_name_variants) x);
    ELSE
      SELECT
        COUNT(*),
        SUM(fmv.fmv_usd)                                          FILTER (WHERE fmv.fmv_usd > 0),
        SUM(COALESCE(fmv.floor_price_usd, fmv.fmv_usd))           FILTER (WHERE COALESCE(fmv.floor_price_usd, fmv.fmv_usd) > 0),
        COUNT(fmv.fmv_usd)                                        FILTER (WHERE fmv.fmv_usd > 0)
      INTO v_edition_count, v_fmv_total, v_floor_total, v_editions_with_fmv
      FROM editions e
      LEFT JOIN LATERAL (
        SELECT fmv_usd, floor_price_usd
        FROM fmv_snapshots
        WHERE edition_id = e.id
        ORDER BY computed_at DESC
        LIMIT 1
      ) fmv ON true
      WHERE e.collection_id = p_collection_id
        AND e.set_name = ANY(v_set.set_name_variants)
        AND e.thumbnail_url IS NOT NULL;
    END IF;
  EXCEPTION WHEN query_canceled THEN
    -- Rollup blew the request statement budget: return the header with NULL stats
    -- (page shows "-") rather than throwing the whole page away.
    v_edition_count := NULL;
    v_fmv_total := NULL;
    v_floor_total := NULL;
    v_editions_with_fmv := NULL;
    v_pin_circulation := NULL;
    v_fmv_ask_derived := NULL;
    v_listed_count := NULL;
  END;

  -- D20: how many underlying `sets` rows merged into this slug. Complete-by-
  -- construction merge signal (name-identical seasonal repeats included, which
  -- set_name_variants misses). Reads the 914-row `sets` table — trivially cheap.
  -- Pinnacle has no `sets` rows → 0 (page keys the banner on > 1).
  IF p_collection_id = v_panini_uuid THEN
    -- 2026-10-21 (#204): Panini's `sets` rows are PRODUCT-scoped ("<product> · <set>"), so the
    -- name test below matches none of them, and a set name several products share (Base Prizms
    -- Blue: the 2026 World Cup catalog 499 editions, 2022-23 Basketball 97, 2022 World Cup 6)
    -- rendered as ONE set with no banner — LeBron James in a World Cup set. Count and NAME the
    -- products from the editions' own set_id (idx_editions_collection_set_name; ~3 ms).
    SELECT count(*), jsonb_agg(jsonb_build_object('name', x.name, 'editions', x.n) ORDER BY x.n DESC, x.name)
      INTO v_underlying_set_count, v_underlying_sets
      FROM (SELECT s.id, s.name::text AS name, count(*) AS n
              FROM editions e
              JOIN sets s ON s.id = e.set_id
             WHERE e.collection_id = p_collection_id
               AND e.set_name = ANY(v_set.set_name_variants)
             GROUP BY s.id, s.name) x;
  ELSE
    SELECT count(*) INTO v_underlying_set_count
    FROM sets s
    WHERE s.collection_id = p_collection_id
      AND s.name::text = ANY(v_set.set_name_variants)
      -- 2026-10-18 (R58 residual): only sets that HAVE editions count. An editionless
      -- stub (`WNBA Skyline` auto_onchain_254) made /wnba-skyline say "Combined view:
      -- 2 sets share this name" over one real set (1 false + 3 overcounted banners,
      -- Top Shot). idx_editions_set makes this one index probe per candidate row.
      AND EXISTS (SELECT 1 FROM editions e WHERE e.set_id = s.id);
  END IF;

  RETURN jsonb_build_object(
    'collection_id',       v_set.collection_id,
    'collection_slug',     v_collection_slug,
    'set_slug',            v_set.set_slug,
    'set_name',            v_set.set_name,
    'set_name_variants',   v_set.set_name_variants,
    'underlying_set_count', v_underlying_set_count,
    'underlying_sets',     v_underlying_sets,
    'edition_count',       v_edition_count,
    'editions_with_fmv',   v_editions_with_fmv,
    'total_circulation',   CASE WHEN p_collection_id = v_pinnacle_uuid THEN v_pin_circulation ELSE v_set.total_circulation END,
    'tiers_present',       v_set.tiers_present,
    'min_series',          v_set.min_series,
    'max_series',          v_set.max_series,
    'first_minted_at',     v_set.first_minted_at,
    'last_updated_at',     v_set.last_updated_at,
    'fmv_total_usd',       v_fmv_total,
    'floor_total_usd',     v_floor_total,
    'fmv_ask_derived_usd', v_fmv_ask_derived,
    'listed_count',        v_listed_count,
    'summary_computed_at', v_set.computed_at
  );
END;
$function$;
